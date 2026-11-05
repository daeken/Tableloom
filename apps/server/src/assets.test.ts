import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, randomFillSync } from "node:crypto";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { AssetStore } from "./assets.js";
import { pngFixture, pngChunk } from "./png-fixture.js";
const KEY = "tableloom-assets-test-private-host-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Player",
    ),
    assets = new AssetStore(db);
  return { db, tables, access, gm, player, assets };
}

test("private immutable assets validate/sanitize bytes, page metadata without blobs, and enforce persisted campaign GM access", () => {
  const f = fixture();
  try {
    const bytes = pngFixture(32, 24, {
        extra: pngChunk("tEXt", Buffer.from("notes\0Private hidden text")),
      }),
      a = f.assets.upload(f.gm.member, "../map <room>.png", bytes),
      b = f.assets.upload(f.gm.member, "Second map", pngFixture());
    const first = f.assets.list(f.gm.member, undefined, 1);
    assert.equal(first.assets.length, 1);
    assert.equal(first.totalCount, 2);
    assert.ok(first.nextCursor);
    const second = f.assets.list(f.gm.member, first.nextCursor!, 1);
    assert.equal(second.assets.length, 1);
    assert.notEqual(second.assets[0]!.id, first.assets[0]!.id);
    assert.equal(second.nextCursor, null);
    assert.ok(!JSON.stringify(first).includes('bytes"'));
    assert.deepEqual(f.assets.content(f.gm.member, a.id).bytes, pngFixture());
    assert.equal(a.byteLength, pngFixture().length);
    assert.equal(a.name, "../map <room>.png");
    assert.throws(() => f.assets.upload(f.player.member, "Forged", bytes));
    assert.throws(() => f.assets.list(f.player.member));
    assert.throws(() => f.assets.content(f.player.member, a.id), /unavailable/);
    assert.throws(() => f.assets.delete(f.player.member, a.id));
    const other = f.tables.createCampaign({
        name: "Other",
        description: "",
        system: { id: "kids-on-bikes", version: "0.1.0" },
        contentPacks: [],
      }),
      otherGM = f.access.registerCampaign(f.gm.token, other.id);
    assert.equal(f.assets.list(otherGM).assets.length, 0);
    assert.throws(() => f.assets.content(otherGM, a.id), /unavailable/);
    assert.throws(() => f.assets.delete(otherGM, a.id), /unavailable/);
    f.db
      .prepare(
        "UPDATE access_memberships SET role='player' WHERE user_id=? AND table_id=?",
      )
      .run(f.gm.member.id, f.gm.member.tableId);
    assert.throws(
      () => f.assets.content({ ...f.gm.member, role: "gm" }, b.id),
      /unavailable/,
    );
    assert.throws(() =>
      f.assets.upload({ ...f.gm.member, role: "gm" }, "Stale GM", bytes),
    );
  } finally {
    f.db.close();
  }
});

test("asset quotas, rejected inputs and failed writes leave the library unchanged; deletion frees capacity", () => {
  const f = fixture();
  try {
    const first = f.assets.upload(f.gm.member, "Map", pngFixture()),
      rows = () =>
        f.db.prepare("SELECT * FROM campaign_assets ORDER BY id").all(),
      before = rows();
    assert.throws(() => f.assets.upload(f.gm.member, " ", pngFixture()));
    assert.throws(() =>
      f.assets.upload(f.gm.member, "Invalid", Buffer.from("bad")),
    );
    assert.deepEqual(rows(), before);
    f.db.exec(
      "CREATE TRIGGER reject_asset BEFORE INSERT ON campaign_assets BEGIN SELECT RAISE(ABORT,'fixture asset failure'); END;",
    );
    assert.throws(
      () => f.assets.upload(f.gm.member, "Failed", pngFixture()),
      /fixture asset failure/,
    );
    assert.deepEqual(rows(), before);
    f.db.exec("DROP TRIGGER reject_asset");
    const raw = randomFillSync(Buffer.alloc((1024 * 4 + 1) * 1278));
    for (let y = 0; y < 1278; y++) raw[y * (1024 * 4 + 1)] = 0;
    const large = pngFixture(1024, 1278, { raw }),
      largeAsset = f.assets.upload(f.gm.member, "Large map", large);
    const insert = f.db.prepare(
      "INSERT INTO campaign_assets SELECT ?,campaign_id,name,byte_length,width,height,created_at,sha256,bytes FROM campaign_assets WHERE id=?",
    );
    const copies =
      Math.floor(
        (100 * 1024 * 1024 - first.byteLength) / largeAsset.byteLength,
      ) - 1;
    for (let i = 0; i < copies; i++) insert.run(randomUUID(), largeAsset.id);
    assert.throws(
      () => f.assets.upload(f.gm.member, "Over byte quota", large),
      /asset limit/,
    );
    f.db.prepare("DELETE FROM campaign_assets WHERE id<>?").run(first.id);
    for (let i = 0; i < 199; i++)
      f.assets.upload(f.gm.member, `Map ${i}`, pngFixture());
    assert.throws(
      () => f.assets.upload(f.gm.member, "Over count", pngFixture()),
      /asset limit/,
    );
    f.assets.delete(f.gm.member, first.id);
    assert.equal(f.assets.list(f.gm.member).totalCount, 199);
    f.assets.upload(f.gm.member, "Replacement", pngFixture());
    assert.equal(f.assets.list(f.gm.member).totalCount, 200);
  } finally {
    f.db.close();
  }
});

test("unknown/incomplete asset storage and inconsistent persisted content fail closed without reseeding", () => {
  const f = fixture();
  try {
    const asset = f.assets.upload(f.gm.member, "Map", pngFixture());
    f.db
      .prepare("UPDATE campaign_assets SET bytes=? WHERE id=?")
      .run(Buffer.from("corrupt"), asset.id);
    assert.throws(
      () => f.assets.content(f.gm.member, asset.id),
      /inconsistent/,
    );
    f.db.exec("UPDATE asset_storage_version SET version=99");
    assert.throws(() => new AssetStore(f.db));
    assert.equal(
      f.db.prepare("SELECT version FROM asset_storage_version").get()!.version,
      99,
    );
    f.db.exec("DROP TABLE asset_storage_version");
    assert.throws(() => new AssetStore(f.db), /missing its schema version/);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM campaign_assets").get()!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});
