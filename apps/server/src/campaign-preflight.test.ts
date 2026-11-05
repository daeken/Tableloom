import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, populate, key, input } from "./campaign-transfer-fixture.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import {
  parseCampaignTransfer,
  type CampaignTransfer,
} from "./campaign-transfer-format.js";
import {
  MAX_CAMPAIGN_EXPORT_BYTES,
  MAX_CAMPAIGN_EXPORT_ROWS,
} from "./campaign-export.js";
import { installedModules } from "./modules.js";
import { documentSystems } from "./document-modules.js";
import { ContentCatalog } from "./content-catalog.js";
import { createApp } from "./app.js";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";

type Fixture = ReturnType<typeof fixture>;
const inspect = (
  file: string,
  f: Fixture,
  catalog = f.catalog,
  systems = documentSystems,
) =>
  inspectCampaignTransfer(
    file,
    { systems: installedModules, contentPacks: catalog.metadata() },
    catalog,
    systems,
    f.db,
  );
const mutate = (file: string, change: (archive: CampaignTransfer) => void) => {
  const archive = parseCampaignTransfer(file);
  change(archive);
  return JSON.stringify(archive);
};

test("preflight inspects populated private exports without writes, exposes review-only ownership and package/collision summaries without private payloads", () => {
  const f = fixture();
  try {
    populate(f);
    const file = f.snapshot(),
      changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    const report = inspect(file, f);
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(f.db.isTransaction, false);
    assert.equal(report.status, "preflight-only");
    assert.equal(report.importReady, false);
    assert.equal(
      report.archiveSha256,
      createHash("sha256").update(file).digest("hex"),
    );
    assert.deepEqual(report.blockers, []);
    assert.equal(report.packages.system.status, "available");
    assert.equal(report.packages.contentPacks[0]!.status, "available");
    assert.equal(report.destination.campaignIdExists, true);
    assert.equal(report.destination.globalResourceIds.module_documents, 1);
    assert.equal(report.destination.globalResourceIds.content_instances, 1);
    assert.equal(report.destination.globalResourceIds.campaign_assets, 1);
    assert.equal(report.destination.globalResourceIds.scene_history_entries, 1);
    assert.equal(report.resourceCounts.scene_records, 2);
    assert.equal(report.ownership.policy, "explicit-mapping-required");
    assert.deepEqual(
      report.ownership.subjects.map((s) => s.sourceId).sort(),
      [f.gm.member.id, f.player.member.id].sort(),
    );
    const serialized = JSON.stringify(report);
    for (const secret of [
      key,
      f.gm.token,
      "PRIVATE FIELD",
      "PRIVATE OVERRIDE",
      "PRIVATE CHAT",
      "PRIVATE OFFSTAGE TOKEN",
      "UNRELATED PERSON",
    ])
      assert.ok(!serialized.includes(secret));
    assert.ok(report.pendingValidation.includes("atomic-import"));
  } finally {
    f.db.close();
  }
});

test("format and neutral resource checks reject unknown versions/fields, duplicated keys, foreign scopes, missing references and inconsistent histories", () => {
  const f = fixture();
  try {
    populate(f);
    const file = f.snapshot();
    const changes: ((archive: CampaignTransfer) => void)[] = [
      (a) => Object.assign(a, { version: 999 }),
      (a) => Object.assign(a, { executableSql: "DROP TABLE access_users" }),
      (a) => Object.assign(a.storageVersions, { scene_history_version: 999 }),
      (a) => a.members.push(a.members[0]!),
      (a) => a.records.scene_records.push(a.records.scene_records[0]!),
      (a) => {
        a.records.module_documents[0]!.campaign_id = randomUUID();
      },
      (a) => {
        a.campaign.activeSceneId = randomUUID();
      },
      (a) => {
        a.records.scene_records[0]!.json = "{}";
      },
      (a) => {
        a.records.scene_grids[0]!.scene_id = randomUUID();
      },
      (a) => {
        a.records.scene_background_history_refs = [];
      },
      (a) => {
        a.records.object_id_reservations = [];
      },
      (a) => {
        a.records.campaign_receipts = [];
      },
      (a) => {
        a.records.scene_history_entries[0]!.targets_json = "[]";
      },
      (a) => {
        a.records.chat_messages[0]!.bucket = "public";
      },
      (a) => {
        a.records.roll_archive[0]!.owner_id = null;
      },
      (a) => a.packages.contentPacks.push(a.packages.contentPacks[0]!),
      (a) => {
        a.packages.contentPacks[0]!.selected = false;
      },
      (a) => {
        a.records.content_instances[0]!.pack_version = "9.9.9";
      },
    ];
    for (const [index, change] of changes.entries())
      assert.throws(
        () => inspect(mutate(file, change), f),
        { name: "StoreError" },
        `tamper ${index}`,
      );
    assert.ok(inspect(file, f));
    assert.equal(f.db.isTransaction, false);
  } finally {
    f.db.close();
  }
});

