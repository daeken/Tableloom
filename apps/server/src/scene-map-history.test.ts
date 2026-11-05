import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { AssetStore } from "./assets.js";
import { SceneMapStore } from "./scene-map.js";
import { pngFixture } from "./png-fixture.js";
const KEY = "tableloom-map-history-fixture-private-key";
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
    asset = assets.upload(gm.member, "First", pngFixture(320, 240));
  const state = () => maps.controls(gm.member);
  const set = (width = 400, assetId = asset.id) =>
    maps.set(gm.member, {
      context: state().context,
      expectedVersion: state().version,
      assetId,
      position: { x: 60, y: 80 },
      width,
    });
  const visibility = (value: "gm" | "public") =>
    maps.visibility(gm.member, {
      context: state().context,
      expectedVersion: state().version,
      visibility: value,
      acknowledgeReveal: true,
    });
  const travel = (direction: "undo" | "redo", acknowledgeReveal = true) =>
    maps.travel(
      gm.member,
      {
        context: state().context,
        expectedVersion: state().version,
        entryId: state().history[direction]!.id,
        ...(acknowledgeReveal ? { acknowledgeReveal: true } : {}),
      },
      direction,
    );
  const clear = () =>
    maps.clearHistory(gm.member, {
      context: state().context,
      expectedVersion: state().version,
      acknowledgeClear: true,
    });
  return {
    db,
    tables,
    access,
    gm,
    player,
    assets,
    maps,
    asset,
    state,
    set,
    visibility,
    travel,
    clear,
  };
}
test("shared GM map history restores exact transforms/sources/visibility through removal, rotates access keys, survives reopen, and protects all inverse assets", () => {
  const f = fixture();
  try {
    const core = f.tables.load(),
      a = f.set(400.125),
      b = f.set(553.625);
    const second = f.assets.upload(f.gm.member, "Second", pngFixture(240, 320));
    f.visibility("public");
    const publicMap = f.state().map!;
    f.set(300, second.id);
    f.maps.remove(f.gm.member, {
      context: f.state().context,
      expectedVersion: f.state().version,
    });
    assert.equal(f.state().history.count, 5);
    assert.equal(f.state().map, null);
    for (const id of [f.asset.id, second.id]) {
      assert.throws(
        () => f.assets.delete(f.gm.member, id),
        /retained map history/,
      );
      assert.throws(
        () => f.db.prepare("DELETE FROM campaign_assets WHERE id=?").run(id),
        /FOREIGN KEY/,
      );
    }
    const restored = f.travel("undo");
    assert.equal(restored.map!.assetId, second.id);
    assert.equal(restored.map!.visibility, "gm");
    const before = f.state();
    assert.throws(() => f.travel("undo", false), /Confirm/);
    assert.deepEqual(f.state(), before);
    const original = f.travel("undo");
    assert.equal(original.map!.assetId, f.asset.id);
    assert.equal(original.map!.visibility, "public");
    assert.equal(original.map!.width, b.map!.width);
    assert.equal(original.map!.height, b.map!.height);
    assert.notEqual(original.map!.imageId, publicMap.imageId);
    assert.throws(
      () =>
        f.assets.contentForScene(
          f.player.member,
          original.context.sceneId,
          publicMap.imageId,
        ),
      /unavailable/,
    );
    assert.deepEqual(
      f.assets.contentForScene(
        f.player.member,
        original.context.sceneId,
        original.map!.imageId,
      ).bytes,
      pngFixture(320, 240),
    );
    f.travel("undo"); // undo reveal
    assert.equal(f.maps.project(f.player.member).background, null);
    f.travel("undo");
    assert.equal(f.state().map!.width, a.map!.width);
    f.travel("undo");
    assert.equal(f.state().map, null);
    assert.equal(f.state().history.undo, null);
    for (let i = 0; i < 5; i++) f.travel("redo");
    assert.equal(f.state().map, null);
    assert.equal(f.state().history.redo, null);
    assert.deepEqual(
      new SceneMapStore(f.db, f.tables, f.assets).controls(f.gm.member),
      f.state(),
    );
    assert.deepEqual(f.tables.load(), core);
    const version = f.state().version;
    f.clear();
    assert.equal(f.state().version, version + 1);
    assert.equal(f.state().history.count, 0);
    for (const id of [f.asset.id, second.id]) f.assets.delete(f.gm.member, id);
  } finally {
    f.db.close();
  }
});
test("history checks persisted permission, exact edge/version/context, rejects forged bodies, and rolls back state/cursors/references on failures", () => {
  const f = fixture();
  try {
    f.set();
    f.set(500);
    const captured = f.state(),
      command = {
        context: captured.context,
        expectedVersion: captured.version,
        entryId: captured.history.undo!.id,
      };
    for (const body of [
      { ...command, entryId: randomUUID() },
      { ...command, expectedVersion: 0 },
      { ...command, context: { ...command.context, generation: 999 } },
      { ...command, map: null },
    ]) {
      assert.throws(() => f.maps.travel(f.gm.member, body, "undo"));
      assert.deepEqual(f.state(), captured);
    }
    assert.throws(
      () => f.maps.travel({ ...f.player.member, role: "gm" }, command, "undo"),
      /Only the GM/,
    );
    assert.throws(() =>
      f.maps.clearHistory(f.player.member, {
        ...command,
        acknowledgeClear: true,
      }),
    );
    // Another GM/tab's accepted map edit invalidates the captured inverse.
    f.visibility("public");
    assert.throws(() => f.maps.travel(f.gm.member, command, "undo"), /changed/);
    const before = f.state();
    f.db.exec(
      "CREATE TRIGGER reject_map_history BEFORE INSERT ON scene_background_history BEGIN SELECT RAISE(ABORT,'fixture history failure'); END",
    );
    assert.throws(() => f.set(600), /fixture history failure/);
    assert.deepEqual(f.state(), before);
    f.db.exec(
      "DROP TRIGGER reject_map_history; CREATE TRIGGER reject_map_state BEFORE UPDATE ON scene_backgrounds BEGIN SELECT RAISE(ABORT,'fixture map failure'); END",
    );
    assert.throws(() => f.travel("undo"), /fixture map failure/);
    assert.deepEqual(f.state(), before);
    assert.throws(() => f.clear(), /fixture map failure/);
    assert.deepEqual(f.state(), before);
    f.db.exec("DROP TRIGGER reject_map_state");
    f.travel("undo");
    f.set(650);
    assert.equal(f.state().history.redo, null);
    f.clear();
    assert.throws(() => f.clear(), /no map history/);
    assert.throws(
      () => f.assets.delete(f.gm.member, f.asset.id),
      /every scene map/,
    );
  } finally {
    f.db.close();
  }
});
test("map history trims at 100 complete entries, drops abandoned redo references, and keeps independent offstage scenes protected", () => {
  const f = fixture();
  try {
    f.set();
    for (let i = 0; i < 105; i++) f.set(401 + i);
    assert.equal(f.state().history.count, 100);
    for (let i = 0; i < 100; i++) f.travel("undo");
    assert.equal(f.state().history.undo, null);
    assert.equal(f.state().map!.width, 405);
    for (let i = 0; i < 100; i++) f.travel("redo");
    const discarded = f.assets.upload(
      f.gm.member,
      "Discarded branch",
      pngFixture(),
    );
    f.set(300, discarded.id);
    f.travel("undo");
    f.set(700);
    f.assets.delete(f.gm.member, discarded.id);
    const initial = f.state(),
      next = f.tables.createScene(f.gm.member.tableId, { name: "Offstage" });
    f.maps.remove(f.gm.member, {
      context: initial.context,
      expectedVersion: initial.version,
    });
    f.tables.activateScene(
      f.gm.member.tableId,
      next.id,
      f.tables.getCampaign().version,
    );
    assert.equal(f.state().history.count, 0);
    assert.throws(
      () => f.assets.delete(f.gm.member, f.asset.id),
      /retained map history/,
    );
    f.tables.activateScene(
      f.gm.member.tableId,
      initial.context.sceneId,
      f.tables.getCampaign().version,
    );
    assert.throws(
      () =>
        f.maps.travel(
          f.gm.member,
          {
            context: initial.context,
            expectedVersion: f.state().version,
            entryId: f.state().history.undo!.id,
          },
          "undo",
        ),
      /active scene changed/,
    );
    f.clear();
    f.assets.delete(f.gm.member, f.asset.id);
  } finally {
    f.db.close();
  }
});
function downgrade(f: ReturnType<typeof fixture>) {
  f.db.exec(
    "DROP TABLE scene_background_history_refs; DROP TABLE scene_background_history; ALTER TABLE scene_backgrounds DROP COLUMN history_cursor; UPDATE scene_background_version SET version=1",
  );
}
test("background schema 1 upgrades atomically without inventing old history; hidden corrupt data and marker failures roll back DDL", () => {
  for (const failure of ["none", "corrupt", "marker"] as const) {
    const f = fixture();
    try {
      const placed = f.set(),
        next = f.tables.createScene(f.gm.member.tableId, {
          name: "Active empty",
        });
      f.tables.activateScene(
        f.gm.member.tableId,
        next.id,
        f.tables.getCampaign().version,
      );
      downgrade(f);
      if (failure === "corrupt")
        f.db.prepare("UPDATE scene_backgrounds SET map_json='{}'").run();
      if (failure === "marker")
        f.db.exec(
          "CREATE TRIGGER reject_background_marker BEFORE UPDATE ON scene_background_version BEGIN SELECT RAISE(ABORT,'fixture marker failure'); END",
        );
      if (failure !== "none") {
        assert.throws(() => new SceneMapStore(f.db, f.tables, f.assets));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_background_version").get()!
            .version,
          1,
        );
        assert.equal(
          f.db
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE name='scene_background_history'",
            )
            .get(),
          undefined,
        );
        assert.ok(
          !f.db
            .prepare("PRAGMA table_info(scene_backgrounds)")
            .all()
            .some((r) => r.name === "history_cursor"),
        );
      } else {
        const upgraded = new SceneMapStore(f.db, f.tables, f.assets);
        assert.equal(
          f.db.prepare("SELECT version FROM scene_background_version").get()!
            .version,
          2,
        );
        assert.equal(upgraded.controls(f.gm.member).history.count, 0);
        f.tables.activateScene(
          f.gm.member.tableId,
          placed.context.sceneId,
          f.tables.getCampaign().version,
        );
        assert.deepEqual(upgraded.controls(f.gm.member).map, placed.map);
        assert.equal(upgraded.controls(f.gm.member).version, placed.version);
        assert.equal(upgraded.controls(f.gm.member).history.undo, null);
      }
    } finally {
      f.db.close();
    }
  }
});
test("current map history rejects corrupted cursor/chain/reference payloads and incomplete storage without reseeding", () => {
  for (const corrupt of [
    "cursor",
    "chain",
    "reference",
    "payload",
    "incomplete",
  ] as const) {
    const f = fixture();
    try {
      f.set();
      f.set(500);
      if (corrupt === "cursor")
        f.db.exec("UPDATE scene_backgrounds SET history_cursor=999");
      if (corrupt === "chain")
        f.db.exec(
          "UPDATE scene_background_history SET entry_json=json_set(entry_json,'$.after.width',111) WHERE seq=1",
        );
      if (corrupt === "reference")
        f.db.exec(
          "DELETE FROM scene_background_history_refs WHERE entry_id=(SELECT id FROM scene_background_history LIMIT 1)",
        );
      if (corrupt === "payload")
        f.db.exec(
          "UPDATE scene_background_history SET entry_json=json_set(entry_json,'$.extra',true)",
        );
      if (corrupt === "incomplete")
        f.db.exec("DROP TABLE scene_background_history_refs");
      assert.throws(() => new SceneMapStore(f.db, f.tables, f.assets));
      assert.equal(
        f.db.prepare("SELECT version FROM scene_background_version").get()!
          .version,
        2,
      );
      if (corrupt !== "incomplete") assert.throws(() => f.state());
    } finally {
      f.db.close();
    }
  }
});

test("map history campaign byte limits reject and roll back new state/history/references together", () => {
  const f = fixture();
  try {
    f.set();
    const before = f.state();
    f.db.exec(
      "CREATE TRIGGER inflate_map_history AFTER INSERT ON scene_background_history BEGIN UPDATE scene_background_history SET entry_json=entry_json || printf('%*s',8388608,'') WHERE id=new.id; END",
    );
    assert.throws(() => f.set(500), /Map history is full/);
    assert.deepEqual(f.state(), before);
    assert.equal(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM scene_background_history_refs")
        .get()!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});
