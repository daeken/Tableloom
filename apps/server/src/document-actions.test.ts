import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defineDocumentAction,
  defineServerSystem,
} from "@tableloom/module-sdk/server";
import { system as shared } from "@tableloom/cyberpunk-red";
import { DocumentStore } from "./documents.js";
import { TableStore, StoreError } from "./store.js";
import { AccessStore } from "./access.js";

const key = "document-action-fixture-not-a-real-key";
const pin = { id: shared.manifest.id, version: shared.manifest.version };
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError && error.statusCode === code;

function fixture() {
  const db = new DatabaseSync(":memory:"),
    campaigns = new TableStore(db),
    access = new AccessStore(db, key);
  const gm = access.setupHost(key, "GM"),
    alice = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Alice",
    ),
    bob = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Bob",
    );
  let calls = 0;
  const append = defineDocumentAction(shared, {
    id: "append-note",
    inputSchema: z.object({ text: z.string().min(1).max(100) }).strict(),
    run: ({ data, input, actor }) => {
      calls++;
      return { ...data, notes: `${data.notes}${actor.role}:${input.text}` };
    },
  });
  const bad = defineDocumentAction(shared, {
    id: "bad-output",
    inputSchema: z.object({}).strict(),
    run: ({ data }) => ({ ...data, notes: "x".repeat(70000) }),
  });
  const throws = defineDocumentAction(shared, {
    id: "throws",
    inputSchema: z.object({}).strict(),
    run: ({ data }) => {
      data.notes = "Mutated unsaved data";
      throw new Error("PRIVATE MODULE ERROR");
    },
  });
  const transformed = defineDocumentAction(shared, {
    id: "non-json-input",
    inputSchema: z.string().transform(() => new Date()),
    run: ({ data }) => {
      calls++;
      return data;
    },
  });
  const extra = defineDocumentAction(shared, {
    id: "extra-field",
    inputSchema: z.null(),
    run: ({ data }) => ({ ...data, unexpected: true }),
  });
  const system = defineServerSystem({
    ...shared,
    documentActions: [append, bad, throws, transformed, extra],
  });
  const documents = new DocumentStore(db, campaigns, [system]);
  return {
    db,
    campaigns,
    access,
    gm,
    alice,
    bob,
    documents,
    system,
    calls: () => calls,
  };
}

test("document actions authorize the persisted member, validate input, preserve metadata and reject duplicate/stale attempts", () => {
  const f = fixture();
  try {
    const d = f.documents.create(f.alice.member, {
      title: "Private fixture",
      system: pin,
    });
    const before = f.campaigns.load(),
      campaign = f.campaigns.getCampaign(f.alice.member.tableId);
    const run = (
      actor: typeof f.alice.member,
      expectedVersion: number,
      input: unknown = { text: "hello" },
      action = "append-note",
    ) => f.documents.act(actor, d.id, { expectedVersion, input, action });
    assert.throws(() => run(f.bob.member, 1), status(404));
    assert.throws(() => run({ ...f.bob.member, role: "gm" }, 1), status(404));
    f.db
      .prepare(
        "UPDATE module_documents SET data_json = 'corrupt hidden data' WHERE id = ?",
      )
      .run(d.id);
    assert.throws(() => run(f.bob.member, 1), status(404));
    f.db
      .prepare("UPDATE module_documents SET data_json = ? WHERE id = ?")
      .run(JSON.stringify(d.data), d.id);
    assert.throws(() => run(f.alice.member, 2), status(409));
    for (const input of [
      { text: 3 },
      { text: "hello", role: "gm" },
      { text: "x".repeat(101) },
      new Date(),
    ])
      assert.throws(() => run(f.alice.member, 1, input));
    assert.throws(() => run(f.alice.member, 1, {}, "missing"), status(400));
    assert.equal(f.calls(), 0);
    const updated = run(f.alice.member, 1);
    assert.deepEqual(updated, {
      ...d,
      version: 2,
      data: { name: "", notes: "player:hello" },
    });
    assert.equal(f.calls(), 1);
    assert.throws(() => run(f.alice.member, 1), status(409));
    assert.equal(f.calls(), 1);
    const gm = run(f.gm.member, 2, { text: " gm" });
    assert.equal(gm.version, 3);
    assert.deepEqual(gm.data, { name: "", notes: "player:hellogm: gm" });
    assert.equal(gm.ownerId, d.ownerId);
    assert.equal(gm.visibility, "gm");
    assert.deepEqual(f.campaigns.load(), before);
    assert.deepEqual(f.campaigns.getCampaign(f.alice.member.tableId), campaign);
    const publicDoc = f.documents.update(f.alice.member, d.id, {
      expectedVersion: 3,
      title: d.title,
      visibility: "public",
      data: gm.data,
    });
    assert.throws(() => run(f.bob.member, publicDoc.version), status(403));
    const token = f.access.createInvitation(f.gm.token).token,
      removed = f.access.redeemInvitation(token, "Removed");
    f.access.removeMember(f.gm.token, removed.member.id);
    assert.throws(() => run(removed.member, publicDoc.version), status(403));
    assert.equal(f.calls(), 2);
    assert.throws(
      () =>
        f.documents.act(f.alice.member, randomUUID(), {
          expectedVersion: 1,
          action: "append-note",
          input: { text: "x" },
        }),
      status(404),
    );
  } finally {
    f.db.close();
  }
});

