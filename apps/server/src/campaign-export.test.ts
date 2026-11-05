import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandSchema } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { createApp } from "./app.js";
import { transaction } from "./database.js";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { DocumentStore } from "./documents.js";
import { ContentCatalog, withContentMetadata } from "./content-catalog.js";
import { CampaignContentStore } from "./content.js";
import { ContentInstanceStore } from "./instances.js";
import { AssetStore } from "./assets.js";
import { SceneMapStore } from "./scene-map.js";
import { SceneGridStore } from "./scene-grid.js";
import { SceneHistoryStore } from "./scene-history.js";
import { CommandBindings } from "./command-bindings.js";
import { RollHistoryStore } from "./roll-history.js";
import { ChatStore } from "./chat.js";
import { installedModules } from "./modules.js";
import { instancePack } from "./instances-fixture.js";
import { pngFixture } from "./png-fixture.js";
import { exportCampaign, MAX_CAMPAIGN_EXPORT_ROWS } from "./campaign-export.js";

const key = "campaign-export-test-not-a-real-private-key";
const input = {
  expectedVersion: 1,
  include: "all-campaign-content-including-private",
} as const;
function fixture(path = ":memory:") {
  const db = new DatabaseSync(path),
    pack = instancePack(),
    catalog = new ContentCatalog([pack]),
    tables = new TableStore(
      db,
      withContentMetadata(
        { systems: installedModules, contentPacks: [] },
        catalog,
      ),
    ),
    access = new AccessStore(db, key),
    gm = access.setupHost(key, "Export GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Export player",
    ),
    documents = new DocumentStore(db, tables),
    content = new CampaignContentStore(db, tables, catalog),
    instances = new ContentInstanceStore(db, tables, catalog, content),
    history = new SceneHistoryStore(db, tables),
    assets = new AssetStore(db),
    maps = new SceneMapStore(db, tables, assets),
    grids = new SceneGridStore(db, tables),
    chat = new ChatStore(db, tables),
    bindings = new CommandBindings(db);
  const rolls = new RollHistoryStore(db, tables);
  const snapshot = () =>
    exportCampaign(db, tables, catalog, gm.member, {
      ...input,
      expectedVersion: tables.getCampaign().version,
    });
  return {
    db,
    pack,
    catalog,
    tables,
    access,
    gm,
    player,
    documents,
    content,
    instances,
    history,
    assets,
    maps,
    grids,
    chat,
    bindings,
    rolls,
    snapshot,
  };
}

