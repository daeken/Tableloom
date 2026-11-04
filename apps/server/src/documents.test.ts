import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineServerSystem } from "@tableloom/module-sdk/server";
import { system as cyberpunk } from "@tableloom/cyberpunk-red/server";
import { DocumentStore } from "./documents.js";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { StoreError } from "./store.js";

const KEY = "tableloom-document-store-fixture-not-a-real-key";
const pin = { id: "cyberpunk-red", version: "0.1.0" };
const status = (expected: number) => (error: unknown) =>
  error instanceof StoreError && error.statusCode === expected;
function fixture() {
  const db = new DatabaseSync(":memory:"),
    campaigns = new TableStore(db),
    access = new AccessStore(db, KEY);
  const gm = access.setupHost(KEY, "GM"),
    alice = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Alice",
    ),
    bob = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Bob",
    );
  return {
    db,
    campaigns,
    access,
    gm,
    alice,
    bob,
    documents: new DocumentStore(db, campaigns),
  };
}

test("documents validate installed schemas, assign owners, enforce versioned edits, and filter visibility before decoding", () => {
  const { db, campaigns, documents, alice, bob, gm } = fixture();
  try {
    const table = campaigns.load();
    const document = documents.create(alice.member, {
      title: "  Private scaffold  ",
      system: pin,
    });
    assert.deepEqual(document.data, { name: "", notes: "" });
    assert.equal(document.title, "Private scaffold");
    assert.equal(document.ownerId, alice.member.id);
    assert.equal(document.schemaVersion, 1);
    assert.equal(documents.list(bob.member).documents.length, 0);
    assert.throws(() => documents.get(bob.member, document.id), status(404));
    assert.throws(
      () => documents.get({ ...bob.member, role: "gm" }, document.id),
      status(404),
    ); // Persisted membership wins over supplied role.
    assert.throws(
      () =>
        documents.update(bob.member, document.id, {
          expectedVersion: 999,
          title: "Guess",
          visibility: "public",
          data: { name: "", notes: "" },
        }),
      status(404),
    );
    db.prepare("UPDATE module_documents SET data_json = ? WHERE id = ?").run(
      "private corrupt JSON",
      document.id,
    );
    assert.throws(() => documents.get(bob.member, document.id), status(404));
    assert.equal(documents.list(bob.member).documents.length, 0); // Hidden malformed payloads are never parsed.
    assert.throws(() => documents.get(alice.member, document.id));
    db.prepare("UPDATE module_documents SET data_json = ? WHERE id = ?").run(
      JSON.stringify(document.data),
      document.id,
    );
    assert.throws(
      () =>
        documents.update(alice.member, document.id, {
          expectedVersion: 1,
          title: "Invalid",
          visibility: "gm",
          data: { name: "", notes: "", inventedMechanic: 3 },
        }),
      status(400),
    );
    const shared = documents.update(alice.member, document.id, {
      expectedVersion: 1,
      title: "Shared scaffold",
      visibility: "public",
      data: { name: "Scout", notes: "Provisional notes only" },
    });
    assert.equal(shared.version, 2);
    assert.deepEqual(documents.get(bob.member, document.id).data, shared.data);
    assert.throws(
      () =>
        documents.update(bob.member, document.id, {
          expectedVersion: 2,
          title: "Stolen",
          visibility: "gm",
          data: shared.data,
        }),
      status(403),
    );
    assert.throws(
      () =>
        documents.update(alice.member, document.id, {
          expectedVersion: 1,
          title: "Stale",
          visibility: "public",
          data: shared.data,
        }),
      status(409),
    );
    const privateAgain = documents.update(gm.member, document.id, {
      expectedVersion: 2,
      title: "Retracted",
      visibility: "gm",
      data: shared.data,
    });
    assert.equal(privateAgain.ownerId, alice.member.id);
    assert.throws(() => documents.get(bob.member, document.id), status(404));
    assert.throws(
      () => documents.delete(alice.member, document.id, 2),
      status(409),
    );
    assert.deepEqual(campaigns.load(), table); // Documents never grow snapshots or private clocks.
    documents.delete(alice.member, document.id, 3);
    assert.throws(() => documents.get(gm.member, document.id), status(404));
  } finally {
    db.close();
  }
});

