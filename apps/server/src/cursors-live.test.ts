import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";
import {
  serverMessageSchema,
  type ServerMessage,
  type CursorPosition,
} from "@tableloom/core";
import type { CommandContext } from "@tableloom/core/campaigns";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
const KEY = "tableloom-cursor-private-test-host-key";
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, "Cursor update timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const cookieOf = (r: { headers: Record<string, unknown> }) =>
  String(r.headers["set-cookie"]).split(";")[0]!;
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
    cursor: (
      position: CursorPosition,
      context: CommandContext = ws.context!,
      renewOnly = false,
    ) =>
      ws.sendRaw(
        JSON.stringify({
          type: "cursor.update",
          context,
          position,
          ...(renewOnly ? { renewOnly: true } : {}),
        }),
      ),
    latest: () => messages.filter((m) => m.type === "cursors").at(-1),
    snapshot: () => messages.filter((m) => m.type === "snapshot").at(-1)!,
  };
}
test("cursors bind authenticated identity to the active scene, fold tabs, expire and clear on switching/revocation without persistent edits", async () => {
  let now = Date.now();
  const app = await createApp({
      databasePath: ":memory:",
      hostKey: KEY,
      now: () => now,
    }),
    sockets: TestWebSocket[] = [];
  const post = (path: string, payload: object, cookie = "") =>
      app.inject({
        method: "POST",
        url: `/api/${path}`,
        headers: { origin: "http://localhost", cookie },
        payload,
      }),
    open = async (url: string, cookie: string) => {
      const p = await connect(url, cookie);
      sockets.push(p.ws);
      return p;
    };
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      setup = await post("access/setup", { key: KEY, name: "GM" }),
      initial = cookieOf(setup),
      gmId = setup.json().member.id;
    const other = (
        await post(
          "campaigns",
          {
            name: "Other",
            description: "",
            system: { id: "kids-on-bikes", version: "0.1.0" },
            contentPacks: [],
          },
          initial,
        )
      ).json(),
      bCookie = cookieOf(
        await post(`campaigns/${other.id}/select`, {}, initial),
      ),
      gCookie = cookieOf(await post("access/recover", { key: KEY }));
    const joined = await post("access/join", {
        name: "Nora",
        code: (await post("access/invitations", {}, gCookie)).json().token,
      }),
      pCookie = cookieOf(joined),
      pId = joined.json().member.id;
    const foreign = await post("access/join", {
      name: "Foreign",
      code: (await post("access/invitations", {}, bCookie)).json().token,
    });
    const g = await open(url, gCookie),
      p = await open(url, pCookie),
      b = await open(url, cookieOf(foreign)),
      oldContext = g.ws.context!;
    const before = (
      await app.inject({ url: "/api/table", headers: { cookie: gCookie } })
    ).body;
    p.cursor({ x: 80, y: 120 });
    await until(() => g.latest()?.cursors[0]?.position.x === 80);
    assert.deepEqual(g.latest()!.cursors, [
      { memberId: pId, position: { x: 80, y: 120 } },
    ]);
    await until(() => p.latest() !== undefined);
    assert.deepEqual(p.latest()!.cursors, []);
    assert.equal(b.latest(), undefined);
    const second = await open(url, pCookie);
    second.cursor({ x: 90, y: 140 });
    await until(() => g.latest()?.cursors[0]?.position.x === 90);
    p.cursor({ x: 80, y: 120 }, p.ws.context!, true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(g.latest()!.cursors[0]!.position.x, 90);
    p.cursor(null);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(g.latest()!.cursors[0]!.position.x, 90);
    second.ws.terminate();
    await until(() => g.latest()?.cursors.length === 0);
    g.cursor({ x: 240, y: 300 });
    await until(() => p.latest()?.cursors[0]?.memberId === gmId);
    assert.equal(b.latest(), undefined);
    now += 4000;
    await until(() => p.latest()?.cursors.length === 0);
    assert.equal(
      (await app.inject({ url: "/api/table", headers: { cookie: gCookie } }))
        .body,
      before,
    );
    assert.ok(!g.messages.some((m) => m.type === "ack"));
    assert.ok(!p.messages.some((m) => m.type === "ack"));
    p.cursor({ x: 333, y: 444 });
    await until(() => g.latest()?.cursors[0]?.position.x === 333);
    const scene = (
      await post(
        `campaigns/${DEFAULT_CAMPAIGN_ID}/scenes`,
        { name: "Offstage" },
        gCookie,
      )
    ).json();
    await post(
      `campaigns/${DEFAULT_CAMPAIGN_ID}/activate`,
      { sceneId: scene.id, expectedVersion: oldContext.generation },
      gCookie,
    );
    await until(
      () =>
        g.snapshot().context.sceneId === scene.id &&
        g.latest()?.context.sceneId === scene.id,
    );
    assert.deepEqual(g.latest()!.cursors, []);
    const offset = g.messages.length;
    p.cursor({ x: 777, y: 888 }, oldContext);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!JSON.stringify(g.messages.slice(offset)).includes('"x":777'));
    p.cursor({ x: 555, y: 666 });
    await until(() => g.latest()?.cursors[0]?.position.x === 555);
    await post(`access/members/${pId}/remove`, {}, gCookie);
    await until(() => g.latest()?.cursors.length === 0);
    assert.ok(!JSON.stringify(b.messages).includes('"x":555'));
    const forged = await open(url, gCookie),
      closed = once(forged.ws, "close");
    forged.ws.sendRaw(
      JSON.stringify({
        type: "cursor.update",
        context: forged.ws.context,
        position: { x: 0, y: 0 },
        memberId: pId,
      }),
    );
    assert.equal((await closed)[0], 1008);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});
test("cursor floods have independent hard/soft limits and do not consume the persistent command budget", async () => {
  const app = await createApp({ databasePath: ":memory:", hostKey: KEY }),
    sockets: TestWebSocket[] = [];
  const post = (path: string, payload: object, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: { origin: "http://localhost", cookie },
      payload,
    });
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" })),
      joined = await post("access/join", {
        name: "Player",
        code: (await post("access/invitations", {}, gm)).json().token,
      }),
      g = await connect(url, gm),
      p = await connect(url, cookieOf(joined));
    sockets.push(g.ws, p.ws);
    for (let i = 0; i < 121; i++) p.cursor({ x: i, y: 0 });
    const id = crypto.randomUUID();
    p.ws.send(JSON.stringify({ id, type: "dice.roll", expression: "d6" }));
    await until(() =>
      p.messages.some((m) => m.type === "ack" && m.commandId === id),
    );
    assert.ok(g.messages.filter((m) => m.type === "cursors").length <= 2);
    const closed = once(p.ws, "close");
    for (let i = 0; i < 130; i++) p.cursor(null);
    assert.equal((await closed)[0], 1008);
    await until(() => g.latest()?.cursors.length === 0);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
  }
});