test("single-campaign export includes private/offstage state, owned data and history, preserves identities/pins, omits credentials and other campaigns without writes", () => {
  const f = fixture();
  try {
    const campaign = f.tables.getCampaign();
    f.tables.updateCampaign(campaign.id, campaign.version, {
      name: campaign.name,
      description: campaign.description,
      system: campaign.system,
      contentPacks: [{ id: f.pack.id, version: f.pack.version }],
    });
    const reference = {
      packId: f.pack.id,
      packVersion: f.pack.version,
      definitionId: "a-public",
    };
    f.content.override(f.gm.member, reference, {
      expectedRevision: 0,
      name: "Private override",
      visibility: "gm",
      data: { label: "PRIVATE OVERRIDE", tags: [] },
      sources: [],
    });
    const owned = f.instances.create(f.gm.member, {
      reference,
      expectedRevision: 1,
    });
    const doc = f.documents.create(f.player.member, {
      title: "PRIVATE RECORD",
      system: campaign.system,
      data: { name: "Synthetic", notes: "PRIVATE FIELD" },
    });
    const asset = f.assets.upload(f.gm.member, "PRIVATE MAP", pngFixture());
    const context = {
      campaignId: campaign.id,
      sceneId: campaign.activeSceneId,
      generation: f.tables.getCampaign().version,
    };
    f.maps.set(f.gm.member, {
      context,
      expectedVersion: 0,
      assetId: asset.id,
      position: { x: 0, y: 0 },
      width: 320,
    });
    f.grids.update(f.gm.member, {
      context,
      expectedVersion: 0,
      settings: { spacing: 75, origin: { x: 5, y: 7 }, visible: false },
    });
    f.chat.send(f.player.member, {
      id: randomUUID(),
      audience: "gm",
      body: "PRIVATE CHAT",
    });
    const command = commandSchema.parse({
      id: randomUUID(),
      type: "token.add",
      token: {
        id: randomUUID(),
        name: "PRIVATE OFFSTAGE TOKEN",
        color: "#405f4d",
        position: { x: 3, y: 9 },
      },
    });
    const before = f.tables.load(),
      after = applyCommand(before, command, f.player.member);
    transaction(f.db, () => {
      f.history.record(f.player.member, before, after, command);
      f.tables.save(after, command.id);
      f.bindings.bind(f.player.member.id, { context, command });
    });
    const rollCommand = commandSchema.parse({
      id: randomUUID(),
      type: "dice.roll",
      expression: "d6",
      visibility: "gm",
    });
    const rolled = applyCommand(f.tables.load(), rollCommand, f.player.member);
    f.tables.save(rolled, rollCommand.id);
    f.rolls.change(
      f.player.member,
      { ids: [rolled.rolls.at(-1)!.id] },
      "archive",
    );
    const noteCommand = commandSchema.parse({
      id: randomUUID(),
      type: "note.add",
      note: {
        id: randomUUID(),
        title: "PRIVATE NOTE",
        body: "Private notebook",
        visibility: "gm",
      },
    });
    f.tables.save(
      applyCommand(f.tables.load(), noteCommand, f.player.member),
      noteCommand.id,
    );
    const second = f.tables.createScene(campaign.id, { name: "Another scene" });
    f.tables.activateScene(
      campaign.id,
      second.id,
      f.tables.getCampaign().version,
    );
    const other = f.tables.createCampaign({
      name: "UNRELATED CAMPAIGN CANARY",
      description: "",
      system: campaign.system,
      contentPacks: [],
    });
    f.access.registerCampaign(f.gm.token, other.id);
    const otherGM = f.access.selectCampaign(f.gm.token, other.id);
    const outsider = f.access.redeemInvitation(
      f.access.createInvitation(otherGM.token).token,
      "UNRELATED PERSON",
    );
    f.documents.create(outsider.member, {
      title: "UNRELATED RECORD CANARY",
      system: campaign.system,
    });
    const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    const exported = f.snapshot(),
      archive = JSON.parse(exported);
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(f.db.isTransaction, false);
    assert.equal(archive.format, "tableloom-campaign-export");
    assert.equal(archive.version, 1);
    assert.equal(archive.privacy, input.include);
    assert.equal(
      archive.identityPolicy,
      "source-identifiers-without-access-grants",
    );
    assert.deepEqual(archive.packages.system, campaign.system);
    assert.equal(
      archive.packages.contentPacks[0].sha256,
      f.catalog.packs[0]!.digest,
    );
    assert.equal(archive.records.scene_records.length, 2);
    assert.equal(archive.records.campaign_records.length, 1);
    assert.equal(archive.records.module_documents[0].id, doc.id);
    assert.equal(
      archive.records.module_documents[0].owner_id,
      f.player.member.id,
    );
    assert.equal(archive.records.content_instances[0].id, owned.id);
    assert.equal(archive.records.content_overrides.length, 1);
    assert.equal(archive.records.scene_history_entries.length, 1);
    assert.equal(archive.records.object_id_reservations.length, 1);
    assert.equal(archive.records.campaign_receipts.length, 4);
    assert.equal(archive.records.roll_archive.length, 1);
    assert.equal(archive.records.command_bindings.length, 1);
    assert.equal(archive.records.scene_background_history.length, 1);
    assert.equal(archive.records.scene_background_history_refs.length, 1);
    assert.equal(archive.records.scene_grids.length, 1);
    assert.deepEqual(
      Buffer.from(archive.records.campaign_assets[0].bytes, "base64"),
      pngFixture(),
    );
    for (const canary of [
      "PRIVATE RECORD",
      "PRIVATE NOTE",
      "PRIVATE FIELD",
      "PRIVATE MAP",
      "PRIVATE CHAT",
      "PRIVATE OVERRIDE",
      "PRIVATE OFFSTAGE TOKEN",
    ])
      assert.ok(exported.includes(canary), canary);
    for (const secret of [
      key,
      f.gm.token,
      f.player.token,
      outsider.token,
      "token_hash",
      "access_host",
      "access_sessions",
      "access_invitations",
      "UNRELATED CAMPAIGN CANARY",
      "UNRELATED RECORD CANARY",
      "UNRELATED PERSON",
    ])
      assert.ok(!exported.includes(secret), secret);
    assert.equal(archive.members.length, 2);
  } finally {
    f.db.close();
  }
});

