import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fixture, populate, key } from "./campaign-transfer-fixture.js";
import { inspectCampaignTransferWithImages } from "./campaign-preflight.js";
import {
  reviewCampaignOwnership,
  parseImportEnvelope,
  type OwnershipPlan,
} from "./campaign-ownership-plan.js";
import { CampaignImportStore, MAX_IMPORT_RECEIPTS } from "./campaign-import.js";
import { CampaignImageInspector } from "./campaign-image-inspection.js";
import { installedModules } from "./modules.js";
import { documentSystems } from "./document-modules.js";
import { exportCampaign } from "./campaign-export.js";
import { parseCampaignTransfer } from "./campaign-transfer-format.js";
import { transaction, destinationSnapshot } from "./database.js";
import { StoreError } from "./store.js";
import { ContentCatalog } from "./content-catalog.js";

function contents(db: ReturnType<typeof fixture>["db"]) {
  return JSON.stringify(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => {
        const name = String(row.name);
        return [
          name,
          db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
        ];
      }),
  );
}
async function setup(unclaimed = false) {
  const source = fixture(),
    destination = fixture();
  populate(source);
  populate(destination);
  const token = destination.access.recoverHost(key).token,
    catalog = {
      systems: installedModules,
      contentPacks: destination.catalog.metadata(),
    },
    imports = () =>
      new CampaignImportStore(
        destination.db,
        destination.access,
        destination.tables,
        catalog,
        destination.catalog,
        documentSystems,
      ),
    store = imports(),
    inspector = new CampaignImageInspector(),
    file = source.snapshot(),
    checked = await inspectCampaignTransferWithImages(
      file,
      catalog,
      destination.catalog,
      documentSystems,
      destination.db,
      inspector,
    ),
    plan: OwnershipPlan = {
      version: 1,
      archiveSha256: checked.archiveSha256,
      acknowledge: "reviewed-private-content-and-access",
      acknowledgeMerges: false,
      assignments: checked.ownership.subjects.map((s) => ({
        sourceId: s.sourceId,
        target: unclaimed
          ? { kind: "unclaimed" }
          : s.sourceId === source.gm.member.id
            ? { kind: "existing", userId: destination.gm.member.id, role: "gm" }
            : {
                kind: "new",
                name: destination.player.member.name,
                role: "player",
              },
      })),
    },
    reviewed = reviewCampaignOwnership(
      checked,
      plan,
      destination.db,
      destination.gm.member.id,
    ),
    input = parseImportEnvelope(
      JSON.stringify({
        file,
        plan: reviewed.ownershipReview.plan,
        expectedPlanSha256: reviewed.ownershipReview.planSha256,
        requestId: randomUUID(),
        resourcePolicy: "fresh-campaign-and-resource-identifiers",
        confirm: "create-new-campaign",
      }),
    );
  return {
    source,
    destination,
    token,
    catalog,
    store,
    imports,
    inspector,
    file,
    checked,
    input,
    commit: () => store.commit(input, token, checked),
    async close() {
      await inspector.close();
      source.db.close();
      destination.db.close();
    },
  };
}
const conflict = (run: () => unknown) =>
  assert.throws(
    run,
    (error: unknown) => error instanceof StoreError && error.statusCode === 409,
  );

