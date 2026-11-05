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
    await until(() => p.latest().history.undo?.action === "move");
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
        .prepare("SELECT state,version FROM scene_history_entries WHERE id=?")
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
    const drawingId = randomUUID(),
      drawing = {
        id: drawingId,
        kind: "stroke",
        color: "#405f4d",
        points: [
          { x: 10, y: 20 },
          { x: 40, y: 50 },
        ],
      };
    assert.equal(
      (await gmPeer.send({ id: randomUUID(), type: "drawing.add", drawing }))
        .type,
      "ack",
    );
    await until(() => gmPeer.latest().history.undo?.objectId === drawingId);
    const edit = async (
      peer: typeof gmPeer,
      type: "scene.undo" | "scene.redo",
    ) => {
      const cursor =
          peer.latest().history[type === "scene.undo" ? "undo" : "redo"]!,
        start = peer.messages.length;
      const command = {
        id: randomUUID(),
        type,
        historyId: cursor.id,
        expectedVersion: cursor.version,
      };
      assert.equal((await peer.send(command)).type, "ack");
      await until(() =>
        peer.messages.slice(start).some((m) => m.type === "snapshot"),
      );
      return command;
    };
    await edit(gmPeer, "scene.undo");
    assert.equal(store.load().drawings.length, 0);
    await edit(gmPeer, "scene.redo");
    assert.equal(store.load().drawings[0]!.version, 3);
    assert.equal(
      (
        await gmPeer.send({
          id: randomUUID(),
          type: "object.delete",
          objectId: drawingId,
          expectedVersion: 3,
        })
      ).type,
      "ack",
    );
    await until(() => gmPeer.latest().history.undo?.action === "delete");
    const deletedCursor = gmPeer.latest().history.undo!;
    assert.ok(!JSON.stringify(deletedCursor).includes("points"));
    assert.ok(!JSON.stringify(p.messages).includes(deletedCursor.id));
    // Restart with a deleted object: its inverse, owner and cursor remain durable.
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    const restoredGM = await connect(url, gm);
    sockets.push(restoredGM.ws);
    assert.deepEqual(restoredGM.latest().history.undo, deletedCursor);
    const restored = await edit(restoredGM, "scene.undo");
    assert.deepEqual(
      { ...store.load().drawings[0], version: 1 },
      { ...drawing, ownerId: store.load().drawings[0]!.ownerId, version: 1 },
    );
    assert.equal(store.load().drawings[0]!.version, 5);
    assert.equal((await restoredGM.send(restored)).type, "ack");
    assert.equal(store.load().drawings[0]!.version, 5);
    await edit(restoredGM, "scene.redo");
    assert.equal(store.load().drawings.length, 0);
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live token groups commit once, reject partial conflicts, preserve private cursors, and undo/redo after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-live-groups-")),
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
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
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
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids)
      assert.equal(
        (
          await p.send({
            id: randomUUID(),
            type: "token.add",
            token: {
              id,
              name: "Scout",
              color: "#405f4d",
              position: { x: 0, y: 0 },
            },
          })
        ).type,
        "ack",
      );
    const group = {
      id: randomUUID(),
      type: "tokens.move",
      moves: ids.map((tokenId, i) => ({
        tokenId,
        expectedVersion: 1,
        position: { x: 10 + i * 20, y: 0 },
      })),
    };
    const revision = store.load().revision;
    assert.equal((await p.send(group)).type, "ack");
    await until(() => p.latest().history.undo?.objectCount === 2);
    assert.equal(store.load().revision, revision + 1);
    const cursor = p.latest().history.undo!;
    assert.ok(!JSON.stringify(g.messages).includes(cursor.id));
    assert.equal(g.latest().history.undo, null);
    assert.equal((await p.send(group)).type, "ack");
    assert.equal(store.load().revision, revision + 1);
    assert.equal(
      (
        await g.send({
          id: randomUUID(),
          type: "token.move",
          tokenId: ids[0],
          expectedVersion: 2,
          position: { x: 90, y: 0 },
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().history.undo?.available === false);
    const changed = store.load();
    const rejected = {
      id: randomUUID(),
      type: "scene.undo",
      historyId: cursor.id,
      expectedVersion: cursor.version,
    };
    assert.equal((await p.send(rejected)).type, "error");
    assert.deepEqual(store.load(), changed);
    assert.equal(store.hasCommand(rejected.id), false);
    const fresh = {
      ...group,
      id: randomUUID(),
      moves: ids.map((tokenId, i) => ({
        tokenId,
        expectedVersion: store
          .load()
          .tokens.find((token) => token.id === tokenId)!.version,
        position: { x: 100 + i * 20, y: 0 },
      })),
    };
    assert.equal((await p.send(fresh)).type, "ack");
    await until(() => p.latest().state.tokens[0]?.version === 4);
    const current = p.latest().history.undo!,
      undo = {
        id: randomUUID(),
        type: "scene.undo",
        historyId: current.id,
        expectedVersion: current.version,
      };
    assert.equal((await p.send(undo)).type, "ack");
    await until(() => p.latest().state.tokens[0]?.version === 5);
    const redo = p.latest().history.redo!;
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    p = await connect(url, player);
    sockets.push(p.ws);
    assert.deepEqual(p.latest().history.redo, redo);
    const beforeRetry = store.load();
    assert.equal((await p.send(fresh)).type, "ack");
    assert.deepEqual(store.load(), beforeRetry);
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "scene.redo",
          historyId: redo.id,
          expectedVersion: redo.version,
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().state.tokens[0]?.version === 6);
    assert.deepEqual(
      store.load().tokens.map((token) => token.position.x),
      [100, 120],
    );
    const rows = db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      beforeFailure = store.load(),
      top = p.latest().history.undo!;
    db.exec(
      "CREATE TRIGGER reject_group_binding BEFORE INSERT ON command_bindings BEGIN SELECT RAISE(ABORT,'fixture group binding failure'); END;",
    );
    const failed = {
      id: randomUUID(),
      type: "scene.undo",
      historyId: top.id,
      expectedVersion: top.version,
    };
    assert.equal((await p.send(failed)).type, "error");
    assert.deepEqual(store.load(), beforeFailure);
    assert.deepEqual(
      db.prepare("SELECT * FROM scene_history_entries ORDER BY sequence").all(),
      rows,
    );
    assert.equal(store.hasCommand(failed.id), false);
    db.exec("DROP TRIGGER reject_group_binding");
    const stale = randomUUID();
    p.ws.sendRaw(
      JSON.stringify({
        context: { ...p.ws.context, generation: 999 },
        command: { ...fresh, id: stale },
      }),
    );
    await until(() =>
      p.messages.some(
        (message) => message.type === "error" && message.commandId === stale,
      ),
    );
    assert.equal(store.hasCommand(stale), false);
    assert.deepEqual(store.load(), beforeFailure);
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live mixed movement is atomic, private in history, conflict-safe, retryable and exact after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-live-mixed-")),
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
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("setup", { key: KEY, name: "GM" })),
      player = cookieOf(
        await post("join", {
          name: "Player",
          code: (await post("invitations", {}, gm)).json().token,
        }),
      );
    let p = await connect(url, player);
    const g = await connect(url, gm);
    sockets.push(p.ws, g.ws);
    const tokenId = randomUUID(),
      drawingId = randomUUID(),
      points = [
        { x: 0.1, y: 0.2 },
        { x: 10.3, y: 20.4 },
      ];
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "token.add",
          token: {
            id: tokenId,
            name: "Scout",
            position: { x: 1, y: 2 },
            color: "#405f4d",
          },
        })
      ).type,
      "ack",
    );
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "drawing.add",
          drawing: { id: drawingId, kind: "stroke", points, color: "#405f4d" },
        })
      ).type,
      "ack",
    );
    const command = {
        id: randomUUID(),
        type: "objects.move",
        objects: [
          { objectId: tokenId, expectedVersion: 1 },
          { objectId: drawingId, expectedVersion: 1 },
        ],
        delta: { x: 20, y: 30 },
      },
      revision = store.load().revision;
    assert.equal((await p.send(command)).type, "ack");
    await until(() => p.latest().history.undo?.objectType === "mixed");
    const cursor = p.latest().history.undo!;
    assert.equal(store.load().revision, revision + 1);
    assert.ok(!JSON.stringify(g.messages).includes(cursor.id));
    assert.equal(g.latest().history.undo, null);
    assert.ok(!JSON.stringify(cursor).includes("originals"));
    const accepted = store.load();
    assert.equal((await p.send(command)).type, "ack");
    assert.deepEqual(store.load(), accepted);
    assert.equal(
      (
        await g.send({
          id: randomUUID(),
          type: "objects.move",
          objects: [{ objectId: drawingId, expectedVersion: 2 }],
          delta: { x: 10, y: 0 },
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().history.undo?.available === false);
    const changed = store.load(),
      reject = {
        id: randomUUID(),
        type: "scene.undo",
        historyId: cursor.id,
        expectedVersion: cursor.version,
      };
    assert.equal((await p.send(reject)).type, "error");
    assert.deepEqual(store.load(), changed);
    assert.equal(store.hasCommand(reject.id), false);
    const fresh = {
      ...command,
      id: randomUUID(),
      objects: [
        { objectId: tokenId, expectedVersion: 2 },
        { objectId: drawingId, expectedVersion: 3 },
      ],
      delta: { x: -5, y: 5 },
    };
    assert.equal((await p.send(fresh)).type, "ack");
    await until(() => p.latest().state.tokens[0]?.version === 3);
    const afterFresh = store.load(),
      edge = p.latest().history.undo!;
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "scene.undo",
          historyId: edge.id,
          expectedVersion: edge.version,
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().state.tokens[0]?.version === 4);
    const redo = p.latest().history.redo!;
    assert.deepEqual(
      store.load().drawings[0]!.points,
      changed.drawings[0]!.points,
    );
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    p = await connect(url, player);
    sockets.push(p.ws);
    assert.deepEqual(p.latest().history.redo, redo);
    const beforeRetry = store.load();
    assert.equal((await p.send(fresh)).type, "ack");
    assert.deepEqual(store.load(), beforeRetry);
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "scene.redo",
          historyId: redo.id,
          expectedVersion: redo.version,
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().state.tokens[0]?.version === 5);
    assert.deepEqual(
      store.load().tokens[0]!.position,
      afterFresh.tokens[0]!.position,
    );
    assert.deepEqual(
      store.load().drawings[0]!.points,
      afterFresh.drawings[0]!.points,
    );
    const beforeFailure = store.load(),
      rows = db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      top = p.latest().history.undo!;
    db.exec(
      "CREATE TRIGGER reject_mixed_binding BEFORE INSERT ON command_bindings BEGIN SELECT RAISE(ABORT,'fixture mixed binding'); END;",
    );
    const failed = {
      id: randomUUID(),
      type: "scene.undo",
      historyId: top.id,
      expectedVersion: top.version,
    };
    assert.equal((await p.send(failed)).type, "error");
    assert.deepEqual(store.load(), beforeFailure);
    assert.deepEqual(
      db.prepare("SELECT * FROM scene_history_entries ORDER BY sequence").all(),
      rows,
    );
    assert.equal(store.hasCommand(failed.id), false);
    db.exec("DROP TRIGGER reject_mixed_binding");
    const stale = randomUUID();
    p.ws.sendRaw(
      JSON.stringify({
        context: { ...p.ws.context, generation: 999 },
        command: { ...fresh, id: stale },
      }),
    );
    await until(() =>
      p.messages.some(
        (message) => message.type === "error" && message.commandId === stale,
      ),
    );
    assert.equal(store.hasCommand(stale), false);
    assert.deepEqual(store.load(), beforeFailure);
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live group deletion is atomic, exactly retryable, private in history, and restores as a group after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-live-delete-")),
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
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("setup", { key: KEY, name: "GM" })),
      player = cookieOf(
        await post("join", {
          name: "Player",
          code: (await post("invitations", {}, gm)).json().token,
        }),
      );
    let p = await connect(url, player);
    const g = await connect(url, gm);
    sockets.push(p.ws, g.ws);
    const tokenId = randomUUID(),
      drawingId = randomUUID(),
      points = [
        { x: 0.1, y: 0.2 },
        { x: 20.3, y: 30.4 },
      ];
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "token.add",
          token: {
            id: tokenId,
            name: "Scout",
            position: { x: 10, y: 20 },
            color: "#405f4d",
          },
        })
      ).type,
      "ack",
    );
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "drawing.add",
          drawing: {
            id: drawingId,
            kind: "rectangle",
            points,
            color: "#405f4d",
          },
        })
      ).type,
      "ack",
    );
    const prepared = {
      id: randomUUID(),
      type: "objects.delete",
      objects: [
        { objectId: tokenId, expectedVersion: 1 },
        { objectId: drawingId, expectedVersion: 1 },
      ],
    };
    assert.equal(
      (
        await g.send({
          id: randomUUID(),
          type: "token.move",
          tokenId,
          expectedVersion: 1,
          position: { x: 50, y: 60 },
        })
      ).type,
      "ack",
    );
    const changed = store.load();
    assert.equal((await p.send(prepared)).type, "error");
    assert.deepEqual(store.load(), changed);
    assert.equal(store.hasCommand(prepared.id), false);
    const command = {
      ...prepared,
      id: randomUUID(),
      objects: [
        { objectId: tokenId, expectedVersion: 2 },
        { objectId: drawingId, expectedVersion: 1 },
      ],
    };
    assert.equal((await p.send(command)).type, "ack");
    await until(
      () =>
        p.latest().history.undo?.action === "delete" &&
        p.latest().state.tokens.length === 0,
    );
    assert.equal(store.load().revision, changed.revision + 1);
    assert.equal(store.load().drawings.length, 0);
    const cursor = p.latest().history.undo!;
    assert.equal(cursor.objectCount, 2);
    assert.equal(cursor.objectType, "mixed");
    assert.ok(!JSON.stringify(cursor).includes("points"));
    assert.ok(!JSON.stringify(g.messages).includes(cursor.id));
    const deleted = store.load();
    assert.equal((await p.send(command)).type, "ack");
    assert.deepEqual(store.load(), deleted);
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    p = await connect(url, player);
    sockets.push(p.ws);
    assert.deepEqual(p.latest().history.undo, cursor);
    const beforeFailure = store.load(),
      rows = db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    db.exec(
      "CREATE TRIGGER reject_delete_binding BEFORE INSERT ON command_bindings BEGIN SELECT RAISE(ABORT,'fixture delete binding'); END;",
    );
    const failed = {
      id: randomUUID(),
      type: "scene.undo",
      historyId: cursor.id,
      expectedVersion: cursor.version,
    };
    assert.equal((await p.send(failed)).type, "error");
    assert.deepEqual(store.load(), beforeFailure);
    assert.deepEqual(
      db.prepare("SELECT * FROM scene_history_entries ORDER BY sequence").all(),
      rows,
    );
    assert.equal(store.hasCommand(failed.id), false);
    db.exec("DROP TRIGGER reject_delete_binding");
    const undo = { ...failed, id: randomUUID() };
    assert.equal((await p.send(undo)).type, "ack");
    await until(
      () =>
        p.latest().state.tokens.length === 1 &&
        p.latest().state.drawings.length === 1,
    );
    assert.equal(store.load().tokens[0]!.version, 4);
    assert.equal(store.load().drawings[0]!.version, 3);
    assert.deepEqual(store.load().drawings[0]!.points, points);
    const restored = store.load();
    assert.equal((await p.send(undo)).type, "ack");
    assert.deepEqual(store.load(), restored);
    const stale = { ...command, id: randomUUID() };
    assert.equal((await p.send(stale)).type, "error");
    assert.deepEqual(store.load(), restored);
    assert.equal(store.hasCommand(stale.id), false);
    const redo = p.latest().history.redo!;
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "scene.redo",
          historyId: redo.id,
          expectedVersion: redo.version,
        })
      ).type,
      "ack",
    );
    await until(
      () =>
        p.latest().state.tokens.length === 0 &&
        p.latest().state.drawings.length === 0,
    );
    const staleContext = randomUUID();
    p.ws.sendRaw(
      JSON.stringify({
        context: { ...p.ws.context, generation: 999 },
        command: { ...command, id: staleContext },
      }),
    );
    await until(() =>
      p.messages.some(
        (message) =>
          message.type === "error" && message.commandId === staleContext,
      ),
    );
    assert.equal(store.hasCommand(staleContext), false);
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live drawing resize confirms once, rolls back failed bindings, survives restart and rejects stale drags and foreign history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-live-resize-")),
    path = join(directory, "table.sqlite");
  let app = await createApp({ databasePath: path, hostKey: KEY });
  const db = new DatabaseSync(path),
    store = new TableStore(db),
    sockets: TestWebSocket[] = [];
  const post = (route: string, payload: Record<string, unknown>, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: { origin: "http://localhost", cookie },
      payload,
    });
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers["set-cookie"]).split(";")[0]!;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("setup", { key: KEY, name: "GM" })),
      player = cookieOf(
        await post("join", {
          name: "Player",
          code: (await post("invitations", {}, gm)).json().token,
        }),
      );
    let p = await connect(url, player);
    const g = await connect(url, gm);
    sockets.push(p.ws, g.ws);
    const id = randomUUID(),
      points = [
        { x: 0.1, y: 0.2 },
        { x: 10.3, y: 20.4 },
        { x: 6.7, y: 8.9 },
      ];
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "drawing.add",
          drawing: { id, kind: "stroke", points, color: "#405f4d" },
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().state.drawings[0]?.version === 1);
    const command = {
        id: randomUUID(),
        type: "drawing.resize",
        drawingId: id,
        expectedVersion: 1,
        bounds: { left: -20.4, top: -10.1, right: 100, bottom: 70.3 },
      },
      before = store.load(),
      rows = db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    db.exec(
      "CREATE TRIGGER reject_resize_binding BEFORE INSERT ON command_bindings BEGIN SELECT RAISE(ABORT,'fixture resize binding'); END;",
    );
    assert.equal((await p.send(command)).type, "error");
    assert.deepEqual(store.load(), before);
    assert.equal(store.hasCommand(command.id), false);
    assert.deepEqual(
      db.prepare("SELECT * FROM scene_history_entries ORDER BY sequence").all(),
      rows,
    );
    db.exec("DROP TRIGGER reject_resize_binding");
    assert.equal((await p.send(command)).type, "ack");
    await until(() => p.latest().state.drawings[0]?.version === 2);
    const resized = store.load(),
      cursor = p.latest().history.undo!;
    assert.equal(cursor.action, "resize");
    assert.ok(!JSON.stringify(cursor).includes("points"));
    assert.ok(!JSON.stringify(g.messages).includes(cursor.id));
    assert.equal((await p.send(command)).type, "ack");
    assert.deepEqual(store.load(), resized);
    const stale = { ...command, id: randomUUID() };
    assert.equal((await p.send(stale)).type, "error");
    assert.equal(store.hasCommand(stale.id), false);
    assert.deepEqual(store.load(), resized);
    const undo = {
      id: randomUUID(),
      type: "scene.undo",
      historyId: cursor.id,
      expectedVersion: cursor.version,
    };
    assert.equal((await g.send(undo)).type, "error");
    assert.deepEqual(store.load(), resized);
    sockets.forEach((s) => s.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    p = await connect(url, player);
    sockets.push(p.ws);
    assert.deepEqual(p.latest().history.undo, cursor);
    assert.equal((await p.send(undo)).type, "ack");
    await until(() => p.latest().state.drawings[0]?.version === 3);
    assert.deepEqual(store.load().drawings[0]!.points, points);
    assert.equal((await p.send(undo)).type, "ack");
    assert.equal(store.load().drawings[0]!.version, 3);
    const redo = p.latest().history.redo!;
    assert.equal(
      (
        await p.send({
          id: randomUUID(),
          type: "scene.redo",
          historyId: redo.id,
          expectedVersion: redo.version,
        })
      ).type,
      "ack",
    );
    await until(() => p.latest().state.drawings[0]?.version === 4);
    assert.deepEqual(
      store.load().drawings[0]!.points,
      resized.drawings[0]!.points,
    );
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
