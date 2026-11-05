import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  drawingLayersOf,
  drawingLayerOf,
  restoreTable,
} from "@tableloom/core";
import type { CommandInput } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { entryOf, payloadSchema } from "./scene-history-model.js";
import { SceneHistoryStore } from "./scene-history.js";
import { transaction } from "./database.js";
const KEY = "tableloom-order-history-synthetic-fixture-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Editor",
    ),
    history = new SceneHistoryStore(db, tables);
  const run = (input: CommandInput, member: Member = player.member) =>
    transaction(db, () => {
      const command = commandSchema.parse({ ...input, id: randomUUID() }),
        before = tables.load(member.tableId),
        after =
          command.type === "scene.undo" || command.type === "scene.redo"
            ? history.apply(member, before, command)
            : applyCommand(before, command, member);
      history.record(member, before, after, command);
      tables.save(after, command.id, member.tableId);
      return after;
    });
  const action = (
    type: "scene.undo" | "scene.redo",
    member = player.member,
  ) => {
    const edge =
      history.status(member)[type === "scene.undo" ? "undo" : "redo"]!;
    return run(
      { type, historyId: edge.id, expectedVersion: edge.version },
      member,
    );
  };
  const add = (kind: "rectangle" | "stroke" = "rectangle") => {
    const id = randomUUID();
    run({
      type: "drawing.add",
      drawing: {
        id,
        kind,
        color: "#405f4d",
        points: [
          { x: 10, y: 20 },
          { x: 110, y: 100 },
        ],
      },
    });
    return id;
  };
  const layer = (
    id: string,
    layer: "below-tokens" | "above-tokens",
    member = player.member,
  ) => {
    const state = tables.load(member.tableId);
    return run(
      {
        type: "drawing.layer.update",
        drawingId: id,
        expectedVersion: state.drawings.find((d) => d.id === id)!.version,
        expectedOrder: state.drawings.map((d) => d.id),
        expectedLayers: drawingLayersOf(state.drawings),
        layer,
      },
      member,
    );
  };
  return { db, tables, access, gm, player, history, run, action, add, layer };
}

test("drawing layer and same-layer ordering preserve content/slots and exact implicit defaults through causal history and rollback", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add(),
      original = f.tables.load();
    const ids = () => f.tables.load().drawings.map((d) => d.id);
    f.layer(a, "above-tokens");
    assert.deepEqual(ids(), [a, b, c]);
    for (const drawing of original.drawings)
      assert.deepEqual(
        f.tables.load().drawings.find((d) => d.id === drawing.id),
        drawing.id === a
          ? { ...drawing, layer: "above-tokens", version: 2 }
          : drawing,
      );
    assert.equal(f.history.status(f.player.member).undo!.action, "layer");
    assert.throws(() => f.layer(a, "above-tokens"));
    const reorder = () =>
      f.run({
        type: "drawing.reorder",
        drawingId: a,
        expectedVersion: f.tables.load().drawings.find((d) => d.id === a)!
          .version,
        expectedOrder: ids(),
        expectedLayers: drawingLayersOf(f.tables.load().drawings),
        direction: "front",
      });
    assert.throws(reorder, /already/); // Already the only object in this layer, despite later lower drawings.
    f.layer(b, "above-tokens");
    reorder();
    assert.deepEqual(ids(), [b, c, a]);
    f.action("scene.undo");
    f.action("scene.undo");
    f.action("scene.undo");
    assert.deepEqual(ids(), [a, b, c]);
    assert.ok(f.tables.load().drawings.every((d) => !("layer" in d)));
    f.action("scene.redo");
    f.action("scene.redo");
    f.action("scene.redo");
    assert.deepEqual(ids(), [b, c, a]);
    f.run({
      type: "drawing.style.update",
      drawingId: a,
      expectedVersion: f.tables.load().drawings.find((d) => d.id === a)!
        .version,
      changes: { color: "#abcdef", shapeStyle: { lineWidth: 20, fill: null } },
    });
    f.run({
      type: "object.delete",
      objectId: a,
      expectedVersion: f.tables.load().drawings.find((d) => d.id === a)!
        .version,
    });
    f.action("scene.undo");
    assert.deepEqual(ids(), [b, c, a]);
    assert.equal(f.tables.load().drawings.at(-1)!.layer, "above-tokens");
    f.action("scene.undo");
    assert.equal(
      f.tables.load().drawings.at(-1)!.color,
      original.drawings[0]!.color,
    );
    f.action("scene.undo");
    assert.deepEqual(ids(), [a, b, c]);
    const state = f.tables.load(),
      rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      cursor = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_layer_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture layer receipt'); END",
    );
    assert.throws(() => f.layer(c, "above-tokens"), /fixture layer receipt/);
    assert.deepEqual(f.tables.load(), state);
    assert.deepEqual(f.history.status(f.player.member), cursor);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    f.db.exec("DROP TRIGGER reject_layer_receipt");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      cursor,
    );
    // A later explicit lower override must remain explicit when its next edit is undone.
    f.layer(a, "below-tokens");
    f.layer(a, "above-tokens");
    f.action("scene.undo");
    assert.equal(
      f.tables.load().drawings.find((d) => d.id === a)!.layer,
      "below-tokens",
    );
    assert.ok("layer" in f.tables.load().drawings.find((d) => d.id === a)!);
    f.action("scene.redo");
    assert.equal(
      f.tables.load().drawings.find((d) => d.id === a)!.layer,
      "above-tokens",
    );
  } finally {
    f.db.close();
  }
});

