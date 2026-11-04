import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "./app.js";
import { sessionToken } from "./access-http.js";
import { accessStatusSchema, invitationSchema } from "@tableloom/core/access";

const KEY = "tableloom-access-api-fixture-not-a-real-server-key";
type App = Awaited<ReturnType<typeof createApp>>;
const makeApp = (options: Partial<Parameters<typeof createApp>[0]> = {}) =>
  createApp({ databasePath: ":memory:", hostKey: KEY, ...options });
const post = (
  app: App,
  route: string,
  body: unknown,
  cookie = "",
  origin = "http://localhost",
) =>
  app.inject({
    method: "POST",
    url: `/api/access/${route}`,
    headers: { origin, cookie, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
const getCookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";")[0]!;
async function setup(app: App) {
  const result = await post(app, "setup", { key: KEY, name: "Host" });
  assert.equal(result.statusCode, 200);
  return getCookie(result);
}
async function player(app: App, host: string) {
  const invitation = await post(app, "invitations", {}, host);
  const code = invitationSchema.parse(invitation.json()).token;
  const joined = await post(app, "join", { name: "Player", code, role: "gm" });
  assert.equal(joined.statusCode, 200);
  assert.equal(accessStatusSchema.parse(joined.json()).member?.role, "player");
  return { cookie: getCookie(joined), code };
}
async function socket(url: string, cookie: string) {
  const ws = new WebSocket(`${url.replace("http", "ws")}/api/live?name=Fake`, {
    headers: { Origin: url, Cookie: cookie },
  });
  const messages: { type: string; state?: { revision: number } }[] = [];
  ws.on("message", (raw) =>
    messages.push(JSON.parse(raw.toString()) as (typeof messages)[number]),
  );
  await once(ws, "open");
  return { ws, messages };
}

async function waitForRevision(
  messages: { type: string; state?: { revision: number } }[],
  revision: number,
) {
  const deadline = Date.now() + 3000;
  while (
    !messages.some(
      (message) =>
        message.type === "snapshot" && message.state?.revision === revision,
    )
  ) {
    if (Date.now() > deadline)
      throw new Error(`No table snapshot at revision ${revision}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("setup, invitations, browser sessions, recovery, and logout guard table access", async () => {
  const app = await makeApp();
  try {
    const initial = await app.inject("/api/access");
    assert.deepEqual(accessStatusSchema.parse(initial.json()), {
      setupRequired: true,
      member: null,
    });
    assert.equal(initial.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/api/table")).statusCode, 401);
    assert.equal(
      (await post(app, "setup", { key: "wrong".repeat(10), name: "Host" }))
        .statusCode,
      401,
    );
    const result = await post(app, "setup", { key: KEY, name: "Host" });
    const host = getCookie(result);
    const header = String(result.headers["set-cookie"]);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    assert.match(header, /Path=\//);
    assert.doesNotMatch(header, /Domain=/);
    assert.ok(!JSON.stringify(result.json()).includes(sessionToken(host)));
    assert.equal(
      (await app.inject({ url: "/api/table", headers: { cookie: host } }))
        .statusCode,
      200,
    );
    assert.equal(
      (await post(app, "setup", { key: KEY, name: "Second" })).statusCode,
      409,
    );
    const guest = await player(app, host);
    assert.equal(
      (await post(app, "join", { name: "Again", code: guest.code })).statusCode,
      400,
    );
    assert.equal(
      (await post(app, "invitations", {}, guest.cookie)).statusCode,
      403,
    );
    assert.equal((await post(app, "invitations", {})).statusCode, 401);
    assert.equal((await post(app, "logout", {}, host)).statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/table", headers: { cookie: host } }))
        .statusCode,
      401,
    );
    const recovered = await post(app, "recover", { key: KEY });
    assert.equal(recovered.json().member.id, result.json().member.id);
    assert.notEqual(getCookie(recovered), host);
    assert.equal(
      (
        await app.inject({
          url: "/api/table",
          headers: { cookie: getCookie(recovered) },
        })
      ).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});

test("unsafe requests and WebSocket handshakes reject foreign, missing, and malformed origins", async () => {
  const app = await makeApp();
  try {
    assert.equal(
      (
        await post(
          app,
          "setup",
          { key: KEY, name: "Host" },
          "",
          "https://elsewhere.example",
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/access/setup",
          payload: { key: KEY, name: "Host" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await post(app, "setup", { key: KEY, name: "Host" }, "", "null"))
        .statusCode,
      403,
    );
    assert.equal((await app.inject("/api/access")).json().setupRequired, true);
    const host = await setup(app);
    for (const origin of [
      "https://elsewhere.example",
      "http://localhost/path",
      "null",
    ]) {
      assert.equal(
        (
          await app.inject({
            url: "/api/live",
            headers: { origin, cookie: host },
          })
        ).statusCode,
        403,
      );
    }
    assert.equal(
      (
        await app.inject({
          url: "/api/live",
          headers: { origin: "http://localhost" },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/table",
          headers: { cookie: `${host}; ${host}` },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});

test("explicit public HTTPS origin enables Secure cookies without trusting forwarded headers", async () => {
  const app = await makeApp({ publicOrigin: "https://table.example" });
  try {
    const result = await post(
      app,
      "setup",
      { key: KEY, name: "Host" },
      "",
      "https://table.example",
    );
    assert.equal(result.statusCode, 200);
    assert.match(String(result.headers["set-cookie"]), /; Secure/);
    assert.equal(
      (await post(app, "logout", {}, getCookie(result))).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});

test("live sockets lose access on logout and cannot receive later broadcasts", async () => {
  const app = await makeApp();
  const sockets: WebSocket[] = [];
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const hostCookie = await setup(app);
    const guest = await player(app, hostCookie);
    const host = await socket(url, hostCookie);
    sockets.push(host.ws);
    const joined = await socket(url, guest.cookie);
    sockets.push(joined.ws);
    const closed = once(joined.ws, "close");
    assert.equal((await post(app, "logout", {}, guest.cookie)).statusCode, 200);
    const [code] = await closed;
    assert.equal(code, 4001);
    assert.ok(
      !joined.messages.some(
        (m) => m.type === "snapshot" && m.state?.revision === 1,
      ),
    );
    host.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "dice.roll",
        expression: "d6",
      }),
    );
    await waitForRevision(host.messages, 1);
    assert.equal(
      (
        await app.inject({ url: "/api/table", headers: { cookie: hostCookie } })
      ).json().rolls[0].actor,
      "Host",
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/table",
          headers: { cookie: guest.cookie },
        })
      ).statusCode,
      401,
    );
    await assert.rejects(async () => {
      const rejected = new WebSocket(`${url.replace("http", "ws")}/api/live`, {
        headers: { Origin: url, Cookie: guest.cookie },
      });
      await once(rejected, "open");
    }, /401/);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});

test("expired live sessions are rejected before accepting a mutation", async () => {
  let now = Date.now();
  const app = await makeApp({ now: () => now });
  let ws: WebSocket | undefined;
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const cookie = await setup(app);
    ws = (await socket(url, cookie)).ws;
    now += 8 * 86400000;
    const closed = once(ws, "close");
    ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "dice.roll",
        expression: "d6",
      }),
    );
    assert.equal((await closed)[0], 4001);
    const recovered = getCookie(await post(app, "recover", { key: KEY }));
    const table = await app.inject({
      url: "/api/table",
      headers: { cookie: recovered },
    });
    assert.equal(table.json().revision, 0);
  } finally {
    ws?.terminate();
    await app.close();
  }
});

test("expired idle sockets receive no new snapshot when a valid member broadcasts", async () => {
  let now = Date.now();
  const app = await makeApp({ now: () => now });
  const sockets: WebSocket[] = [];
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const hostCookie = await setup(app);
    const guest = await player(app, hostCookie);
    const joined = await socket(url, guest.cookie);
    sockets.push(joined.ws);
    const closed = once(joined.ws, "close");
    now += 8 * 86400000;
    const recovered = getCookie(await post(app, "recover", { key: KEY }));
    const host = await socket(url, recovered);
    sockets.push(host.ws);
    assert.equal((await closed)[0], 4001);
    host.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "dice.roll",
        expression: "d6",
      }),
    );
    await waitForRevision(host.messages, 1);
    assert.ok(
      joined.messages.every(
        (message) =>
          message.type !== "snapshot" || message.state?.revision === 0,
      ),
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});

test("sign-in attempts are bounded per IP and recover after the window", async () => {
  let now = Date.now();
  const app = await makeApp({ now: () => now });
  try {
    for (let i = 0; i < 20; i++)
      assert.equal(
        (await post(app, "setup", { key: "wrong".repeat(10), name: "Host" }))
          .statusCode,
        401,
      );
    const limited = await post(app, "setup", { key: KEY, name: "Host" });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers["retry-after"], "300");
    now += 300000;
    assert.equal(
      (await post(app, "setup", { key: KEY, name: "Host" })).statusCode,
      200,
    );
  } finally {
    await app.close();
  }
});
