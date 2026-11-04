import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";
import { TestWebSocket, contextReady } from "./test-client.js";
const KEY = "tableloom-live-history-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, "History result timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
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
  const latest = () => messages.filter((m) => m.type === "snapshot").at(-1)!;
  const send = async (command: Record<string, unknown>) => {
    const id = String(command.id),
      start = messages.length;
    ws.send(JSON.stringify(command));
    const result = () =>
      messages
        .slice(start)
        .find(
          (m) => (m.type === "ack" || m.type === "error") && m.commandId === id,
        );
    await until(() => Boolean(result()));
    return result()!;
  };
  return { ws, messages, latest, send };
}

test("live move history is requester-scoped, confirmed atomically, conflict-safe, retryable and persistent after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-live-history-")),
    path = join(directory, "table.sqlite");
  let app = await createApp({ databasePath: path, hostKey: KEY });
  const db = new DatabaseSync(path),
    store = new TableStore(db),
    sockets: TestWebSocket[] = [];
  const post = (route: string, body: Record<string, unknown>, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: { origin: "http://localhost", cookie },
      payload: body,
    });
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers["set-cookie"]).split(";")[0]!;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("setup", { key: KEY, name: "GM" }));
    const player = cookieOf(
      await post("join", {
        name: "Player",
        code: (await post("invitations", {}, gm)).json().token,
      }),
    );
    let p = await connect(url, player);
    const g = await connect(url, gm);
    sockets.push(p.ws, g.ws);
    const tokenId = randomUUID();
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "token.add",
          token: {
            id: tokenId,
            name: "Scout",
            position: { x: 0, y: 0 },
            color: "#405f4d",
          },
        })
      ).type,
      "ack",
    );
    const move = {
      id: randomUUID(),
      type: "token.move",
      tokenId,
      expectedVersion: 1,
      position: { x: 100, y: 200 },
    };
    assert.equal((await p.send(move)).type, "ack");
    await until(() => Boolean(p.latest().history.undo));
    const cursor = p.latest().history.undo!;
    assert.equal(cursor.available, true);
    assert.equal(g.latest().history.undo, null);
    assert.ok(!JSON.stringify(g.messages).includes(cursor.id));
    assert.ok(!("from" in cursor));
    assert.ok(!("to" in cursor));
    const stolen = {
      id: randomUUID(),
      type: "scene.undo",
      historyId: cursor.id,
      expectedVersion: cursor.version,
    };
    assert.equal((await g.send(stolen)).type, "error");
    assert.equal(store.hasCommand(stolen.id), false);
    db.exec(
      "CREATE TRIGGER reject_history_binding BEFORE INSERT ON command_bindings BEGIN SELECT RAISE(ABORT,'fixture history failure'); END;",
    );
    const before = store.load();
    assert.equal((await p.send(stolen)).type, "error");
    assert.deepEqual(store.load(), before);
    assert.equal(
      db
        .prepare("SELECT state,version FROM scene_move_history WHERE id=?")
        .get(cursor.id)!.state,
      "done",
    );
    assert.equal(store.hasCommand(stolen.id), false);
    db.exec("DROP TRIGGER reject_history_binding");
    const undo = { ...stolen, id: randomUUID() };
    assert.equal((await p.send(undo)).type, "ack");
    await until(() => p.latest().state.tokens[0]?.version === 3);
    assert.deepEqual(store.load().tokens[0]!.position, { x: 0, y: 0 });
    assert.equal((await p.send(undo)).type, "ack");
    assert.equal(store.load().tokens[0]!.version, 3);
    assert.equal((await p.send({ ...undo, id: randomUUID() })).type, "error");
    const redoCursor = p.latest().history.redo!;
    sockets.forEach((s) => s.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    p = await connect(url, player);
    const gmPeer = await connect(url, gm);
    sockets.push(p.ws, gmPeer.ws);
    assert.deepEqual(p.latest().history.redo, redoCursor);
    const redo = {
      id: randomUUID(),
      type: "scene.redo",
      historyId: redoCursor.id,
      expectedVersion: redoCursor.version,
    };
    assert.equal((await p.send(redo)).type, "ack");
    await until(() => p.latest().state.tokens[0]?.version === 4);
    assert.deepEqual(store.load().tokens[0]!.position, { x: 100, y: 200 });
    assert.equal((await p.send({ ...undo, id: randomUUID() })).type, "error"); // Same history ID, old cursor version.
    assert.equal(store.load().tokens[0]!.version, 4);
    assert.equal(
      (
        await gmPeer.send({
          id: randomUUID(),
          type: "token.move",
          tokenId,
          expectedVersion: 4,
          position: { x: 300, y: 400 },
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().history.undo?.available === false);
    const blocked = p.latest().history.undo!,
      reject = {
        id: randomUUID(),
        type: "scene.undo",
        historyId: blocked.id,
        expectedVersion: blocked.version,
      };
    assert.equal((await p.send(reject)).type, "error");
    assert.equal(store.hasCommand(reject.id), false);
    assert.equal(store.load().tokens[0]!.version, 5);
    // Live context remains mandatory even for a valid GM history cursor.
    await until(() => Boolean(gmPeer.latest().history.undo));
    const gmCursor = gmPeer.latest().history.undo!,
      staleId = randomUUID();
    gmPeer.ws.sendRaw(
      JSON.stringify({
        context: { ...gmPeer.ws.context, generation: 999 },
        command: {
          id: staleId,
          type: "scene.undo",
          historyId: gmCursor.id,
          expectedVersion: gmCursor.version,
        },
      }),
    );
    await until(() =>
      gmPeer.messages.some(
        (m) => m.type === "error" && m.commandId === staleId,
      ),
    );
    assert.equal(store.hasCommand(staleId), false);
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