test("layer changes and reorder inverses guard peer layer assignments, current permission/version and exact order", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add(),
      other = f.access.redeemInvitation(
        f.access.createInvitation(f.gm.token).token,
        "Other",
      ).member;
    assert.throws(() => f.layer(a, "above-tokens", other));
    const captured = {
      type: "drawing.layer.update" as const,
      drawingId: a,
      expectedVersion: 1,
      expectedOrder: [a, b, c],
      expectedLayers: drawingLayersOf(f.tables.load().drawings),
      layer: "above-tokens" as const,
    };
    f.layer(b, "above-tokens", f.gm.member);
    assert.throws(() => f.run(captured), /layers changed/);
    assert.equal(f.tables.load().drawings[0]!.version, 1);
    f.action("scene.undo", f.gm.member);
    f.run(captured);
    f.layer(c, "above-tokens", f.gm.member);
    const state = f.tables.load(),
      status = f.history.status(f.player.member);
    assert.equal(status.undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
    assert.deepEqual(f.tables.load(), state);
    assert.deepEqual(f.history.status(f.player.member), status);
    f.action("scene.undo", f.gm.member);
    f.action("scene.undo");
    assert.equal(f.tables.load().drawings[0]!.layer, undefined);
    f.action("scene.redo");
    f.layer(b, "above-tokens");
    const before = f.tables.load();
    f.run({
      type: "drawing.reorder",
      drawingId: a,
      expectedVersion: before.drawings[0]!.version,
      expectedOrder: [a, b, c],
      expectedLayers: drawingLayersOf(before.drawings),
      direction: "front",
    });
    f.layer(c, "above-tokens", f.gm.member);
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
    f.action("scene.undo", f.gm.member);
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().drawings.map((d) => d.id),
      [a, b, c],
    );
  } finally {
    f.db.close();
  }
});