test("document pagination is visible-only and metadata-only; campaign and removed-member boundaries are enforced", () => {
  const { db, campaigns, documents, access, alice, bob, gm } = fixture();
  try {
    const hidden = documents.create(gm.member, {
      title: "GM-only title",
      system: pin,
    });
    for (let i = 0; i < 57; i++)
      documents.create(alice.member, {
        title: `Public ${i}`,
        system: pin,
        visibility: "public",
      });
    const ids = new Set<string>();
    let after: string | undefined;
    do {
      const page = documents.list(bob.member, {
        limit: 7,
        ...(after ? { after } : {}),
      });
      assert.ok(!JSON.stringify(page).includes(hidden.id));
      assert.ok(!JSON.stringify(page).includes("GM-only title"));
      for (const document of page.documents) {
        assert.ok(!ids.has(document.id));
        assert.equal("data" in document, false);
        ids.add(document.id);
      }
      after = page.next ?? undefined;
    } while (after);
    assert.equal(ids.size, 57);
    assert.throws(() => documents.list(bob.member, { limit: 51 }));
    const other = campaigns.createCampaign({
      name: "Other",
      description: "",
      system: { id: "kids-on-bikes", version: "0.1.0" },
      contentPacks: [],
    });
    access.registerCampaign(gm.token, other.id);
    const gmOther = access.selectCampaign(gm.token, other.id);
    const foreign = documents.create(gmOther.member, {
      title: "Other campaign public doc",
      visibility: "public",
      system: { id: "kids-on-bikes", version: "0.1.0" },
    });
    assert.throws(() => documents.get(alice.member, foreign.id), status(404));
    assert.equal(documents.list(gmOther.member).documents.length, 1);
    const gmDefault = access.recoverHost(KEY);
    const owned = documents.create(alice.member, {
      title: "Former member",
      system: pin,
    });
    access.removeMember(gmDefault.token, alice.member.id);
    assert.throws(() => documents.get(alice.member, owned.id), status(403));
    assert.equal(documents.get(gm.member, owned.id).ownerId, alice.member.id); // Removal preserves GM access.
  } finally {
    db.close();
  }
});

