import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";
import { serverMessageSchema, type ServerMessage } from "@tableloom/core";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
const KEY = "tableloom-presence-private-test-host-key";
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, "Presence timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const cookieOf = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";")[0]!;
async function connect(url: string, cookie: string) {
  const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
      headers: { Cookie: cookie, Origin: url },
    }),
    messages: ServerMessage[] = [];
  ws.on("message", (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  await once(ws, "open");
  await contextReady(ws);
  return {
    ws,
    messages,
    latest: () =>
      messages
        .filter(
          (message) =>
            message.type === "snapshot" || message.type === "presence",
        )
        .at(-1)!,
  };
}
test("named presence counts people/tabs separately and excludes offline/foreign identities across disconnect, recovery, removal and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tableloom-presence-")),
    options = { databasePath: join(dir, "table.sqlite"), hostKey: KEY };
  let app = await createApp(options);
  const sockets: TestWebSocket[] = [];
  const post = (path: string, payload: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: { origin: "http://localhost", cookie },
      payload: payload as object,
    });
  const open = async (url: string, cookie: string) => {
    const peer = await connect(url, cookie);
    sockets.push(peer.ws);
    return peer;
  };
  const joinPlayer = async (cookie: string, name: string) => {
    const response = await post("access/join", {
      name,
      code: (await post("access/invitations", {}, cookie)).json().token,
    });
    return { cookie: cookieOf(response), member: response.json().member };
  };
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const setup = await post("access/setup", { key: KEY, name: "GM" }),
      original = cookieOf(setup),
      gmId = setup.json().member.id;
    const campaign = (
      await post(
        "campaigns",
        {
          name: "Other",
          description: "",
          system: { id: "kids-on-brooms", version: "0.1.0" },
          contentPacks: [],
        },
        original,
      )
    ).json();
    const gmB = cookieOf(
        await post(`campaigns/${campaign.id}/select`, {}, original),
      ),
      gmA = cookieOf(await post("access/recover", { key: KEY }));
    const nora = await joinPlayer(gmA, "Nora"),
      offline = await joinPlayer(gmA, "Unconnected secret"),
      foreign = await joinPlayer(gmB, "Foreign secret");
    let g = await open(url, gmA);
    const g2 = await open(url, gmA),
      p = await open(url, nora.cookie),
      p2 = await open(url, nora.cookie);
    await until(() => g.latest().participants === 4);
    assert.equal(g.latest().onlineMembers.length, 2);
    assert.deepEqual(
      new Set(g.latest().onlineMembers.map((member) => member.id)),
      new Set([gmId, nora.member.id]),
    );
    const aCount = g.messages.length;
    const b = await open(url, gmB),
      f = await open(url, foreign.cookie);
    await until(() => b.latest().participants === 2);
    assert.equal(g.messages.length, aCount);
    assert.ok(!JSON.stringify(g.messages).includes(foreign.member.id));
    assert.ok(!JSON.stringify(g.messages).includes(offline.member.id));
    assert.ok(!JSON.stringify(b.messages).includes(nora.member.id));
    for (const peer of [g, p, b, f])
      for (const message of peer.messages)
        if (message.type === "presence" || message.type === "snapshot")
          for (const member of message.onlineMembers)
            assert.deepEqual(Object.keys(member).sort(), [
              "id",
              "name",
              "role",
            ]);
    await until(() => p.latest().participants === 4);
    const before = (
        await app.inject({
          url: "/api/table",
          headers: { cookie: nora.cookie },
        })
      ).body,
      pBefore = p.messages.length;
    g.ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "dice.roll",
        expression: "d6",
        visibility: "gm",
      }),
    );
    await until(() =>
      g.messages.some(
        (message) =>
          message.type === "snapshot" && message.state.rolls.length === 1,
      ),
    );
    assert.equal(p.messages.length, pBefore);
    assert.equal(
      (
        await app.inject({
          url: "/api/table",
          headers: { cookie: nora.cookie },
        })
      ).body,
      before,
    );
    p2.ws.terminate();
    await until(() => g.latest().participants === 3);
    assert.equal(g.latest().onlineMembers.length, 2);
    p.ws.terminate();
    await until(() => g.latest().participants === 2);
    assert.equal(g.latest().onlineMembers.length, 1);
    const returned = await open(url, nora.cookie);
    await until(() => g.latest().participants === 3);
    assert.equal(g.latest().onlineMembers.length, 2);
    returned.ws.sendRaw(
      JSON.stringify({
        type: "presence",
        campaignId: DEFAULT_CAMPAIGN_ID,
        participants: 999,
        onlineMembers: [
          { id: foreign.member.id, name: "Forged GM", role: "gm" },
        ],
      }),
    );
    await until(() =>
      returned.messages.some((message) => message.type === "error"),
    );
    assert.equal(g.latest().participants, 3);
    assert.ok(!JSON.stringify(g.messages).includes("Forged GM"));
    const recovery = (
      await post(`access/members/${nora.member.id}/recovery`, {}, gmA)
    ).json();
    const recovered = await post("access/join", {
        name: "Ignored replacement",
        code: recovery.token,
      }),
      recoveredCookie = cookieOf(recovered);
    await until(() => g.latest().onlineMembers.length === 1);
    const again = await open(url, recoveredCookie);
    await until(() => g.latest().onlineMembers.length === 2);
    assert.equal(
      g.latest().onlineMembers.find((member) => member.id === nora.member.id)!
        .name,
      "Nora",
    );
    assert.equal(
      (await post(`access/members/${nora.member.id}/remove`, {}, gmA))
        .statusCode,
      200,
    );
    await until(() => g.latest().onlineMembers.length === 1);
    await until(() => again.ws.readyState !== 1);
    g2.ws.terminate();
    await until(() => g.latest().participants === 1);
    for (const ws of sockets) ws.terminate();
    await app.close();
    app = await createApp(options);
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    g = await open(url, gmA);
    assert.equal(g.latest().participants, 1);
    assert.deepEqual(g.latest().onlineMembers, [
      { id: gmId, name: "GM", role: "gm" },
    ]);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("presence is lazily reauthenticated after session expiry and old-campaign sockets do not follow credential selection", async () => {
  let now = Date.now();
  const app = await createApp({
      databasePath: ":memory:",
      hostKey: KEY,
      now: () => now,
    }),
    sockets: TestWebSocket[] = [];
  const post = (path: string, payload: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: { origin: "http://localhost", cookie },
      payload: payload as object,
    });
  const open = async (url: string, cookie: string) => {
    const p = await connect(url, cookie);
    sockets.push(p.ws);
    return p;
  };
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      setup = await post("access/setup", { key: KEY, name: "GM" }),
      gm = cookieOf(setup),
      gmId = setup.json().member.id;
    const player = cookieOf(
      await post("access/join", {
        name: "Expires",
        code: (await post("access/invitations", {}, gm)).json().token,
      }),
    );
    const g = await open(url, gm);
    await open(url, player);
    await until(() => g.latest().participants === 2);
    now += 8 * 24 * 60 * 60 * 1000;
    const freshCookie = cookieOf(await post("access/recover", { key: KEY })),
      fresh = await open(url, freshCookie);
    assert.deepEqual(fresh.latest().onlineMembers, [
      { id: gmId, name: "GM", role: "gm" },
    ]);
    assert.equal(fresh.latest().participants, 1);
    const other = (
      await post(
        "campaigns",
        {
          name: "Other",
          description: "",
          system: { id: "kids-on-bikes", version: "0.1.0" },
          contentPacks: [],
        },
        freshCookie,
      )
    ).json();
    const switched = cookieOf(
      await post(`campaigns/${other.id}/select`, {}, freshCookie),
    );
    const next = await open(url, switched);
    assert.equal(next.latest().participants, 1);
    assert.ok(
      next.messages
        .filter((m) => m.type === "presence")
        .every((m) => m.campaignId === other.id),
    );
    await until(() => fresh.ws.readyState !== 1);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});