test("failed handlers, invalid output/input transforms, stale schemas/pins and failed writes leave document bytes/version intact", () => {
  const f = fixture();
  try {
    const d = f.documents.create(f.alice.member, {
      title: "Rollback fixture",
      system: pin,
    });
    const bytes = () =>
      f.db.prepare("SELECT * FROM module_documents WHERE id = ?").get(d.id);
    const before = bytes();
    for (const [action, input] of [
      ["bad-output", {}],
      ["throws", {}],
      ["non-json-input", "x"],
      ["extra-field", null],
    ] as const) {
      assert.throws(
        () =>
          f.documents.act(f.alice.member, d.id, {
            expectedVersion: 1,
            action,
            input,
          }),
        (error) =>
          status(400)(error) && !String(error).includes("PRIVATE MODULE ERROR"),
      );
      assert.deepEqual(bytes(), before);
    }
    assert.equal(f.calls(), 0);
    f.db
      .prepare("UPDATE module_documents SET schema_version = 2 WHERE id = ?")
      .run(d.id);
    assert.throws(
      () =>
        f.documents.act(f.alice.member, d.id, {
          expectedVersion: 1,
          action: "append-note",
          input: { text: "x" },
        }),
      status(409),
    );
    f.db
      .prepare(
        "UPDATE module_documents SET schema_version = 1, system_version = '9.9.9' WHERE id = ?",
      )
      .run(d.id);
    assert.throws(
      () =>
        f.documents.act(f.alice.member, d.id, {
          expectedVersion: 1,
          action: "append-note",
          input: { text: "x" },
        }),
      status(409),
    );
    f.db
      .prepare("UPDATE module_documents SET system_version = ? WHERE id = ?")
      .run(pin.version, d.id);
    f.db.exec(
      "CREATE TRIGGER fail_action BEFORE UPDATE OF data_json ON module_documents BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    assert.throws(() =>
      f.documents.act(f.alice.member, d.id, {
        expectedVersion: 1,
        action: "append-note",
        input: { text: "x" },
      }),
    );
    assert.deepEqual(bytes(), before);
    f.db.exec("DROP TRIGGER fail_action");
    assert.equal(
      f.documents.act(f.alice.member, d.id, {
        expectedVersion: 1,
        action: "append-note",
        input: { text: "x" },
      }).version,
      2,
    );
  } finally {
    f.db.close();
  }
});

test("trusted action registration rejects duplicate IDs and mismatched system/schema pins", () => {
  const action = defineDocumentAction(shared, {
    id: "noop",
    inputSchema: z.null(),
    run: ({ data }) => data,
  });
  assert.throws(() =>
    defineServerSystem({ ...shared, documentActions: [action, action] }),
  );
  for (const system of [
    { ...action.system, id: "another-system" },
    { ...action.system, version: "9.9.9" },
    { ...action.system, documentVersion: 2 },
  ])
    assert.throws(() =>
      defineServerSystem({
        ...shared,
        documentActions: [{ ...action, system }],
      }),
    );
  assert.throws(() =>
    defineDocumentAction(shared, {
      id: "../import",
      inputSchema: z.null(),
      run: ({ data }) => data,
    }),
  );
});
