import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { AssetStore } from "./assets.js";
import { SceneMapStore } from "./scene-map.js";
import { pngFixture } from "./png-fixture.js";
const KEY = "tableloom-map-test-private-host-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Player",
    ),
    assets = new AssetStore(db),
    maps = new SceneMapStore(db, tables, assets),
    asset = assets.upload(gm.member, "Unrevealed map", pngFixture(320, 240));
  return { db, tables, access, gm, player, assets, maps, asset };
}

test("map placement is private, aspect-preserving and versioned; reveal requires acknowledgement and asset replacement returns to private", () => {
  const f = fixture();
  try {
    const initial = f.maps.controls(f.gm.member),
      set = {
        context: initial.context,
        expectedVersion: 0,
        assetId: f.asset.id,
        position: { x: 60, y: 80 },
        width: 600,
      },
      before = f.tables.load();
    const first = f.maps.set(f.gm.member, set);
    assert.equal(first.version, 1);
    assert.equal(first.map!.height, 450);
    assert.equal(first.map!.visibility, "gm");
    assert.deepEqual(f.maps.project(f.player.member), {
      background: null,
      backgroundVersion: null,
    });
    assert.equal(f.maps.project(f.gm.member).backgroundVersion, 1);
    assert.throws(
      () =>
        f.assets.contentForScene(
          f.player.member,
          first.context.sceneId,
          first.map!.imageId,
        ),
      /unavailable/,
    );
    assert.throws(
      () =>
        f.maps.visibility(f.gm.member, {
          context: first.context,
          expectedVersion: 1,
          visibility: "public",
        }),
      /Confirm/,
    );
    const publicMap = f.maps.visibility(f.gm.member, {
      context: first.context,
      expectedVersion: 1,
      visibility: "public",
      acknowledgeReveal: true,
    });
    assert.equal(
      f.maps.project(f.player.member).background!.imageId,
      publicMap.map!.imageId,
    );
    assert.ok(
      !JSON.stringify(f.maps.project(f.player.member)).includes(f.asset.id),
    );
    assert.deepEqual(
      f.assets.contentForScene(
        f.player.member,
        first.context.sceneId,
        first.map!.imageId,
      ).bytes,
      pngFixture(320, 240),
    );
    const edited = f.maps.set(f.gm.member, {
      ...set,
      expectedVersion: 2,
      width: 400,
    });
    assert.equal(edited.map!.visibility, "public");
    assert.equal(edited.map!.imageId, first.map!.imageId);
    const other = f.assets.upload(
        f.gm.member,
        "Next unrevealed map",
        pngFixture(240, 320),
      ),
      replacement = f.maps.set(f.gm.member, {
        ...set,
        expectedVersion: 3,
        assetId: other.id,
      });
    assert.equal(replacement.map!.height, 800);
    assert.equal(replacement.map!.visibility, "gm");
    assert.notEqual(replacement.map!.imageId, first.map!.imageId);
    assert.throws(
      () =>
        f.assets.contentForScene(
          f.player.member,
          first.context.sceneId,
          first.map!.imageId,
        ),
      /unavailable/,
    );
    assert.deepEqual(f.maps.project(f.player.member), {
      background: null,
      backgroundVersion: null,
    });
    assert.deepEqual(f.tables.load(), before);
    assert.equal(f.assets.list(f.gm.member).totalCount, 2);
  } finally {
    f.db.close();
  }
});

test("map context/version/permission/geometry guards and failed writes leave all state untouched; remove keeps a tombstone version", () => {
  const f = fixture();
  try {
    const initial = f.maps.controls(f.gm.member),
      command = {
        context: initial.context,
        expectedVersion: 0,
        assetId: f.asset.id,
        position: { x: 0, y: 0 },
        width: 400,
      };
    const first = f.maps.set(f.gm.member, command),
      before = f.maps.controls(f.gm.member);
    for (const input of [
      { ...command },
      { ...command, expectedVersion: 1 },
      { ...command, expectedVersion: 1, position: { x: 9999, y: 0 } },
      { ...command, expectedVersion: 1, width: NaN },
      { ...command, expectedVersion: 1, assetId: crypto.randomUUID() },
      { ...command, context: { ...command.context, generation: 999 } },
      { ...command, visibility: "public" },
      { ...command, imageId: crypto.randomUUID() },
    ]) {
      assert.throws(() => f.maps.set(f.gm.member, input));
      assert.deepEqual(f.maps.controls(f.gm.member), before);
    }
    assert.throws(
      () =>
        f.maps.set(
          { ...f.player.member, role: "gm" },
          { ...command, expectedVersion: 1, width: 500 },
        ),
      /Only the GM/,
    );
    assert.throws(
      () =>
        f.assets.contentForScene(
          { ...f.player.member, role: "gm" },
          initial.context.sceneId,
          first.map!.imageId,
        ),
      /unavailable/,
    );
    f.db.exec(
      "CREATE TRIGGER reject_background BEFORE UPDATE ON scene_backgrounds BEGIN SELECT RAISE(ABORT,'fixture background failure'); END;",
    );
    assert.throws(
      () =>
        f.maps.set(f.gm.member, { ...command, expectedVersion: 1, width: 500 }),
      /fixture background failure/,
    );
    assert.deepEqual(f.maps.controls(f.gm.member), before);
    f.db.exec("DROP TRIGGER reject_background");
    const removed = f.maps.remove(f.gm.member, {
      context: initial.context,
      expectedVersion: 1,
    });
    assert.equal(removed.version, 2);
    assert.equal(removed.map, null);
    assert.throws(() => f.maps.set(f.gm.member, command), /changed/);
    const restored = f.maps.set(f.gm.member, {
      ...command,
      expectedVersion: 2,
    });
    assert.equal(restored.version, 3);
    assert.notEqual(restored.map!.imageId, first.map!.imageId);
    assert.throws(
      () =>
        f.assets.contentForScene(
          f.gm.member,
          initial.context.sceneId,
          first.map!.imageId,
        ),
      /unavailable/,
    );
    assert.deepEqual(
      new SceneMapStore(f.db, f.tables, f.assets).controls(f.gm.member),
      restored,
    );
  } finally {
    f.db.close();
  }
});

