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
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { CommandBindings } from "./command-bindings.js";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";

const KEY = "tableloom-acknowledgement-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Command result timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, cookie: string) {
  const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
    headers: { Cookie: cookie, Origin: url },
  });
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  await once(ws, "open");
  await contextReady(ws);
  return { ws, messages };
}
function result(messages: ServerMessage[], id: string) {
  return messages.find(
    (message) =>
      (message.type === "ack" || message.type === "error") &&
      message.commandId === id,
  );
}

test("acknowledgements follow commit, stay requester-only, reject conflicting/reused requests, and survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-acks-")),
    path = join(directory, "table.sqlite");
  let app = await createApp({ databasePath: path, hostKey: KEY });
  const sockets: TestWebSocket[] = [];
  const db = new DatabaseSync(path),
    store = new TableStore(db);
  const post = (route: string, body: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: { origin: "http://localhost", cookie },
      payload: body as Record<string, unknown>,
    });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("setup", { key: KEY, name: "GM" }));
    const joinPlayer = async (name: string) =>
      cookieOf(
        await post("join", {
          name,
          code: (await post("invitations", {}, gm)).json().token,
        }),
      );
    const alice = await joinPlayer("Alice"),
      bob = await joinPlayer("Bob");
    let a = await connect(url, alice);
    const g = await connect(url, gm),
      b = await connect(url, bob);
    sockets.push(a.ws, g.ws, b.ws);
    const noteId = randomUUID(),
      create = {
        id: randomUUID(),
        type: "note.add",
        note: {
          id: noteId,
          title: "Shared note",
          body: "Original",
          visibility: "public",
        },
      };
    a.ws.send(JSON.stringify(create));
    await until(() => Boolean(result(a.messages, create.id)));
    assert.equal(result(a.messages, create.id)?.type, "ack");
    assert.equal(store.load().notes[0]?.version, 1);
    assert.equal(result(g.messages, create.id), undefined);
    assert.equal(result(b.messages, create.id), undefined);
    const changes = {
      title: "Shared note",
      body: "Alice save",
      visibility: "public",
    };
    const first = {
      id: randomUUID(),
      type: "note.update",
      noteId,
      expectedVersion: 1,
      changes,
    };
    const competing = {
      ...first,
      id: randomUUID(),
      changes: { ...changes, body: "GM save" },
    };
    a.ws.send(JSON.stringify(first));
    g.ws.send(JSON.stringify(competing));
    await until(
      () =>
        Boolean(result(a.messages, first.id)) &&
        Boolean(result(g.messages, competing.id)),
    );
    const outcomes = [
      result(a.messages, first.id)!,
      result(g.messages, competing.id)!,
    ];
    assert.equal(
      outcomes.filter((message) => message.type === "ack").length,
      1,
    );
    assert.equal(
      outcomes.filter((message) => message.type === "error").length,
      1,
    );
    assert.equal(store.load().notes[0]?.version, 2);
    const failed = outcomes.find((message) => message.type === "error")!;
    assert.ok(failed.type === "error" && failed.message.includes("changed"));
    assert.equal(store.hasCommand(failed.commandId!), false);
    const winner =
      outcomes[0]!.type === "ack"
        ? { peer: a, frame: first, cookie: alice }
        : { peer: g, frame: competing, cookie: gm };
    const revision = store.load().revision;
    const count = winner.peer.messages.length;
    winner.peer.ws.send(JSON.stringify(winner.frame));
    await until(() =>
      winner.peer.messages
        .slice(count)
        .some(
          (message) =>
            message.type === "ack" && message.commandId === winner.frame.id,
        ),
    );
    assert.equal(store.load().revision, revision);
    const altered = {
      ...winner.frame,
      changes: { ...changes, body: "Tampered retry" },
    };
    const before = winner.peer.messages.length;
    winner.peer.ws.send(JSON.stringify(altered));
    await until(() =>
      winner.peer.messages
        .slice(before)
        .some(
          (message) =>
            message.type === "error" && message.commandId === altered.id,
        ),
    );
    assert.equal(store.load().revision, revision);
    b.ws.send(JSON.stringify(winner.frame));
    await until(() => Boolean(result(b.messages, winner.frame.id)));
    assert.equal(result(b.messages, winner.frame.id)?.type, "error");
    assert.equal(store.load().revision, revision);
    const privateRoll = {
      id: randomUUID(),
      type: "dice.roll",
      expression: "3d37 + 19",
      visibility: "gm",
    };
    a.ws.send(JSON.stringify(privateRoll));
    await until(() => Boolean(result(a.messages, privateRoll.id)));
    assert.equal(result(a.messages, privateRoll.id)?.type, "ack");
    assert.equal(result(g.messages, privateRoll.id), undefined);
    assert.equal(result(b.messages, privateRoll.id), undefined);
    assert.ok(
      !JSON.stringify(result(a.messages, privateRoll.id)).includes(
        privateRoll.expression,
      ),
    );
    // Failure after state/receipt insertion but before binding commit must roll back all three.
    db.exec(
      "CREATE TRIGGER reject_binding BEFORE INSERT ON command_bindings BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    const beforeFailure = store.load(),
      bad = { id: randomUUID(), type: "dice.roll", expression: "d8" };
    a.ws.send(JSON.stringify(bad));
    await until(() => Boolean(result(a.messages, bad.id)));
    assert.equal(result(a.messages, bad.id)?.type, "error");
    assert.deepEqual(store.load(), beforeFailure);
    assert.equal(store.hasCommand(bad.id), false);
    db.exec("DROP TRIGGER reject_binding");
    const binding = db
      .prepare("SELECT * FROM command_bindings WHERE id = ?")
      .get(privateRoll.id);
    assert.ok(binding);
    assert.equal("payload" in binding, false);
    assert.ok(!JSON.stringify(binding).includes(privateRoll.expression));
    db.prepare("DELETE FROM campaign_receipts WHERE id = ?").run(bad.id); // Missing rejected receipt remains absent.
    sockets.forEach((ws) => ws.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    a = await connect(url, alice);
    sockets.push(a.ws);
    const stored = store.load();
    a.ws.send(JSON.stringify(privateRoll));
    await until(() => Boolean(result(a.messages, privateRoll.id)));
    assert.equal(result(a.messages, privateRoll.id)?.type, "ack");
    assert.deepEqual(store.load(), stored);
    db.prepare("DELETE FROM campaign_receipts WHERE id = ?").run(
      privateRoll.id,
    );
    assert.equal(
      db
        .prepare("SELECT id FROM command_bindings WHERE id = ?")
        .get(privateRoll.id),
      undefined,
    );
  } finally {
    sockets.forEach((ws) => ws.terminate());
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("command confirmation storage preserves legacy receipts, is atomic with enclosing transactions, and fails closed on schema markers", () => {
  const db = new DatabaseSync(":memory:");
  const store = new TableStore(db),
    access = new AccessStore(db, KEY);
  const gm = access.setupHost(KEY, "GM");
  try {
    const state = store.load(),
      id = randomUUID();
    store.save({ ...state, revision: state.revision + 1 }, id);
    const bindings = new CommandBindings(db);
    const frame = {
      context: {
        campaignId: gm.member.tableId,
        sceneId: store.getCampaign().activeSceneId,
        generation: 1,
      },
      command: { id, type: "dice.roll" as const, expression: "d6" },
    };
    assert.equal(bindings.matches(gm.member.id, frame), false);
    assert.equal(store.hasCommand(id), true);
    db.exec("BEGIN IMMEDIATE");
    bindings.bind(gm.member.id, frame);
    assert.equal(bindings.matches(gm.member.id, frame), true);
    db.exec("ROLLBACK");
    assert.equal(bindings.matches(gm.member.id, frame), false);
    db.exec("UPDATE command_binding_version SET version=99");
    assert.throws(() => new CommandBindings(db));
    db.exec(
      "UPDATE command_binding_version SET version=1; DROP TABLE command_bindings;",
    );
    assert.throws(() => new CommandBindings(db), /incomplete/);
  } finally {
    db.close();
  }
});