test("asset and module checks reject changed/noncanonical bytes, invalid schemas and opaque oversized/deep data without invoking factories or migrations", () => {
  const f = fixture();
  try {
    populate(f);
    const file = f.snapshot();
    for (const change of [
      (a: CampaignTransfer) => {
        a.records.campaign_assets[0]!.bytes += "\n";
      },
      (a: CampaignTransfer) => {
        a.records.campaign_assets[0]!.sha256 = "0".repeat(64);
      },
      (a: CampaignTransfer) => {
        a.records.campaign_assets[0]!.width = 99999;
      },
      (a: CampaignTransfer) => {
        a.records.module_documents[0]!.data_json = '{"unknown":true}';
      },
      (a: CampaignTransfer) => {
        a.records.module_documents[0]!.data_json = JSON.stringify({
          notes: "x".repeat(65537),
        });
      },
      (a: CampaignTransfer) => {
        a.records.module_documents[0]!.data_json =
          "[".repeat(25) + "0" + "]".repeat(25);
      },
      (a: CampaignTransfer) => {
        a.records.content_instances[0]!.data_json =
          '{"label":"test","marked":"invalid"}';
      },
      (a: CampaignTransfer) => {
        a.records.content_overrides[0]!.data_json =
          '{"name":"changed","visibility":"gm","data":{},"sources":[]}';
      },
    ])
      assert.throws(() => inspect(mutate(file, change), f));
    let factoryCalls = 0;
    const catalog = new ContentCatalog([
      {
        ...f.pack,
        instances: {
          ...f.pack.instances!,
          create: () => {
            factoryCalls++;
            throw new Error("Must not execute");
          },
        },
      },
    ]);
    assert.deepEqual(inspect(file, f, catalog).blockers, []);
    assert.equal(factoryCalls, 0);
    const unsupported = inspect(
      mutate(file, (a) => {
        a.records.module_documents[0]!.schema_version = 2;
      }),
      f,
    );
    assert.ok(unsupported.blockers.includes("document_schema_unavailable"));
    assert.equal(unsupported.importReady, false);
    const unsupportedInstance = inspect(
      mutate(file, (a) => {
        a.records.content_instances[0]!.schema_version = 999;
      }),
      f,
    );
    assert.ok(
      unsupportedInstance.blockers.includes("instance_schema_unavailable"),
    );
  } finally {
    f.db.close();
  }
});

test("destination preflight reports missing/changed packages and stored fingerprint conflicts, preserving historical references and departed owners without identity matching", () => {
  const source = fixture(),
    destination = fixture();
  try {
    populate(source);
    source.db
      .prepare("DELETE FROM access_memberships WHERE user_id=? AND table_id=?")
      .run(source.player.member.id, DEFAULT_CAMPAIGN_ID);
    const historicalHash = "1".repeat(64);
    source.db
      .prepare("INSERT INTO content_pack_bindings VALUES(?,?,?)")
      .run("retired-paper", "0.9.0", historicalHash);
    source.db
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
    const file = source.snapshot();
    const report = inspect(file, destination);
    assert.deepEqual(report.blockers, []);
    assert.equal(
      report.packages.contentPacks.find((p) => !p.selected)!.status,
      "historical-only",
    );
    const owner = report.ownership.subjects.find(
      (s) => s.sourceId === source.player.member.id,
    )!;
    assert.equal(owner.name, null);
    assert.equal(owner.sourceRole, null);
    assert.ok(
      !report.ownership.subjects.some(
        (s) => s.sourceId === destination.player.member.id,
      ),
    );
    assert.equal(report.destination.globalResourceIds.module_documents, 0);
    const historicalCatalog = new ContentCatalog([
      source.pack,
      {
        ...source.pack,
        id: "retired-paper",
        version: "0.9.0",
        systemId: "kids-on-bikes",
      },
    ]);
    const historicalFile = mutate(file, (a) => {
      a.packages.contentPacks.find((p) => !p.selected)!.sha256 =
        historicalCatalog.packs.find(
          (p) => p.pack.id === "retired-paper",
        )!.digest;
    });
    const historical = inspect(historicalFile, destination, historicalCatalog);
    assert.deepEqual(historical.blockers, []);
    assert.equal(
      historical.packages.contentPacks.find((p) => !p.selected)!.status,
      "historical-only",
    );
    const missing = inspect(file, destination, new ContentCatalog([]), []);
    assert.ok(missing.blockers.includes("system_unavailable"));
    assert.ok(missing.blockers.includes("content_pack_unavailable"));
    const changed = inspect(
      mutate(file, (a) => {
        a.packages.contentPacks[0]!.sha256 = "0".repeat(64);
      }),
      destination,
    );
    assert.ok(changed.blockers.includes("content_pack_changed"));
    assert.ok(changed.blockers.includes("stored_pack_binding_changed"));
    destination.db
      .prepare("INSERT INTO content_pack_bindings VALUES(?,?,?)")
      .run("retired-paper", "0.9.0", "2".repeat(64));
    assert.ok(
      inspect(file, destination).blockers.includes(
        "stored_pack_binding_changed",
      ),
    );
  } finally {
    source.db.close();
    destination.db.close();
  }
});