test("table-9 defaults preserve absent lower layers and reject future fields; layer contracts are strict and bounded", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      state = f.tables.load();
    const old = { ...state, schemaVersion: 9 };
    const restored = restoreTable(old);
    assert.equal(restored.migrated, true);
    assert.deepEqual(restored.state, state);
    assert.throws(() =>
      restoreTable({
        ...old,
        drawings: [
          { ...old.drawings[0], layer: "above-tokens" },
          old.drawings[1],
        ],
      }),
    );
    const command = {
      id: randomUUID(),
      type: "drawing.layer.update",
      drawingId: a,
      expectedVersion: 1,
      expectedOrder: [a, b],
      expectedLayers: ["below-tokens", "below-tokens"],
      layer: "above-tokens",
    };
    for (const fields of [
      { layer: "gm" },
      { layer: null },
      { expectedLayers: ["below-tokens"] },
      { expectedLayers: ["below-tokens", "hidden"] },
      { ownerId: f.player.member.id },
      { expectedOrder: [a, a] },
    ])
      assert.equal(
        commandSchema.safeParse({ ...command, ...fields }).success,
        false,
      );
    assert.equal(commandSchema.safeParse(command).success, true);
    const drawing = f.tables.load().drawings[0]!;
    assert.equal(
      commandSchema.safeParse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: {
          id: randomUUID(),
          kind: drawing.kind,
          color: drawing.color,
          points: drawing.points,
          layer: "above-tokens",
        },
      }).success,
      false,
    );
    const row = {
      sequence: 1,
      id: randomUUID(),
      campaign_id: f.player.member.tableId,
      scene_id: f.tables.getCampaign(f.player.member.tableId).activeSceneId,
      actor_id: f.player.member.id,
      state: "done",
      version: 1,
      targets_json: JSON.stringify([
        { objectId: a, expectedVersion: 2, previousId: null },
      ]),
    };
    for (const payload of [
      {
        kind: "layer",
        objectType: "drawing",
        before: null,
        after: "below-tokens",
        order: [a, b],
        layers: ["below-tokens", "below-tokens"],
      },
      {
        kind: "layer",
        objectType: "drawing",
        before: null,
        after: "above-tokens",
        order: [b],
        layers: ["below-tokens"],
      },
      {
        kind: "layer",
        objectType: "drawing",
        before: null,
        after: "above-tokens",
        order: [a, b],
        layers: ["above-tokens", "below-tokens"],
      },
    ])
      assert.throws(() =>
        entryOf({ ...row, payload_json: JSON.stringify(payload) }),
      );
    assert.equal(
      payloadSchema.safeParse({
        kind: "reorder",
        objectType: "drawing",
        before: [a, b],
        after: [b, a],
        layers: ["below-tokens"],
      }).success,
      false,
    );
    assert.equal(drawingLayerOf(drawing), "below-tokens");
  } finally {
    f.db.close();
  }
});

