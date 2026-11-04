import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { TestWebSocket as WebSocket, contextReady } from "./test-client.js";
import { createApp } from "./app.js";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
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
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  await once(ws, "open");
  await contextReady(ws);
  return { ws, messages };
}

async function waitForRoll(messages: ServerMessage[]) {
  const deadline = Date.now() + 3000;
  while (
    !messages.some(
      (message) =>
        message.type === "snapshot" && message.state.rolls.length === 1,
    )
  ) {
    if (Date.now() > deadline) throw new Error("No roll snapshot arrived");
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
        (m) => m.type === "snapshot" && m.state.rolls.length === 1,
      ),
    );
    host.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "dice.roll",
        expression: "d6",
      }),
    );
    await waitForRoll(host.messages);
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
    assert.equal(table.json().rolls.length, 0);
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
    await waitForRoll(host.messages);
    assert.ok(
      joined.messages.every(
        (message) =>
          message.type !== "snapshot" || message.state.rolls.length === 0,
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

test("GM member management restores ownership/private notes, revokes codes, and disconnects replaced or removed sessions", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { membersSchema, invitationsSchema } =
    await import("@tableloom/core/access");
  const { tableViewSchema } = await import("@tableloom/core");
  const directory = mkdtempSync(join(tmpdir(), "tableloom-members-api-"));
  const databasePath = join(directory, "table.sqlite");
  let app = await makeApp({ databasePath });
  const sockets: WebSocket[] = [];
  const read = (route: string, cookie = "") =>
    app.inject({ url: `/api/${route}`, headers: { cookie } });
  async function until(check: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline)
        throw new Error("No expected member snapshot arrived");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = await setup(app);
    const gmId = accessStatusSchema.parse((await read("access", gm)).json())
      .member!.id;
    const original = await player(app, gm);
    const other = await player(app, gm);
    const originalMember = accessStatusSchema.parse(
      (await read("access", original.cookie)).json(),
    ).member!;
    const before = await socket(url, original.cookie);
    sockets.push(before.ws);
    const tokenId = crypto.randomUUID();
    const noteId = crypto.randomUUID();
    before.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "token.add",
        token: {
          id: tokenId,
          name: "Robin's marker",
          position: { x: 0, y: 0 },
          color: "#456789",
        },
      }),
    );
    before.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "note.add",
        note: {
          id: noteId,
          title: "Recovered private note",
          body: "Only the original owner",
          visibility: "gm",
        },
      }),
    );
    before.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "dice.roll",
        expression: "d17",
        visibility: "gm",
      }),
    );
    await until(() =>
      before.messages.some(
        (m) =>
          m.type === "snapshot" &&
          m.state.notes.length === 1 &&
          m.state.rolls.length === 1,
      ),
    );
    for (const cookie of ["", original.cookie]) {
      for (const route of ["access/members", "access/invitations"]) {
        assert.equal(
          (await read(route, cookie)).statusCode,
          cookie ? 403 : 401,
        );
      }
      assert.equal(
        (await post(app, `members/${originalMember.id}/recovery`, {}, cookie))
          .statusCode,
        cookie ? 403 : 401,
      );
      assert.equal(
        (await post(app, `members/${originalMember.id}/remove`, {}, cookie))
          .statusCode,
        cookie ? 403 : 401,
      );
    }
    assert.equal(
      (await post(app, `members/${gmId}/remove`, {}, gm)).statusCode,
      403,
    );
    assert.equal(
      (await post(app, `members/${gmId}/recovery`, {}, gm)).statusCode,
      400,
    );
    const recoveryResponse = await post(
      app,
      `members/${originalMember.id}/recovery`,
      {},
      gm,
    );
    assert.equal(recoveryResponse.statusCode, 200);
    const recovery = invitationSchema.parse(recoveryResponse.json());
    const listedResponse = await read("access/invitations", gm);
    assert.equal(listedResponse.headers["cache-control"], "no-store");
    const listed = invitationsSchema.parse(listedResponse.json());
    assert.equal(listed[0]?.memberId, originalMember.id);
    assert.ok(!listedResponse.body.includes(recovery.token));
    assert.ok(!listedResponse.body.includes("token_hash"));
    assert.equal(
      (
        await post(
          app,
          `invitations/${recovery.id}/revoke`,
          {},
          original.cookie,
        )
      ).statusCode,
      403,
    );
    const closed = once(before.ws, "close");
    const restored = await post(app, "join", {
      name: "Cannot rename or become GM",
      code: recovery.token,
    });
    assert.equal(restored.statusCode, 200);
    assert.deepEqual(
      accessStatusSchema.parse(restored.json()).member,
      originalMember,
    );
    const returnedCookie = getCookie(restored);
    assert.equal((await closed)[0], 4001);
    assert.equal((await read("table", original.cookie)).statusCode, 401);
    assert.equal(
      (await post(app, "join", { name: "Replay", code: recovery.token }))
        .statusCode,
      400,
    );
    assert.equal(
      membersSchema.parse((await read("access/members", gm)).json()).length,
      3,
    );
    const returned = await socket(url, returnedCookie);
    sockets.push(returned.ws);
    await until(() =>
      returned.messages.some(
        (m) =>
          m.type === "snapshot" &&
          m.state.notes[0]?.id === noteId &&
          m.state.rolls[0]?.ownerId === originalMember.id,
      ),
    );
    assert.equal(
      tableViewSchema.parse((await read("table", other.cookie)).json()).notes
        .length,
      0,
    );
    assert.equal(
      tableViewSchema.parse((await read("table", other.cookie)).json()).rolls
        .length,
      0,
    );
    returned.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "token.move",
        tokenId,
        position: { x: 10, y: 20 },
      }),
    );
    await until(() =>
      returned.messages.some(
        (m) => m.type === "snapshot" && m.state.tokens[0]?.position.x === 10,
      ),
    );
    const unused = invitationSchema.parse(
      (await post(app, "invitations", {}, gm)).json(),
    );
    assert.equal(
      (await post(app, `invitations/${unused.id}/revoke`, {}, gm)).statusCode,
      200,
    );
    assert.equal(
      (await post(app, "join", { name: "Too late", code: unused.token }))
        .statusCode,
      400,
    );
    const pending = invitationSchema.parse(
      (await post(app, `members/${originalMember.id}/recovery`, {}, gm)).json(),
    );
    const removed = once(returned.ws, "close");
    assert.equal(
      (await post(app, `members/${originalMember.id}/remove`, {}, gm))
        .statusCode,
      200,
    );
    assert.equal((await removed)[0], 4001);
    assert.equal((await read("table", returnedCookie)).statusCode, 401);
    assert.equal(
      (await post(app, "join", { name: "Removed", code: pending.token }))
        .statusCode,
      400,
    );
    assert.equal(
      membersSchema.parse((await read("access/members", gm)).json()).length,
      2,
    );
    await app.close();
    app = await makeApp({ databasePath });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gmView = tableViewSchema.parse((await read("table", gm)).json());
    assert.equal(gmView.notes[0]?.ownerId, originalMember.id);
    assert.equal(gmView.rolls[0]?.ownerId, originalMember.id);
    assert.equal(gmView.tokens[0]?.position.x, 10);
    const fresh = await player(app, gm);
    const freshView = tableViewSchema.parse(
      (await read("table", fresh.cookie)).json(),
    );
    assert.equal(freshView.notes.length, 0);
    assert.equal(freshView.rolls.length, 0);
    const freshId = accessStatusSchema.parse(
      (await read("access", fresh.cookie)).json(),
    ).member!.id;
    assert.notEqual(freshId, originalMember.id);
    assert.equal(freshView.tokens[0]?.ownerId, originalMember.id);
    assert.equal(
      invitationsSchema.parse((await read("access/invitations", gm)).json())
        .length,
      0,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP/live endpoints bind campaign context and recheck rotated sessions before broadcasting", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AccessStore } = await import("./access.js");
  const { TableStore } = await import("./store.js");
  const { applyCommand } = await import("@tableloom/core/server");
  const { DEFAULT_CAMPAIGN_ID } = await import("@tableloom/core/campaigns");
  const directory = mkdtempSync(join(tmpdir(), "tableloom-scoped-wire-"));
  const databasePath = join(directory, "table.sqlite");
  let app = await makeApp({ databasePath });
  const access = new AccessStore(databasePath, KEY),
    store = new TableStore(databasePath);
  const sockets: WebSocket[] = [];
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const originalHost = await setup(app);
    const other = store.createCampaign({
      name: "Other campaign",
      description: "",
      system: { id: "kids-on-bikes", version: "0.1.0" },
      contentPacks: [],
    });
    access.registerCampaign(sessionToken(originalHost), other.id);
    const otherHost = access.selectCampaign(
      sessionToken(originalHost),
      other.id,
    );
    const gmCookie = getCookie(await post(app, "recover", { key: KEY }));
    const original = await player(app, gmCookie);
    const otherInvitation = access.createInvitation(otherHost.token);
    const otherPlayer = access.redeemInvitation(
      otherInvitation.token,
      "Ignored",
      { sessionToken: sessionToken(original.cookie) },
    );
    const commandId = crypto.randomUUID();
    store.save(
      applyCommand(
        store.load(other.id),
        {
          id: commandId,
          type: "note.add",
          note: {
            id: crypto.randomUUID(),
            title: "Other campaign public clue",
            body: "Must stay in other campaign",
            visibility: "public",
          },
        },
        otherPlayer.member,
      ),
      commandId,
      other.id,
    );
    const gm = await socket(url, gmCookie),
      joined = await socket(url, original.cookie);
    sockets.push(gm.ws, joined.ws);
    const noteId = crypto.randomUUID();
    joined.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "note.add",
        note: {
          id: noteId,
          title: "Default private note",
          body: "Must stay in default campaign",
          visibility: "gm",
        },
      }),
    );
    const deadline = Date.now() + 3000;
    while (
      ![gm, joined].every((client) =>
        client.messages.some(
          (m) =>
            m.type === "snapshot" &&
            m.state.notes.some((note) => note.id === noteId),
        ),
      )
    ) {
      if (Date.now() > deadline) throw new Error("No default note snapshot");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const otherCookie = `tableloom_session=${otherPlayer.token}`;
    for (const [route, status] of [
      ["/api/table", 200],
      [`/api/table?campaignId=${DEFAULT_CAMPAIGN_ID}`, 409],
    ] as const) {
      const denied = await app.inject({
        url: route,
        headers: { cookie: otherCookie },
      });
      assert.equal(denied.statusCode, status);
      assert.ok(!denied.body.includes("Must stay in default campaign"));
      assert.ok(!denied.body.includes(noteId));
    }
    assert.equal(
      (
        await app.inject({
          url: `/api/live?campaignId=${DEFAULT_CAMPAIGN_ID}`,
          headers: { origin: "http://localhost", cookie: otherCookie },
        })
      ).statusCode,
      409,
    );
    const current = await app.inject({
      url: `/api/table?campaignId=${other.id}`,
      headers: { cookie: original.cookie },
    });
    assert.equal(current.statusCode, 409);
    assert.ok(!current.body.includes("Must stay in default campaign"));
    assert.ok(!current.body.includes("Must stay in other campaign"));
    assert.ok(
      !JSON.stringify(joined.messages).includes("Other campaign public clue"),
    );
    const invitation = invitationSchema.parse(
      (await post(app, "invitations", { tableId: other.id }, gmCookie)).json(),
    );
    assert.equal(invitation.tableId, DEFAULT_CAMPAIGN_ID);
    const restricted = access.createInvitation(otherHost.token);
    assert.equal(
      (
        await post(app, "join", {
          name: "Another room player",
          code: restricted.token,
        })
      ).statusCode,
      200,
    );
    assert.ok(
      !access
        .listInvitations(otherHost.token)
        .some((item) => item.id === restricted.id),
    );
    const snapshotCount = joined.messages.filter(
      (m) => m.type === "snapshot",
    ).length;
    const closed = once(joined.ws, "close");
    const switched = access.selectCampaign(
      sessionToken(original.cookie),
      other.id,
    );
    assert.equal(access.authenticate(switched.token)?.tableId, other.id);
    gm.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "dice.roll",
        expression: "d6",
      }),
    );
    assert.equal((await closed)[0], 4001);
    await waitForRoll(gm.messages);
    assert.equal(
      joined.messages.filter((m) => m.type === "snapshot").length,
      snapshotCount,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/table",
          headers: { cookie: original.cookie },
        })
      ).statusCode,
      401,
    );
    await app.close();
    app = await makeApp({ databasePath });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    assert.equal(access.authenticate(switched.token)?.tableId, other.id);
    assert.equal(
      (
        await app.inject({
          url: "/api/table",
          headers: { cookie: `tableloom_session=${switched.token}` },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/table", headers: { cookie: gmCookie } }))
        .statusCode,
      200,
    );
    assert.equal(
      store.load(other.id).notes[0]?.body,
      "Must stay in other campaign",
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    access.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