test("file and total-row limits reject before record parsing; malformed files never echo supplied private content", () => {
  const f = fixture();
  try {
    const file = f.snapshot();
    assert.throws(
      () => parseCampaignTransfer(" ".repeat(MAX_CAMPAIGN_EXPORT_BYTES + 1)),
      /32 MiB/,
    );
    assert.throws(
      () => parseCampaignTransfer('{"PRIVATE ERROR CANARY"'),
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes("PRIVATE ERROR CANARY"),
    );
    const oversized = mutate(file, (a) => {
      a.records.object_id_reservations = Array.from(
        { length: MAX_CAMPAIGN_EXPORT_ROWS },
        () => ({ campaign_id: DEFAULT_CAMPAIGN_ID, id: randomUUID() }),
      );
    });
    assert.throws(
      () => parseCampaignTransfer(oversized),
      /invalid or unsupported/,
    );
  } finally {
    f.db.close();
  }
});

test("HTTP preflight authenticates the server host before parsing large bodies, enforces origin/UTF-8/limits and keeps normal JSON routes isolated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-preflight-http-")),
    databasePath = join(directory, "table.sqlite");
  const app = await createApp({ databasePath, hostKey: key }),
    db = new DatabaseSync(databasePath);
  const post = (
    path: string,
    payload: string | Buffer,
    cookie = "",
    origin = "http://localhost",
  ) =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: { cookie, origin, "content-type": "application/json" },
      payload,
    });
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers["set-cookie"]).split(";")[0]!;
  try {
    const gm = cookieOf(
      await post("access/setup", JSON.stringify({ key, name: "GM" })),
    );
    const invitation = (await post("access/invitations", "{}", gm)).json()
      .token;
    const joined = await post(
        "access/join",
        JSON.stringify({ code: invitation, name: "Player" }),
      ),
      player = cookieOf(joined);
    const root = "campaign-imports/preflight",
      huge = Buffer.alloc(MAX_CAMPAIGN_EXPORT_BYTES + 1);
    assert.equal((await post(root, huge)).statusCode, 401);
    assert.equal((await post(root, huge, player)).statusCode, 403);
    db.prepare("UPDATE access_memberships SET role='gm' WHERE user_id=?").run(
      joined.json().member.id,
    );
    assert.equal((await post(root, huge, player)).statusCode, 403);
    assert.equal(
      (await post(root, "{}", gm, "https://foreign.invalid")).statusCode,
      403,
    );
    assert.equal((await post(root, huge, gm)).statusCode, 413);
    assert.equal((await post(root, Buffer.from([0xff]), gm)).statusCode, 400);
    const exported = await post(
      `campaigns/${DEFAULT_CAMPAIGN_ID}/export`,
      JSON.stringify(input),
      gm,
    );
    assert.equal(exported.statusCode, 200);
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM campaign_records")
      .get()!.n;
    const response = await post(root, exported.body, gm);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.json().importReady, false);
    assert.equal(response.json().status, "preflight-only");
    assert.deepEqual(response.json().blockers, []);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM campaign_records").get()!.n,
      before,
    );
    assert.equal(
      (await post("access/logout", " ".repeat(300 * 1024), gm)).statusCode,
      413,
    );
    assert.equal((await post("access/logout", "{}", gm)).statusCode, 200);
    assert.equal((await post(root, exported.body, gm)).statusCode, 401);
  } finally {
    db.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
