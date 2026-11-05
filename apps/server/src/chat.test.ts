import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ChatStore } from "./chat.js";
import { AccessStore } from "./access.js";
import { TableStore } from "./store.js";
import {
  chatInputSchema,
  chatMessageSchema,
  chatPageSchema,
} from "@tableloom/core/chat";
const KEY = "tableloom-chat-store-test-private-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    gm = access.setupHost(KEY, "GM"),
    join = (name: string) =>
      access.redeemInvitation(access.createInvitation(gm.token).token, name),
    a = join("A <&>"),
    b = join("B"),
    chat = new ChatStore(db, tables, () => 1234);
  return { db, tables, access, gm, a, b, join, chat };
}
const input = (body = "Hello", audience: "public" | "gm" = "public") => ({
  id: crypto.randomUUID(),
  body,
  audience,
});
test("chat persists authenticated authors and immutable audiences, filters current membership and retries retained IDs without scene writes", () => {
  const f = fixture();
  try {
    const before = f.tables.load(),
      publicInput = input("  Hello <b>world</b>  "),
      pub = f.chat.send({ ...f.a.member, name: "Fake" }, publicInput),
      secret = f.chat.send(f.a.member, input("A's secret", "gm")),
      bSecret = f.chat.send(f.b.member, input("B's secret", "gm")),
      gmSecret = f.chat.send(f.gm.member, input("GM secret", "gm"));
    assert.equal(pub.authorName, "A <&>");
    assert.equal(pub.body, "Hello <b>world</b>");
    assert.deepEqual(
      f.chat.list(f.a.member).messages.map((m) => m.id),
      [pub.id, secret.id],
    );
    assert.deepEqual(
      f.chat.list({ ...f.b.member, role: "gm" }).messages.map((m) => m.id),
      [pub.id, bSecret.id],
    );
    assert.deepEqual(
      f.chat.list(f.gm.member).messages.map((m) => m.id),
      [pub.id, secret.id, bSecret.id, gmSecret.id],
    );
    assert.deepEqual(f.chat.send(f.a.member, publicInput), pub);
    assert.throws(
      () => f.chat.send(f.a.member, { ...publicInput, audience: "gm" }),
      /already used/,
    );
    assert.throws(() => f.chat.send(f.b.member, publicInput), /already used/);
    assert.throws(() =>
      f.chat.send(f.a.member, { ...input(), authorId: f.gm.member.id }),
    );
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      new ChatStore(f.db, f.tables).list(f.a.member),
      f.chat.list(f.a.member),
    );
    f.access.removeMember(f.gm.token, f.a.member.id);
    assert.throws(() => f.chat.list(f.a.member), /Sign in/);
    assert.throws(() => f.chat.send(f.a.member, input()), /Sign in/);
    assert.ok(
      f.chat.list(f.gm.member).messages.some((m) => m.id === secret.id),
    );
  } finally {
    f.db.close();
  }
});
test("chat retains 100 per audience with a 1100 campaign cap, visible-only page ordering and atomic pruning rollback", () => {
  const f = fixture();
  try {
    const pub = f.chat.send(f.a.member, input("Public stays"));
    for (let i = 0; i < 102; i++) f.chat.send(f.a.member, input(`a${i}`, "gm"));
    const all = f.chat.list(f.a.member).messages;
    assert.equal(all.length, 100);
    assert.equal(all[0]!.body, "a2");
    assert.equal(all.at(-1)!.body, "a101");
    assert.deepEqual(
      f.chat.list(f.b.member).messages.map((m) => m.id),
      [pub.id],
    );
    const before = f.db.prepare("SELECT * FROM chat_messages").all();
    f.db.exec(
      "CREATE TRIGGER fail_chat_prune BEFORE DELETE ON chat_messages BEGIN SELECT RAISE(ABORT,'prune rollback'); END",
    );
    assert.throws(
      () => f.chat.send(f.a.member, input("not saved", "gm")),
      /prune rollback/,
    );
    assert.deepEqual(f.db.prepare("SELECT * FROM chat_messages").all(), before);
    f.db.exec("DROP TRIGGER fail_chat_prune");
    for (let n = 0; n < 9; n++) {
      const user = n === 0 ? f.b : f.join(`Person${n}`);
      for (let i = 0; i < 100; i++)
        f.chat.send(user.member, input(`${n}:${i}`, "gm"));
    }
    for (let i = 1; i < 100; i++) f.chat.send(f.gm.member, input(`public${i}`));
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM chat_messages").get()!.n,
      1100,
    );
    assert.throws(
      () => f.chat.send(f.gm.member, input("new bucket", "gm")),
      /storage limit/,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM chat_messages").get()!.n,
      1100,
    );
    f.chat.send(f.a.member, input("own bucket still works", "gm"));
    f.chat.send(f.gm.member, input("public still works"));
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM chat_messages").get()!.n,
      1100,
    );
    new ChatStore(f.db, f.tables);
  } finally {
    f.db.close();
  }
});
test("chat startup is additive, rejects future/incomplete/orphan storage and validates saved identity/audience without repair", () => {
  const f = fixture();
  try {
    const before = f.db.prepare("SELECT state_json FROM scene_records").all();
    const m = f.chat.send(f.a.member, input("private", "gm"));
    f.db
      .prepare("UPDATE chat_messages SET bucket='public' WHERE id=?")
      .run(m.id);
    assert.throws(() => f.chat.list(f.b.member), /inconsistent/);
    assert.throws(() => new ChatStore(f.db, f.tables), /inconsistent/);
    f.db
      .prepare("UPDATE chat_messages SET bucket=?,id=? WHERE id=?")
      .run(f.a.member.id, crypto.randomUUID(), m.id);
    assert.throws(() => new ChatStore(f.db, f.tables), /identity/);
    f.db.exec(
      "DELETE FROM chat_messages; UPDATE chat_storage_version SET version=2",
    );
    assert.throws(() => new ChatStore(f.db, f.tables));
    f.db.exec(
      "UPDATE chat_storage_version SET version=1; DROP TABLE chat_messages",
    );
    assert.throws(() => new ChatStore(f.db, f.tables), /incomplete/);
    f.db.exec(
      "DROP TABLE chat_storage_version; CREATE TABLE chat_messages(x TEXT)",
    );
    assert.throws(() => new ChatStore(f.db, f.tables), /missing its version/);
    f.db.exec(
      "DROP TABLE chat_messages; CREATE VIEW chat_messages AS SELECT 1 AS x",
    );
    assert.throws(() => new ChatStore(f.db, f.tables));
    assert.equal(
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='chat_storage_version'",
        )
        .get(),
      undefined,
    );
    f.db.exec("DROP VIEW chat_messages");
    new ChatStore(f.db, f.tables);
    assert.throws(
      () =>
        f.db
          .prepare(
            "INSERT INTO chat_messages(campaign_id,id,bucket,message_json) VALUES(?,?,?,?)",
          )
          .run(crypto.randomUUID(), m.id, "public", JSON.stringify(m)),
      /FOREIGN KEY/,
    );
    assert.deepEqual(
      f.db.prepare("SELECT state_json FROM scene_records").all(),
      before,
    );
  } finally {
    f.db.close();
  }
});
test("chat boundaries reject oversized, blank, forged, duplicate, invalid-time and secret fields", () => {
  for (const change of [
    { body: " " },
    { body: "x".repeat(2001) },
    { audience: "other" },
    { id: "not uuid" },
    { name: "fake" },
  ])
    assert.equal(
      chatInputSchema.safeParse({ ...input(), ...change }).success,
      false,
    );
  const message = {
    ...input(),
    authorId: crypto.randomUUID(),
    authorName: "Player",
    createdAt: 1234,
  };
  for (const createdAt of [Infinity, -1, 1.5, 8640000000000001])
    assert.equal(
      chatMessageSchema.safeParse({ ...message, createdAt }).success,
      false,
    );
  const page = {
    campaignId: crypto.randomUUID(),
    viewerId: crypto.randomUUID(),
    messages: [message],
  };
  assert.equal(chatPageSchema.safeParse(page).success, true);
  assert.equal(
    chatPageSchema.safeParse({ ...page, messages: [message, message] }).success,
    false,
  );
  assert.equal(
    chatPageSchema.safeParse({ ...page, privateRevision: 1 }).success,
    false,
  );
});