test("a slow writer coalesces roster churn and computes only currently authenticated identities when draining", async () => {
  const app = await createApp({ databasePath: ":memory:", hostKey: KEY }),
    sockets: TestWebSocket[] = [];
  const post = (path: string, payload: object, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: { origin: "http://localhost", cookie },
      payload,
    });
  const open = async (url: string, cookie: string) => {
    const p = await connect(url, cookie);
    sockets.push(p.ws);
    return p;
  };
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" }));
    const g = await open(url, gm),
      server = [...app.websocketServer.clients][0]!;
    const original = server.send.bind(server),
      callbacks: ((error?: Error) => void)[] = [];
    server.send = ((data: string, callback: (error?: Error) => void) => {
      callbacks.push(callback);
      original(data);
    }) as typeof server.send;
    const commandId = crypto.randomUUID();
    g.ws.send(
      JSON.stringify({ id: commandId, type: "dice.roll", expression: "d6" }),
    );
    await until(() =>
      g.messages.some((m) => m.type === "ack" && m.commandId === commandId),
    );
    assert.equal(callbacks.length, 1);
    const offset = g.messages.length;
    const joined = await post("access/join", {
        name: "Transient roster secret",
        code: (await post("access/invitations", {}, gm)).json().token,
      }),
      cookie = cookieOf(joined),
      id = joined.json().member.id;
    const p = await open(url, cookie);
    assert.equal(
      (await post(`access/members/${id}/remove`, {}, gm)).statusCode,
      200,
    );
    await until(() => p.ws.readyState !== 1);
    const duplicate = await open(url, gm);
    assert.equal(duplicate.latest().participants, 2);
    server.send = original;
    for (const callback of callbacks.splice(0)) callback();
    await until(() => g.latest().participants === 2);
    assert.equal(g.latest().onlineMembers.length, 1);
    assert.ok(!JSON.stringify(g.messages.slice(offset)).includes(id));
    assert.ok(
      !JSON.stringify(g.messages.slice(offset)).includes(
        "Transient roster secret",
      ),
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});
