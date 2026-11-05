import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, key } from "./campaign-transfer-fixture.js";
import {
  parseCampaignTransfer,
  type CampaignTransfer,
} from "./campaign-transfer-format.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import { installedModules } from "./modules.js";
import { documentSystems } from "./document-modules.js";
import { backgroundHistoryEntrySchema } from "./scene-map-history-model.js";
import { backgroundMapSchema } from "@tableloom/core/scene-map";
import { StoreError } from "./store.js";
import { pngFixture } from "./png-fixture.js";
import { createApp } from "./app.js";

function mapFixture() {
  const f = fixture(),
    asset = f.assets.upload(f.gm.member, "PRIVATE MAP CANARY", pngFixture());
  const state = () => f.maps.controls(f.gm.member);
  const set = (width: number) => {
    const s = state();
    return f.maps.set(f.gm.member, {
      context: s.context,
      expectedVersion: s.version,
      assetId: asset.id,
      position: { x: 60, y: 80 },
      width,
    });
  };
  const visibility = (visibility: "gm" | "public") => {
    const s = state();
    return f.maps.visibility(f.gm.member, {
      context: s.context,
      expectedVersion: s.version,
      visibility,
      acknowledgeReveal: true,
    });
  };
  const travel = (direction: "undo" | "redo") => {
    const s = state(),
      edge = s.history[direction];
    assert.ok(edge);
    return f.maps.travel(
      f.gm.member,
      {
        context: s.context,
        expectedVersion: s.version,
        entryId: edge.id,
        acknowledgeReveal: true,
      },
      direction,
    );
  };
  const inspect = (file = f.snapshot()) =>
    inspectCampaignTransfer(
      file,
      { systems: installedModules, contentPacks: f.catalog.metadata() },
      f.catalog,
      documentSystems,
      f.db,
    );
  const accepted = () => {
    const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    const report = inspect();
    assert.deepEqual(report.blockers, []);
    assert.equal(report.importReady, false);
    assert.ok(report.pendingValidation.includes("object-history-causal-graph"));
    assert.ok(!report.pendingValidation.includes("history-causal-graph"));
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(f.db.isTransaction, false);
    return report;
  };
  return { ...f, asset, state, set, visibility, travel, inspect, accepted };
}
function mutate(file: string, change: (archive: CampaignTransfer) => void) {
  const archive = parseCampaignTransfer(file);
  change(archive);
  return JSON.stringify(archive);
}

test("map preflight accepts live removal, undo/redo key rotation, cleared history and inactive private maps without writes", () => {
  const f = mapFixture();
  try {
    f.accepted();
    f.set(400);
    f.set(500);
    f.visibility("public");
    f.accepted();
    const s = f.state();
    f.maps.remove(f.gm.member, {
      context: s.context,
      expectedVersion: s.version,
    });
    assert.equal(f.state().map, null);
    f.accepted();
    const restored = f.travel("undo");
    const file = parseCampaignTransfer(f.snapshot()),
      latest = backgroundHistoryEntrySchema.parse(
        JSON.parse(file.records.scene_background_history.at(-1)!.entry_json),
      );
    assert.ok(restored.map && latest.before);
    assert.notEqual(restored.map.imageId, latest.before.imageId);
    f.accepted();
    f.travel("redo");
    f.accepted();
    f.travel("undo");
    f.visibility("gm");
    f.accepted();
    const c = f.state();
    f.maps.clearHistory(f.gm.member, {
      context: c.context,
      expectedVersion: c.version,
      acknowledgeClear: true,
    });
    assert.equal(f.state().history.count, 0);
    assert.ok(f.state().map);
    f.accepted();
    const campaign = f.tables.getCampaign(),
      second = f.tables.createScene(campaign.id, {
        name: "Empty active scene",
      });
    f.tables.activateScene(campaign.id, second.id, campaign.version);
    assert.equal(f.state().map, null);
    assert.equal(f.accepted().resourceCounts.scene_backgrounds, 1);
  } finally {
    f.db.close();
  }
});

test("map preflight accepts pruned prefixes, branch sequence gaps and reordered archive rows", () => {
  const f = mapFixture();
  try {
    for (let i = 0; i < 105; i++) f.set(400 + i);
    const original = parseCampaignTransfer(f.snapshot());
    assert.equal(original.records.scene_background_history.length, 100);
    assert.ok(original.records.scene_background_history[0]!.seq > 1);
    f.accepted();
    f.travel("undo");
    f.travel("undo");
    f.travel("redo");
    f.set(777);
    const branched = parseCampaignTransfer(f.snapshot()),
      entries = branched.records.scene_background_history;
    assert.ok(
      entries.some((entry, i) => i > 0 && entry.seq > entries[i - 1]!.seq + 1),
    );
    entries.reverse();
    assert.deepEqual(f.inspect(JSON.stringify(branched)).blockers, []);
    f.accepted();
  } finally {
    f.db.close();
  }
});

