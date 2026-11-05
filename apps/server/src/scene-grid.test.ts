import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_GRID,
  gridSettingsSchema,
  gridUpdateSchema,
  sceneGridSchema,
} from "@tableloom/core/scene-grid";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { SceneGridStore } from "./scene-grid.js";
const KEY = "tableloom-grid-private-test-host-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Player",
    ),
    grids = new SceneGridStore(db, tables);
  return { db, tables, access, gm, player, grids };
}
const settings = {
  spacing: 80.5,
  origin: { x: -12.25, y: 33.75 },
  visible: false,
};
test("shared grids keep public defaults, version only their scene, enforce persisted GM role and reject stale/no-op/forged settings", () => {
  const f = fixture();
  try {
    const before = f.tables.load(),
      initial = f.grids.controls(f.gm.member),
      input = { context: initial.context, expectedVersion: 0, settings };
    assert.deepEqual(initial.settings, DEFAULT_GRID);
    assert.equal(initial.version, 0);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM scene_grids").get()!.n,
      0,
    );
    assert.deepEqual(f.grids.project(f.player.member), {
      version: 0,
      settings: DEFAULT_GRID,
    });
    assert.throws(
      () => f.grids.update({ ...f.player.member, role: "gm" }, input),
      /Only the GM/,
    );
    const changed = f.grids.update(f.gm.member, input);
    assert.equal(changed.version, 1);
    assert.deepEqual(f.grids.project(f.player.member), {
      version: 1,
      settings,
    });
    assert.deepEqual(f.tables.load(), before);
    assert.throws(() => f.grids.update(f.gm.member, input), /grid changed/);
    assert.throws(
      () => f.grids.update(f.gm.member, { ...input, expectedVersion: 1 }),
      /Change the grid/,
    );
    assert.throws(() =>
      f.grids.update(f.gm.member, { ...input, expectedVersion: 1, role: "gm" }),
    );
    assert.deepEqual(
      new SceneGridStore(f.db, f.tables).controls(f.gm.member),
      changed,
    );
    f.access.removeMember(f.gm.token, f.player.member.id);
    assert.throws(() => f.grids.controls(f.player.member), /Sign in/);
  } finally {
    f.db.close();
  }
});
test("offstage scenes retain independent grids and context generations prevent away-and-back saves; writes roll back atomically", () => {
  const f = fixture();
  try {
    const initial = f.grids.controls(f.gm.member),
      first = f.grids.update(f.gm.member, {
        context: initial.context,
        expectedVersion: 0,
        settings,
      }),
      scene = f.tables.createScene(initial.context.campaignId, {
        name: "Offstage",
      });
    f.tables.activateScene(
      initial.context.campaignId,
      scene.id,
      initial.context.generation,
    );
    const next = f.grids.controls(f.gm.member);
    assert.equal(next.version, 0);
    assert.deepEqual(next.settings, DEFAULT_GRID);
    assert.throws(
      () =>
        f.grids.update(f.gm.member, {
          context: initial.context,
          expectedVersion: 1,
          settings: DEFAULT_GRID,
        }),
      /active scene changed/,
    );
    f.grids.update(f.gm.member, {
      context: next.context,
      expectedVersion: 0,
      settings: { ...settings, spacing: 120 },
    });
    f.tables.activateScene(
      initial.context.campaignId,
      initial.context.sceneId,
      next.context.generation,
    );
    assert.deepEqual(f.grids.project(f.gm.member), {
      version: first.version,
      settings,
    });
    assert.throws(
      () =>
        f.grids.update(f.gm.member, {
          context: initial.context,
          expectedVersion: 1,
          settings: DEFAULT_GRID,
        }),
      /active scene changed/,
    );
    const current = f.grids.controls(f.gm.member);
    f.db.exec(
      "CREATE TRIGGER reject_grid BEFORE UPDATE ON scene_grids BEGIN SELECT RAISE(ABORT,'grid rollback'); END",
    );
    assert.throws(
      () =>
        f.grids.update(f.gm.member, {
          context: current.context,
          expectedVersion: 1,
          settings: DEFAULT_GRID,
        }),
      /grid rollback/,
    );
    assert.deepEqual(f.grids.controls(f.gm.member), current);
    f.db.exec("DROP TRIGGER reject_grid");
    assert.equal(
      f.grids.update(f.gm.member, {
        context: current.context,
        expectedVersion: 1,
        settings: DEFAULT_GRID,
      }).version,
      2,
    );
    // Corruption in a hidden scene fails startup rather than leaking/replacing it.
    f.db
      .prepare("UPDATE scene_grids SET settings_json=? WHERE scene_id=?")
      .run(
        JSON.stringify({ ...settings, secret: "not a grid field" }),
        scene.id,
      );
    assert.throws(() => new SceneGridStore(f.db, f.tables));
  } finally {
    f.db.close();
  }
});
test("grid storage initialization is additive, strictly marked, and transactional; malformed versions and orphan/incomplete storage fail", () => {
  const f = fixture();
  try {
    const bytes = f.db
      .prepare("SELECT state_json FROM scene_records ORDER BY id")
      .all();
    new SceneGridStore(f.db, f.tables);
    assert.deepEqual(
      f.db.prepare("SELECT state_json FROM scene_records ORDER BY id").all(),
      bytes,
    );
    f.db.exec("UPDATE scene_grid_version SET version=2");
    assert.throws(() => new SceneGridStore(f.db, f.tables));
    f.db.exec(
      "UPDATE scene_grid_version SET version=1; DROP TABLE scene_grids",
    );
    assert.throws(() => new SceneGridStore(f.db, f.tables), /incomplete/);
    f.db.exec(
      "DROP TABLE scene_grid_version; CREATE TABLE scene_grids(x TEXT)",
    );
    assert.throws(
      () => new SceneGridStore(f.db, f.tables),
      /missing its version/,
    );
    f.db.exec(
      "DROP TABLE scene_grids; CREATE VIEW scene_grids AS SELECT 1 AS x",
    );
    assert.throws(() => new SceneGridStore(f.db, f.tables));
    assert.equal(
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='scene_grid_version'",
        )
        .get(),
      undefined,
    );
    f.db.exec("DROP VIEW scene_grids");
    new SceneGridStore(f.db, f.tables);
    const c = f.grids.controls(f.gm.member).context;
    assert.throws(
      () =>
        f.db
          .prepare("INSERT INTO scene_grids VALUES(?,?,1,?)")
          .run(c.campaignId, crypto.randomUUID(), JSON.stringify(settings)),
      /FOREIGN KEY/,
    );
  } finally {
    f.db.close();
  }
});
test("grid settings reject nonfinite, over/under-bound, cross-kind, missing and extra data at command and storage boundaries", () => {
  for (const spacing of [NaN, Infinity, -Infinity, 0, 9.99, 500.01])
    assert.equal(
      gridSettingsSchema.safeParse({ ...settings, spacing }).success,
      false,
    );
  for (const origin of [
    { x: Infinity, y: 0 },
    { x: 0, y: -10001 },
    { x: 0, y: 0, z: 0 },
  ])
    assert.equal(
      gridSettingsSchema.safeParse({ ...settings, origin }).success,
      false,
    );
  for (const extra of [
    { visible: "gm" },
    { spacing: "60" },
    { type: "hex" },
    { snap: true },
  ])
    assert.equal(
      gridSettingsSchema.safeParse({ ...settings, ...extra }).success,
      false,
    );
  assert.equal(
    gridSettingsSchema.safeParse({
      spacing: 10,
      origin: { x: 10000, y: -10000 },
      visible: true,
    }).success,
    true,
  );
  assert.equal(
    gridSettingsSchema.safeParse({ ...settings, spacing: 500 }).success,
    true,
  );
  assert.equal(
    sceneGridSchema.safeParse({
      version: Number.MAX_SAFE_INTEGER + 1,
      settings,
    }).success,
    false,
  );
  assert.equal(
    gridUpdateSchema.safeParse({ expectedVersion: 0, settings }).success,
    false,
  );
});