test("export enforces stored GM membership, explicit privacy acknowledgement, exact pins and storage versions/columns; failures release snapshots", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        exportCampaign(
          f.db,
          f.tables,
          f.catalog,
          { ...f.player.member, role: "gm" },
          input,
        ),
      /GM access/,
    );
    assert.throws(
      () =>
        exportCampaign(f.db, f.tables, f.catalog, f.gm.member, {
          ...input,
          expectedVersion: 99,
        }),
      /changed/,
    );
    assert.throws(() =>
      exportCampaign(f.db, f.tables, f.catalog, f.gm.member, {
        ...input,
        include: "public" as typeof input.include,
      }),
    );
    assert.throws(
      () =>
        exportCampaign(
          f.db,
          f.tables,
          f.catalog,
          { ...f.gm.member, tableId: randomUUID() },
          input,
        ),
      /GM access/,
    );
    f.db.exec("UPDATE scene_history_version SET version=999");
    assert.throws(f.snapshot, /storage version/);
    f.db.exec(
      "UPDATE scene_history_version SET version=17; ALTER TABLE scene_grids ADD COLUMN future_private_field TEXT",
    );
    assert.throws(f.snapshot, /storage columns/);
    f.db.exec(
      "ALTER TABLE scene_grids DROP COLUMN future_private_field; CREATE TABLE future_campaign_data(campaign_id TEXT, secret TEXT)",
    );
    assert.throws(f.snapshot, /newer export/);
    f.db.exec(
      "DROP TABLE future_campaign_data; UPDATE campaign_records SET json=json_set(json,'$.system.version','9.9.9')",
    );
    assert.throws(f.snapshot, /required system package/);
    f.db.exec(
      "UPDATE campaign_records SET json=json_set(json,'$.system.version','0.1.0')",
    );
    assert.ok(f.snapshot());
    f.db
      .prepare("DELETE FROM access_memberships WHERE user_id=?")
      .run(f.gm.member.id);
    assert.throws(f.snapshot, /GM access/);
    assert.equal(f.db.isTransaction, false);
  } finally {
    f.db.close();
  }
});

test("row/byte limits and altered image/pack bytes abort export without partial output or source mutation", () => {
  const f = fixture();
  try {
    const campaign = f.tables.getCampaign();
    f.tables.updateCampaign(campaign.id, campaign.version, {
      name: campaign.name,
      description: "",
      system: campaign.system,
      contentPacks: [{ id: f.pack.id, version: f.pack.version }],
    });
    f.db.exec(
      "UPDATE content_pack_bindings SET digest='" + "0".repeat(64) + "'",
    );
    assert.throws(f.snapshot, /content pack/);
    f.db
      .prepare("UPDATE content_pack_bindings SET digest=?")
      .run(f.catalog.packs[0]!.digest);
    const asset = f.assets.upload(f.gm.member, "Image", pngFixture());
    f.db
      .prepare("UPDATE campaign_assets SET bytes=? WHERE id=?")
      .run(Buffer.alloc(pngFixture().length), asset.id);
    assert.throws(f.snapshot, /image storage/);
    f.db.prepare("DELETE FROM campaign_assets WHERE id=?").run(asset.id);
    f.db
      .prepare("UPDATE campaign_records SET state_json=?")
      .run(JSON.stringify({ giant: "x".repeat(32 * 1024 * 1024) }));
    assert.throws(f.snapshot, /export limits/);
    f.db.prepare("UPDATE campaign_records SET state_json=?").run("{}");
    f.db
      .prepare(
        "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<?) INSERT INTO object_id_reservations(campaign_id,id) SELECT ?, printf('%08x-0000-4000-8000-000000000000',n) FROM numbers",
      )
      .run(MAX_CAMPAIGN_EXPORT_ROWS, campaign.id);
    const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.throws(f.snapshot, /export limits/);
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(f.db.isTransaction, false);
  } finally {
    f.db.close();
  }
});