test("map preflight rejects invalid cursors, broken transitions, no-op key-only edges and saved maps that disagree with undo/redo history", () => {
  const f = mapFixture();
  try {
    f.set(400);
    f.set(500);
    f.visibility("public");
    const file = f.snapshot();
    const editEntry = (
      a: CampaignTransfer,
      i: number,
      edit: (
        entry: ReturnType<typeof backgroundHistoryEntrySchema.parse>,
      ) => void,
    ) => {
      const row = a.records.scene_background_history[i]!,
        entry = backgroundHistoryEntrySchema.parse(JSON.parse(row.entry_json));
      edit(entry);
      row.entry_json = JSON.stringify(entry);
    };
    const cases: ((archive: CampaignTransfer) => void)[] = [
      (a) => {
        a.records.scene_backgrounds[0]!.history_cursor = 999;
      },
      (a) => {
        a.records.scene_backgrounds[0]!.history_cursor = 0;
      },
      (a) => {
        a.records.scene_backgrounds[0]!.history_cursor =
          a.records.scene_background_history[0]!.seq;
      },
      (a) => {
        const row = a.records.scene_backgrounds[0]!,
          map = backgroundMapSchema.parse(JSON.parse(row.map_json));
        map.position.x++;
        row.map_json = JSON.stringify(map);
      },
      (a) => {
        const row = a.records.scene_backgrounds[0]!,
          map = backgroundMapSchema.parse(JSON.parse(row.map_json));
        map.visibility = "gm";
        row.map_json = JSON.stringify(map);
      },
      (a) =>
        editEntry(a, 0, (entry) => {
          entry.after!.position.x++;
        }),
      (a) =>
        editEntry(a, 1, (entry) => {
          entry.before!.position.x++;
        }),
      (a) =>
        editEntry(a, 0, (entry) => {
          entry.before = structuredClone(entry.after);
        }),
      (a) =>
        editEntry(a, 1, (entry) => {
          entry.before = structuredClone(entry.after);
          entry.before!.imageId = randomUUID();
        }),
      (a) => {
        a.records.scene_background_history = [];
        a.records.scene_background_history_refs = [];
      },
      (a) => {
        a.records.scene_backgrounds[0]!.version = 1;
      },
    ];
    const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    for (const [i, change] of cases.entries()) {
      assert.throws(
        () => f.inspect(mutate(file, change)),
        (error: unknown) =>
          error instanceof StoreError &&
          error.statusCode === 400 &&
          !error.message.includes("PRIVATE MAP CANARY"),
        `tamper ${i}`,
      );
    }
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    f.accepted();
  } finally {
    f.db.close();
  }
});

test("HTTP preflight rejects a private inactive map with a forged cursor without changing the destination or echoing file content", async () => {
  const f = mapFixture(),
    app = await createApp({ databasePath: ":memory:", hostKey: key });
  try {
    f.set(400);
    const c = f.tables.getCampaign(),
      scene = f.tables.createScene(c.id, { name: "Active elsewhere" });
    f.tables.activateScene(c.id, scene.id, c.version);
    const setup = await app.inject({
      method: "POST",
      url: "/api/access/setup",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ key, name: "Destination GM" }),
    });
    const cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    const get = () => app.inject({ url: "/api/table", headers: { cookie } });
    const before = (await get()).body,
      file = f.snapshot();
    const post = (body: string) =>
      app.inject({
        method: "POST",
        url: "/api/campaign-imports/preflight",
        headers: {
          cookie,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        payload: body,
      });
    assert.equal((await post(file)).statusCode, 200);
    const denied = await post(
      mutate(file, (a) => {
        a.records.scene_backgrounds[0]!.history_cursor = 0;
      }),
    );
    assert.equal(denied.statusCode, 400);
    assert.equal(denied.headers["cache-control"], "no-store");
    assert.ok(!denied.body.includes("PRIVATE MAP CANARY"));
    assert.equal((await get()).body, before);
    assert.equal((await post(file)).statusCode, 200);
  } finally {
    f.db.close();
    await app.close();
  }
});