test("schema migrations are explicit, sequential, GM-only, and atomic on validation or SQL failure", () => {
  const { db, campaigns, alice, gm } = fixture();
  try {
    const intermediate = z
      .object({ name: z.string(), notes: z.string() })
      .strict();
    const latest = intermediate.extend({ tag: z.string() }).strict();
    const definition = defineServerSystem({
      ...cyberpunk,
      documentVersion: 3,
      documentSchema: latest,
      createDocument: () => ({ name: "", notes: "", tag: "" }),
      documentMigrations: [
        {
          from: 1,
          to: 2,
          outputSchema: intermediate,
          migrate: (data) => ({
            name: z.object({ label: z.string() }).parse(data).label,
            notes: "",
          }),
        },
        {
          from: 2,
          to: 3,
          outputSchema: latest,
          migrate: (data) => ({
            ...intermediate.parse(data),
            tag: "Converted fixture",
          }),
        },
      ],
    });
    const documents = new DocumentStore(db, campaigns, [definition]);
    const document = documents.create(alice.member, {
      title: "Legacy fixture",
      system: pin,
    });
    db.prepare(
      "UPDATE module_documents SET schema_version = 1, data_json = ? WHERE id = ?",
    ).run('{"label":"Scout"}', document.id);
    const before = db
      .prepare("SELECT * FROM module_documents WHERE id = ?")
      .get(document.id);
    assert.throws(() => documents.get(alice.member, document.id), status(409));
    assert.equal(documents.list(alice.member).documents[0]?.schemaVersion, 1);
    assert.throws(
      () => documents.migrate(alice.member, document.id, 1),
      status(403),
    );
    assert.throws(
      () => documents.migrate(gm.member, document.id, 2),
      status(409),
    );
    const gap = new DocumentStore(db, campaigns, [
      {
        ...definition,
        documentMigrations: definition.documentMigrations!.slice(1),
      },
    ]);
    assert.throws(() => gap.migrate(gm.member, document.id, 1), status(409));
    assert.deepEqual(
      db
        .prepare("SELECT * FROM module_documents WHERE id = ?")
        .get(document.id),
      before,
    );
    const invalid = new DocumentStore(db, campaigns, [
      {
        ...definition,
        documentMigrations: [
          {
            from: 1,
            to: 2,
            outputSchema: intermediate,
            migrate: () => ({ invalid: true }),
          },
          definition.documentMigrations![1]!,
        ],
      },
    ]);
    assert.throws(
      () => invalid.migrate(gm.member, document.id, 1),
      status(409),
    );
    assert.deepEqual(
      db
        .prepare("SELECT * FROM module_documents WHERE id = ?")
        .get(document.id),
      before,
    );
    db.exec(
      "CREATE TRIGGER reject_document_migration BEFORE UPDATE ON module_documents BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    assert.throws(() => documents.migrate(gm.member, document.id, 1));
    assert.deepEqual(
      db
        .prepare("SELECT * FROM module_documents WHERE id = ?")
        .get(document.id),
      before,
    );
    db.exec("DROP TRIGGER reject_document_migration");
    const migrated = documents.migrate(gm.member, document.id, 1);
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.data, {
      name: "Scout",
      notes: "",
      tag: "Converted fixture",
    });
    assert.deepEqual(documents.get(alice.member, document.id), migrated);
    assert.throws(
      () => documents.migrate(gm.member, document.id, 2),
      status(409),
    );
    db.prepare(
      "UPDATE module_documents SET schema_version = 99 WHERE id = ?",
    ).run(document.id);
    assert.throws(() => documents.get(alice.member, document.id), status(409));
    assert.throws(
      () => documents.migrate(gm.member, document.id, 2),
      status(409),
    );
  } finally {
    db.close();
  }
});

test("system pin changes cannot strand documents, capacity is bounded, and schema markers fail closed", () => {
  const { db, campaigns, documents, gm } = fixture();
  try {
    const document = documents.create(gm.member, {
      title: "Pinned",
      system: pin,
    });
    const metadata = campaigns.getCampaign();
    assert.throws(
      () =>
        campaigns.updateCampaign(metadata.id, metadata.version, {
          name: metadata.name,
          description: "",
          system: { id: "kids-on-bikes", version: "0.1.0" },
          contentPacks: [],
        }),
      status(409),
    );
    const state = campaigns.load();
    assert.throws(
      () =>
        campaigns.save(
          { ...state, revision: state.revision + 1, systemId: "kids-on-bikes" },
          randomUUID(),
        ),
      status(409),
    );
    assert.equal(campaigns.load().systemId, pin.id);
    assert.throws(
      () =>
        documents.create(gm.member, {
          title: "Wrong pin",
          system: { id: pin.id, version: "9.9.9" },
        }),
      status(409),
    );
    for (let i = 1; i < 500; i++)
      documents.create(gm.member, { title: `Document ${i}`, system: pin });
    assert.throws(
      () => documents.create(gm.member, { title: "Overflow", system: pin }),
      status(409),
    );
    documents.delete(gm.member, document.id, 1);
    assert.equal(
      documents.create(gm.member, { title: "Freed space", system: pin })
        .version,
      1,
    );
    db.exec("UPDATE document_storage_version SET version = 99");
    assert.throws(() => new DocumentStore(db, campaigns));
    db.exec(
      "UPDATE document_storage_version SET version = 1; DROP TABLE module_documents;",
    );
    assert.throws(() => new DocumentStore(db, campaigns), /incomplete/);
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'module_documents'",
        )
        .get(),
      undefined,
    );
  } finally {
    db.close();
  }
});