test("atomic import preserves all private resources with fresh IDs and destination sequences, grants only reviewed membership, and exports a valid round trip", async () => {
  const f = await setup();
  try {
    const original = contents(f.source.db),
      before = f.destination.tables.listCampaigns().length,
      oldSequence = Number(
        f.destination.db
          .prepare("SELECT MAX(sequence) AS n FROM scene_history_entries")
          .get()!.n,
      ),
      result = f.commit();
    assert.equal(result.status, "imported");
    assert.equal(result.replayed, false);
    assert.equal(result.summary.createdPeople, 1);
    assert.equal(result.summary.memberships, 2);
    assert.notEqual(result.campaign.id, f.source.tables.getCampaign().id);
    assert.equal(f.destination.tables.listCampaigns().length, before + 1);
    assert.equal(
      f.destination.access.authenticate(f.token)!.tableId,
      f.destination.gm.member.tableId,
    );
    assert.equal(
      f.destination.access.getMember(
        f.destination.player.member.id,
        result.campaign.id,
      ),
      null,
    );
    const members = z
      .array(z.object({ user_id: z.uuid(), role: z.enum(["gm", "player"]) }))
      .parse(
        f.destination.db
          .prepare(
            "SELECT user_id,role FROM access_memberships WHERE table_id=?",
          )
          .all(result.campaign.id),
      );
    const player = members.find((m) => m.role === "player")!;
    assert.ok(player);
    assert.notEqual(player.user_id, f.source.player.member.id);
    assert.notEqual(player.user_id, f.destination.player.member.id);
    assert.equal(
      f.destination.db
        .prepare("SELECT COUNT(*) AS n FROM access_sessions WHERE user_id=?")
        .get(player.user_id)!.n,
      0,
    );
    const member = f.destination.access.getMember(
      f.destination.gm.member.id,
      result.campaign.id,
    )!;
    const exported = exportCampaign(
        f.destination.db,
        f.destination.tables,
        f.destination.catalog,
        member,
        {
          expectedVersion: result.campaign.version,
          include: "all-campaign-content-including-private",
        },
      ),
      archive = parseCampaignTransfer(exported);
    const sourceArchive = parseCampaignTransfer(f.input.file);
    assert.deepEqual(archive.packages, sourceArchive.packages);
    assert.equal(
      archive.records.module_documents[0]!.data_json,
      sourceArchive.records.module_documents[0]!.data_json,
    );
    assert.equal(
      archive.records.module_documents[0]!.visibility,
      sourceArchive.records.module_documents[0]!.visibility,
    );
    assert.equal(
      archive.records.content_instances[0]!.data_json,
      sourceArchive.records.content_instances[0]!.data_json,
    );
    assert.equal(
      archive.records.content_instances[0]!.source_json,
      sourceArchive.records.content_instances[0]!.source_json,
    );
    assert.equal(
      archive.records.campaign_assets[0]!.bytes,
      sourceArchive.records.campaign_assets[0]!.bytes,
    );
    assert.equal(archive.records.module_documents.length, 1);
    assert.equal(archive.records.content_instances.length, 1);
    assert.equal(archive.records.campaign_assets.length, 1);
    assert.equal(archive.records.scene_records.length, 2);
    assert.equal(archive.records.module_documents[0]!.owner_id, player.user_id);
    assert.ok(archive.records.scene_history_entries[0]!.sequence > oldSequence);
    assert.equal(archive.records.command_bindings.length, 0);
    assert.equal(archive.records.campaign_receipts.length, 0);
    assert.ok(!exported.includes(f.input.requestId));
    const report = await inspectCampaignTransferWithImages(
      exported,
      f.catalog,
      f.destination.catalog,
      documentSystems,
      f.destination.db,
      f.inspector,
    );
    assert.deepEqual(report.blockers, []);
    assert.equal(report.moduleReferenceValidation.complete, true);
    assert.equal(
      f.destination.db
        .prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1")
        .get(),
      undefined,
    );
    assert.equal(contents(f.source.db), original);
    assert.equal(f.destination.db.isTransaction, false);
  } finally {
    await f.close();
  }
});