test("active and offstage references prevent asset deletion, foreign assets cannot attach, and away-and-back scene context remains stale", () => {
  const f = fixture();
  try {
    const initial = f.maps.controls(f.gm.member);
    f.maps.set(f.gm.member, {
      context: initial.context,
      expectedVersion: 0,
      assetId: f.asset.id,
      position: { x: 0, y: 0 },
      width: 400,
    });
    assert.throws(
      () => f.assets.delete(f.gm.member, f.asset.id),
      /every scene map/,
    );
    assert.throws(
      () =>
        f.db.prepare("DELETE FROM campaign_assets WHERE id=?").run(f.asset.id),
      /FOREIGN KEY/,
    );
    const next = f.tables.createScene(f.gm.member.tableId, {
      name: "Future scene",
    });
    f.tables.activateScene(
      f.gm.member.tableId,
      next.id,
      f.tables.getCampaign().version,
    );
    assert.throws(
      () => f.assets.delete(f.gm.member, f.asset.id),
      /every scene map/,
    );
    assert.equal(f.maps.project(f.player.member).background, null);
    const other = f.tables.createCampaign({
        name: "Other",
        description: "",
        system: { id: "kids-on-bikes", version: "0.1.0" },
        contentPacks: [],
      }),
      otherGM = f.access.registerCampaign(f.gm.token, other.id),
      foreign = f.assets.upload(otherGM, "Foreign", pngFixture());
    const current = f.maps.controls(f.gm.member);
    assert.throws(
      () =>
        f.maps.set(f.gm.member, {
          context: current.context,
          expectedVersion: 0,
          assetId: foreign.id,
          position: { x: 0, y: 0 },
          width: 300,
        }),
      /unavailable/,
    );
    f.tables.activateScene(
      f.gm.member.tableId,
      initial.context.sceneId,
      f.tables.getCampaign().version,
    );
    assert.throws(
      () =>
        f.maps.remove(f.gm.member, {
          context: initial.context,
          expectedVersion: 1,
        }),
      /active scene changed/,
    );
    const fresh = f.maps.controls(f.gm.member);
    f.maps.remove(f.gm.member, { context: fresh.context, expectedVersion: 1 });
    f.assets.delete(f.gm.member, f.asset.id);
    assert.equal(f.assets.list(f.gm.member).totalCount, 0);
  } finally {
    f.db.close();
  }
});

test("unknown/incomplete map storage and inconsistent persisted references fail closed", () => {
  const f = fixture();
  try {
    const initial = f.maps.controls(f.gm.member),
      placed = f.maps.set(f.gm.member, {
        context: initial.context,
        expectedVersion: 0,
        assetId: f.asset.id,
        position: { x: 0, y: 0 },
        width: 300,
      });
    f.db
      .prepare("UPDATE scene_backgrounds SET image_id=?")
      .run(crypto.randomUUID());
    assert.throws(() => f.maps.controls(f.gm.member), /references disagree/);
    f.db
      .prepare("UPDATE scene_backgrounds SET image_id=?")
      .run(placed.map!.imageId);
    f.db.exec("UPDATE scene_background_version SET version=99");
    assert.throws(() => new SceneMapStore(f.db, f.tables, f.assets));
    assert.equal(
      f.db.prepare("SELECT version FROM scene_background_version").get()!
        .version,
      99,
    );
    f.db.exec("DROP TABLE scene_background_version");
    assert.throws(
      () => new SceneMapStore(f.db, f.tables, f.assets),
      /missing its version/,
    );
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM scene_backgrounds").get()!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});
