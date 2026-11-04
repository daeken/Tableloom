import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";

const KEY = "tableloom-outbound-live-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Live outbound update timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, cookie: string) {
  const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
    headers: { Cookie: cookie, Origin: url },
  });
  const messages: ServerMessage[] = [],
    raw: string[] = [];
  ws.on("message", (data) => {
    raw.push(data.toString());
    messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
  });
  await once(ws, "open");
  await contextReady(ws);
  return { ws, messages, raw };
}
function holdWrites(socket: WebSocket) {
  const original = socket.send.bind(socket),
    callbacks: ((error?: Error) => void)[] = [];
  socket.send = ((data: string, callback: (error?: Error) => void) => {
    callbacks.push(callback);
    original(data);
  }) as typeof socket.send;
  return {
    callbacks,
    release() {
      socket.send = original;
      for (const callback of callbacks.splice(0)) callback();
    },
  };
}
async function fixture() {
  const app = await createApp({ databasePath: ":memory:", hostKey: KEY });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const post = (route: string, body: Record<string, unknown>, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: { origin: "http://localhost", cookie },
      payload: body,
    });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  const gm = cookieOf(await post("setup", { key: KEY, name: "GM" }));
  const player = cookieOf(
    await post("join", {
      name: "Player",
      code: (await post("invitations", {}, gm)).json().token,
    }),
  );
  return { app, url, gm, player };
}

test("a stalled result writer has a bounded queue and closes without stalling other clients or losing committed state", async () => {
  const { app, url, gm, player } = await fixture();
  const sockets: TestWebSocket[] = [];
  try {
    const healthy = await connect(url, gm);
    sockets.push(healthy.ws);
    const existing = new Set(app.websocketServer.clients);
    const slow = await connect(url, player);
    sockets.push(slow.ws);
    const server = [...app.websocketServer.clients].find(
      (socket) => !existing.has(socket),
    );
    assert.ok(server);
    await until(() =>
      slow.messages.some(
        (message) => message.type === "presence" && message.participants === 2,
      ),
    );
    const held = holdWrites(server);
    const closed = once(slow.ws, "close");
    const first = { id: randomUUID(), type: "dice.roll", expression: "d6" };
    slow.ws.send(JSON.stringify(first));
    await until(() =>
      slow.messages.some(
        (message) => message.type === "ack" && message.commandId === first.id,
      ),
    );
    assert.equal(held.callbacks.length, 1);
    for (let i = 0; i < 64; i++)
      slow.ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: "dice.roll",
          expression: "d6",
        }),
      );
    assert.equal((await closed)[0], 1013);
    await until(() =>
      healthy.messages.some(
        (message) =>
          message.type === "snapshot" && message.state.rolls.length === 65,
      ),
    );
    const table = await app.inject({
      url: "/api/table",
      headers: { cookie: gm },
    });
    assert.equal(table.json().rolls.length, 65);
    assert.equal(held.callbacks.length, 1);
    held.release();
    const next = { id: randomUUID(), type: "dice.roll", expression: "d8" };
    healthy.ws.send(JSON.stringify(next));
    await until(() =>
      healthy.messages.some(
        (message) => message.type === "ack" && message.commandId === next.id,
      ),
    );
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await app.close();
  }
});

test("a delayed snapshot rebuilds the latest per-member view and cannot send a retracted private note", async () => {
  const { app, url, gm, player } = await fixture();
  const sockets: TestWebSocket[] = [];
  try {
    const g = await connect(url, gm);
    sockets.push(g.ws);
    const before = new Set(app.websocketServer.clients);
    const p = await connect(url, player);
    sockets.push(p.ws);
    const server = [...app.websocketServer.clients].find(
      (socket) => !before.has(socket),
    );
    assert.ok(server);
    await until(() =>
      p.messages.some(
        (message) => message.type === "presence" && message.participants === 2,
      ),
    );
    const noteId = randomUUID(),
      create = {
        id: randomUUID(),
        type: "note.add",
        note: {
          id: noteId,
          title: "Retracted queued title",
          body: "Retracted queued body",
          visibility: "gm",
        },
      };
    g.ws.send(JSON.stringify(create));
    await until(() =>
      g.messages.some(
        (message) => message.type === "ack" && message.commandId === create.id,
      ),
    );
    const held = holdWrites(server),
      roll = { id: randomUUID(), type: "dice.roll", expression: "d6" };
    p.ws.send(JSON.stringify(roll));
    await until(() =>
      p.messages.some(
        (message) => message.type === "ack" && message.commandId === roll.id,
      ),
    );
    for (const [expectedVersion, visibility] of [
      [1, "public"],
      [2, "gm"],
    ] as const) {
      const update = {
        id: randomUUID(),
        type: "note.update",
        noteId,
        expectedVersion,
        changes: {
          title: create.note.title,
          body: create.note.body,
          visibility,
        },
      };
      g.ws.send(JSON.stringify(update));
      await until(() =>
        g.messages.some(
          (message) =>
            message.type === "ack" && message.commandId === update.id,
        ),
      );
    }
    held.release();
    await until(() =>
      p.messages.some(
        (message) =>
          message.type === "snapshot" && message.state.rolls.length === 1,
      ),
    );
    for (const secret of [noteId, create.note.title, create.note.body])
      assert.ok(!p.raw.join("").includes(secret));
    assert.equal(held.callbacks.length, 0);
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await app.close();
  }
});