test("unclaimed imports retain attribution-only profiles for foreign keys without memberships, invitations or login sessions", async () => {
  const f = await setup(true);
  try {
    const result = f.commit();
    assert.equal(result.summary.createdPeople, 0);
    assert.equal(result.summary.attributionRecords, 2);
    assert.equal(result.summary.memberships, 1);
    const owner = z
      .uuid()
      .parse(
        f.destination.db
          .prepare("SELECT owner_id FROM module_documents WHERE campaign_id=?")
          .get(result.campaign.id)!.owner_id,
      );
    assert.equal(
      f.destination.db
        .prepare("SELECT name FROM access_users WHERE id=?")
        .get(owner)!.name,
      "Unclaimed identity",
    );
    assert.equal(
      f.destination.db
        .prepare("SELECT COUNT(*) AS n FROM access_memberships WHERE user_id=?")
        .get(owner)!.n,
      0,
    );
    assert.equal(
      f.destination.db
        .prepare("SELECT COUNT(*) AS n FROM access_sessions WHERE user_id=?")
        .get(owner)!.n,
      0,
    );
    assert.equal(
      f.destination.db
        .prepare(
          "SELECT COUNT(*) AS n FROM access_invitations WHERE target_user_id=?",
        )
        .get(owner)!.n,
      0,
    );
    assert.equal(
      f.destination.db
        .prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1")
        .get(),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("durable exact retries replay one committed result and reject changed input, stale proof or a lost target membership", async () => {
  const f = await setup();
  try {
    const result = f.commit(),
      saved = contents(f.destination.db),
      replay = f.imports().replay(f.input, f.token)!;
    assert.equal(replay.replayed, true);
    assert.equal(replay.campaign.id, result.campaign.id);
    assert.equal(f.commit().replayed, true);
    assert.equal(contents(f.destination.db), saved);
    conflict(() =>
      f.store.commit(
        { ...f.input, expectedPlanSha256: "0".repeat(64) },
        f.token,
        f.checked,
      ),
    );
    const plan = structuredClone(f.input.plan);
    plan.assignments.find((a) => a.target.kind === "new")!.target = {
      kind: "new",
      name: "Another person",
      role: "player",
    };
    const reviewed = reviewCampaignOwnership(
        f.checked,
        plan,
        f.destination.db,
        f.destination.gm.member.id,
      ),
      changed = parseImportEnvelope(
        JSON.stringify({
          ...f.input,
          resourcePolicy: "fresh-campaign-and-resource-identifiers",
          plan: reviewed.ownershipReview.plan,
          expectedPlanSha256: reviewed.ownershipReview.planSha256,
        }),
      );
    conflict(() => f.store.replay(changed, f.token));
    assert.equal(contents(f.destination.db), saved);
    f.destination.db
      .prepare("DELETE FROM access_memberships WHERE user_id=? AND table_id=?")
      .run(f.destination.gm.member.id, result.campaign.id);
    const afterRemoval = contents(f.destination.db);
    conflict(() => f.store.replay(f.input, f.token));
    assert.equal(contents(f.destination.db), afterRemoval);
  } finally {
    await f.close();
  }
});

test("faults at early, middle and final writes roll back people, every campaign resource, memberships, sequences and retry receipt", async () => {
  const f = await setup();
  try {
    for (const table of [
      "access_users",
      "campaign_records",
      "scene_records",
      "module_documents",
      "content_instances",
      "campaign_assets",
      "scene_background_history_refs",
      "scene_history_entries",
      "access_memberships",
      "campaign_import_requests",
    ]) {
      f.destination.db.exec(
        `CREATE TRIGGER import_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'PRIVATE WRITE CANARY'); END;`,
      );
      const before = contents(f.destination.db);
      assert.throws(
        f.commit,
        (error: unknown) =>
          error instanceof StoreError &&
          error.statusCode === 409 &&
          !error.message.includes("PRIVATE"),
      );
      assert.equal(contents(f.destination.db), before, table);
      assert.equal(f.destination.db.isTransaction, false);
      assert.equal(f.store.replay(f.input, f.token), null);
      f.destination.db.exec("DROP TRIGGER import_fault");
    }
    assert.equal(f.commit().replayed, false);
  } finally {
    await f.close();
  }
});

test("commit revalidates capacity, package bindings and host access instead of trusting an earlier preview", async () => {
  const f = await setup();
  try {
    const old = f.destination.db
      .prepare(
        "SELECT digest FROM content_pack_bindings WHERE pack_id=? AND pack_version=?",
      )
      .get(f.source.pack.id, f.source.pack.version)!.digest;
    f.destination.db
      .prepare(
        "UPDATE content_pack_bindings SET digest=? WHERE pack_id=? AND pack_version=?",
      )
      .run("0".repeat(64), f.source.pack.id, f.source.pack.version);
    const drifted = contents(f.destination.db);
    conflict(f.commit);
    assert.equal(contents(f.destination.db), drifted);
    f.destination.db
      .prepare(
        "UPDATE content_pack_bindings SET digest=? WHERE pack_id=? AND pack_version=?",
      )
      .run(z.string().parse(old), f.source.pack.id, f.source.pack.version);
    while (
      Number(
        f.destination.db
          .prepare("SELECT COUNT(*) AS n FROM access_campaigns")
          .get()!.n,
      ) < 100
    )
      f.destination.db
        .prepare("INSERT INTO access_campaigns VALUES(?)")
        .run(randomUUID());
    const full = contents(f.destination.db);
    conflict(f.commit);
    assert.equal(contents(f.destination.db), full);
    f.destination.access.revokeSession(f.token);
    assert.throws(f.commit);
    assert.equal(f.destination.db.isTransaction, false);
    assert.equal(
      f.destination.db
        .prepare("SELECT COUNT(*) AS n FROM campaign_import_requests")
        .get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("import storage rejects future, incomplete and inconsistent receipts without reseeding; retained request capacity preserves existing replays", async () => {
  const f = await setup();
  try {
    const result = f.commit(),
      receipt = f.destination.db
        .prepare("SELECT * FROM campaign_import_requests WHERE request_id=?")
        .get(f.input.requestId)!;
    transaction(f.destination.db, () => {
      const add = f.destination.db.prepare(
        "INSERT INTO campaign_import_requests VALUES(?,?,?,?,?)",
      );
      for (let i = 1; i < MAX_IMPORT_RECEIPTS; i++) {
        const id = randomUUID(),
          target = randomUUID(),
          value = {
            ...result,
            requestId: id,
            campaign: { ...result.campaign, id: target },
          };
        const { replayed: _replayed, ...stored } = value;
        add.run(
          id,
          z.uuid().parse(receipt.host_id),
          z.string().parse(receipt.fingerprint),
          target,
          JSON.stringify(stored),
        );
      }
    });
    f.imports();
    const before = contents(f.destination.db);
    conflict(() =>
      f.store.commit(
        { ...f.input, requestId: randomUUID() },
        f.token,
        f.checked,
      ),
    );
    assert.equal(
      f.store.replay(f.input, f.token)!.campaign.id,
      result.campaign.id,
    );
    assert.equal(contents(f.destination.db), before);
    f.destination.db
      .prepare("UPDATE campaign_import_storage_version SET version=999")
      .run();
    assert.throws(f.imports);
    f.destination.db
      .prepare("UPDATE campaign_import_storage_version SET version=1")
      .run();
    f.destination.db
      .prepare(
        "UPDATE campaign_import_requests SET fingerprint=? WHERE request_id=?",
      )
      .run("0".repeat(64), f.input.requestId);
    assert.throws(f.imports);
    f.destination.db.exec("DROP TABLE campaign_import_requests");
    assert.throws(f.imports);
    assert.equal(f.destination.db.isTransaction, false);
  } finally {
    await f.close();
  }
});

test("validators borrow an owned transaction only by explicit server request and never commit or roll back their caller", async () => {
  const f = await setup();
  try {
    assert.throws(() =>
      destinationSnapshot(f.destination.db, () => true, "existing"),
    );
    f.destination.db.exec("BEGIN IMMEDIATE");
    assert.equal(
      destinationSnapshot(f.destination.db, () => true, "existing"),
      true,
    );
    assert.throws(() =>
      destinationSnapshot(
        f.destination.db,
        () => {
          throw new Error("fail");
        },
        "existing",
      ),
    );
    assert.equal(f.destination.db.isTransaction, true);
    assert.throws(f.commit, /own its write transaction/);
    f.destination.db.exec("ROLLBACK");
  } finally {
    await f.close();
  }
});

test("unavailable historical pack claims cannot create global bindings; trusted historical bindings commit and roll back with the campaign", async () => {
  const f = await setup();
  try {
    const archive = parseCampaignTransfer(f.file),
      oldPack = { ...f.source.pack, id: "fixture-retired", version: "0.9.0" },
      content = new ContentCatalog([f.source.pack, oldPack]),
      digest = content.packs.find((p) => p.pack.id === oldPack.id)!.digest;
    archive.packages.contentPacks.push({
      id: oldPack.id,
      version: oldPack.version,
      selected: false,
      sha256: digest,
    });
    archive.records.content_overrides.push({
      campaign_id: archive.campaign.id,
      pack_id: oldPack.id,
      pack_version: oldPack.version,
      definition_id: "retired",
      revision: 1,
      name: null,
      visibility: null,
      data_json: null,
    });
    const file = JSON.stringify(archive),
      checked = await inspectCampaignTransferWithImages(
        file,
        f.catalog,
        f.destination.catalog,
        documentSystems,
        f.destination.db,
        f.inspector,
      ),
      reviewed = reviewCampaignOwnership(
        checked,
        { ...f.input.plan, archiveSha256: checked.archiveSha256 },
        f.destination.db,
        f.destination.gm.member.id,
      ),
      input = parseImportEnvelope(
        JSON.stringify({
          ...f.input,
          file,
          resourcePolicy: "fresh-campaign-and-resource-identifiers",
          plan: reviewed.ownershipReview.plan,
          expectedPlanSha256: reviewed.ownershipReview.planSha256,
        }),
      );
    assert.deepEqual(checked.blockers, []);
    const before = contents(f.destination.db);
    conflict(() => f.store.commit(input, f.token, checked));
    assert.equal(contents(f.destination.db), before);
    const catalog = {
        systems: installedModules,
        contentPacks: content.metadata(),
      },
      trusted = new CampaignImportStore(
        f.destination.db,
        f.destination.access,
        f.destination.tables,
        catalog,
        content,
        documentSystems,
      ),
      proof = await inspectCampaignTransferWithImages(
        file,
        catalog,
        content,
        documentSystems,
        f.destination.db,
        f.inspector,
      );
    f.destination.db.exec(
      "CREATE TRIGGER historical_fault BEFORE INSERT ON campaign_records BEGIN SELECT RAISE(ABORT,'PRIVATE BINDING CANARY'); END",
    );
    conflict(() => trusted.commit(input, f.token, proof));
    assert.equal(contents(f.destination.db), before);
    f.destination.db.exec("DROP TRIGGER historical_fault");
    assert.equal(trusted.commit(input, f.token, proof).status, "imported");
    assert.equal(
      f.destination.db
        .prepare(
          "SELECT digest FROM content_pack_bindings WHERE pack_id=? AND pack_version=?",
        )
        .get(oldPack.id, oldPack.version)!.digest,
      digest,
    );
  } finally {
    await f.close();
  }
});