test("campaign 6/history 15 upgrades all scenes and inverse defaults atomically, preserving saved bytes and rejecting future layers", () => {
  for (const mode of [
    "none",
    "campaign-marker",
    "offstage-layer",
    "history-marker",
    "future-snapshot",
    "future-payload",
    "future-layers",
  ] as const) {
    const f = fixture();
    try {
      const a = f.add(),
        b = f.add(),
        tokenId = randomUUID();
      f.run({
        type: "token.add",
        token: {
          id: tokenId,
          name: "Scout",
          position: { x: 50, y: 50 },
          color: "#123456",
        },
      });
      const original = f.tables.load(),
        off = f.tables.createScene(f.gm.member.tableId, {
          name: "Hidden scene",
        }),
        offId = randomUUID();
      f.db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
        JSON.stringify({
          tokens: [],
          drawings: [{ ...original.drawings[0], id: offId }],
        }),
        off.id,
      );
      f.db
        .prepare(
          "INSERT INTO object_id_reservations(campaign_id,id) VALUES(?,?)",
        )
        .run(f.gm.member.tableId, offId);
      f.run({
        type: "drawing.reorder",
        drawingId: a,
        expectedVersion: 1,
        expectedOrder: [a, b],
        expectedLayers: ["below-tokens", "below-tokens"],
        direction: "front",
      });
      f.run({
        type: "objects.delete",
        objects: [
          { objectId: a, expectedVersion: 2 },
          { objectId: tokenId, expectedVersion: 1 },
        ],
      });
      // Legacy order/deletion inverses retain their real slots but have no layer fields.
      f.db.exec(
        "UPDATE scene_history_entries SET payload_json=json_remove(payload_json,'$.layers') WHERE json_type(payload_json,'$.layers') IS NOT NULL",
      );
      const state = f.tables.load(),
        status = f.history.status(f.player.member),
        historyRows = () =>
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
        originalHistory = historyRows();
      for (const row of f.db
        .prepare("SELECT id,state_json FROM campaign_records")
        .all()) {
        const data = JSON.parse(String(row.state_json));
        data.schemaVersion = 9;
        f.db
          .prepare("UPDATE campaign_records SET state_json=? WHERE id=?")
          .run(JSON.stringify(data), row.id!);
      }
      f.db.exec(
        "UPDATE campaign_storage_version SET version=6; UPDATE scene_history_version SET version=15",
      );
      if (mode === "offstage-layer")
        f.db
          .prepare(
            "UPDATE scene_records SET state_json=json_set(state_json,'$.drawings[0].layer','above-tokens') WHERE id=?",
          )
          .run(off.id);
      if (mode === "campaign-marker")
        f.db.exec(
          "CREATE TRIGGER reject_layer_campaign BEFORE UPDATE ON campaign_storage_version BEGIN SELECT RAISE(ABORT,'fixture layer campaign'); END",
        );
      const campaigns = f.db
          .prepare("SELECT * FROM campaign_records ORDER BY id")
          .all(),
        scenes = f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
        reservations = f.db
          .prepare("SELECT * FROM object_id_reservations ORDER BY id")
          .all();
      if (mode === "campaign-marker" || mode === "offstage-layer") {
        assert.throws(() => new TableStore(f.db));
        assert.equal(
          f.db.prepare("SELECT version FROM campaign_storage_version").get()!
            .version,
          6,
        );
        assert.deepEqual(
          f.db.prepare("SELECT * FROM campaign_records ORDER BY id").all(),
          campaigns,
        );
        assert.deepEqual(
          f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
          scenes,
        );
        assert.deepEqual(historyRows(), originalHistory);
        continue;
      }
      const tables = new TableStore(f.db);
      assert.deepEqual(tables.load(), state);
      assert.equal(
        f.db.prepare("SELECT version FROM campaign_storage_version").get()!
          .version,
        7,
      );
      assert.deepEqual(
        f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
        scenes,
      );
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM campaign_records ORDER BY id")
          .all()
          .map((row) => ({
            ...row,
            state_json: JSON.parse(String(row.state_json)),
          })),
        campaigns.map((row) => ({
          ...row,
          state_json: {
            ...JSON.parse(String(row.state_json)),
            schemaVersion: 10,
          },
        })),
      );
      if (mode === "history-marker")
        f.db.exec(
          "CREATE TRIGGER reject_layer_history BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture layer history'); END",
        );
      if (mode === "future-snapshot")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=json_set(payload_json,'$.objects[0].object.layer','above-tokens') WHERE id=?",
          )
          .run(status.undo!.id);
      if (mode === "future-payload")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=? WHERE sequence=1",
          )
          .run(
            JSON.stringify({
              kind: "layer",
              objectType: "drawing",
              before: null,
              after: "above-tokens",
              order: [a, b],
              layers: ["below-tokens", "below-tokens"],
            }),
          );
      if (mode === "future-layers")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=json_set(payload_json,'$.layers',json(?)) WHERE sequence=4",
          )
          .run(JSON.stringify(["below-tokens", "below-tokens"]));
      const captured = historyRows();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          15,
        );
        assert.deepEqual(historyRows(), captured);
        assert.deepEqual(tables.load(), state);
        if (mode === "history-marker")
          f.db.exec("DROP TRIGGER reject_layer_history");
        else
          for (const row of originalHistory)
            f.db
              .prepare(
                "UPDATE scene_history_entries SET payload_json=? WHERE id=?",
              )
              .run(row.payload_json!, row.id!);
      }
      const history = new SceneHistoryStore(f.db, tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        16,
      );
      assert.deepEqual(historyRows(), originalHistory);
      assert.deepEqual(history.status(f.player.member), status);
      assert.deepEqual(
        f.db.prepare("SELECT * FROM object_id_reservations ORDER BY id").all(),
        reservations,
      );
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().drawings.map((d) => d.id),
        [b, a],
      );
      assert.ok(f.tables.load().drawings.every((d) => !("layer" in d)));
      // A genuine legacy reorder assumes its historical all-lower layer stack.
      f.layer(b, "above-tokens", f.gm.member);
      assert.equal(history.status(f.player.member).undo!.available, false);
      f.action("scene.undo", f.gm.member);
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().drawings.map((d) => d.id),
        [a, b],
      );
    } finally {
      f.db.close();
    }
  }
});