test("export preserves historical pack fingerprints and departed owners, rejecting mismatched document pins and malformed payloads", () => {
  const f = fixture();
  try {
    const digest = "1".repeat(64);
    f.db
      .prepare("INSERT INTO content_pack_bindings VALUES(?,?,?)")
      .run("retired-paper", "0.9.0", digest);
    f.db
      .prepare("INSERT INTO content_overrides VALUES(?,?,?,?,?,?,?,?)")
      .run(
        DEFAULT_CAMPAIGN_ID,
        "retired-paper",
        "0.9.0",
        "old-page",
        2,
        null,
        null,
        null,
      );
    const doc = f.documents.create(f.player.member, {
      title: "Departed player's private record",
      system: f.tables.getCampaign().system,
    });
    f.access.removeMember(f.gm.token, f.player.member.id);
    const archive = JSON.parse(f.snapshot());
    assert.deepEqual(archive.packages.contentPacks, [
      {
        id: "retired-paper",
        version: "0.9.0",
        selected: false,
        sha256: digest,
      },
    ]);
    assert.equal(
      archive.records.module_documents[0].owner_id,
      f.player.member.id,
    );
    assert.equal(archive.members.length, 1);
    f.db
      .prepare("UPDATE module_documents SET system_version=? WHERE id=?")
      .run("9.9.9", doc.id);
    assert.throws(f.snapshot, /system pins disagree/);
    f.db
      .prepare(
        "UPDATE module_documents SET system_version=?,data_json=? WHERE id=?",
      )
      .run(doc.system.version, "not-json", doc.id);
    assert.throws(f.snapshot, /Invalid stored JSON/);
    assert.equal(f.db.isTransaction, false);
  } finally {
    f.db.close();
  }
});

test("HTTP export requires active GM, same Origin and acknowledgement and returns a private attachment", async () => {
  const app = await createApp({ databasePath: ":memory:", hostKey: key });
  const post = (
    path: string,
    body: unknown,
    cookie = "",
    origin = "http://localhost",
  ) =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: { cookie, origin, "content-type": "application/json" },
      payload: JSON.stringify(body),
    });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/export`;
  try {
    assert.equal((await post(root, input)).statusCode, 401);
    const gm = cookieOf(await post("access/setup", { key, name: "GM" }));
    const code = (await post("access/invitations", {}, gm)).json().token;
    const player = cookieOf(
      await post("access/join", { code, name: "Player" }),
    );
    assert.equal((await post(root, input, player)).statusCode, 403);
    assert.equal(
      (await post(root, input, gm, "https://foreign.invalid")).statusCode,
      403,
    );
    assert.equal((await post(root, {}, gm)).statusCode, 400);
    assert.equal(
      (await post(root, { ...input, expectedVersion: 99 }, gm)).statusCode,
      409,
    );
    assert.equal(
      (await post(`campaigns/${randomUUID()}/export`, input, gm)).statusCode,
      409,
    );
    const response = await post(root, input, gm);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.match(
      String(response.headers["content-disposition"]),
      /^attachment; filename="tableloom-campaign-[a-f0-9-]+\.json"$/,
    );
    assert.equal(response.json().campaign.id, DEFAULT_CAMPAIGN_ID);
    assert.ok(!response.body.includes(key));
  } finally {
    await app.close();
  }
});

test("export uses one WAL read snapshot while a second connection commits new campaign data", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-export-snapshot-"));
  const path = join(directory, "table.sqlite"),
    f = fixture(path),
    writer = new DatabaseSync(path);
  try {
    const get = f.tables.getCampaign.bind(f.tables);
    let edited = false;
    f.tables.getCampaign = (id = DEFAULT_CAMPAIGN_ID) => {
      const campaign = get(id);
      if (!edited) {
        edited = true;
        writer.exec(
          "UPDATE campaign_records SET json=json_set(json,'$.name','AFTER SNAPSHOT')",
        );
      }
      return campaign;
    };
    const archive = JSON.parse(
      exportCampaign(f.db, f.tables, f.catalog, f.gm.member, input),
    );
    assert.equal(archive.campaign.name, "The gathering place");
    assert.equal(
      JSON.parse(archive.records.campaign_records[0].json).name,
      "The gathering place",
    );
    assert.equal(get().name, "AFTER SNAPSHOT");
  } finally {
    writer.close();
    f.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
