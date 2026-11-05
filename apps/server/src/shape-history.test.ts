import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { commandSchema, shapeStyleOf } from "@tableloom/core";
import type { CommandInput } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { SceneHistoryStore } from "./scene-history.js";
import { transaction } from "./database.js";
const KEY = "tableloom-shape-history-synthetic-fixture-key";
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
  return { db, tables, access, gm, player, history, run, action, add };
}
const style = { lineWidth: 12.5, fill: { color: "#627d9c", opacity: 0.35 } };
test("shape styles preserve geometry/ownership with exact implicit-override undo, group chains, guards and atomic rollback", () => {
  const f = fixture();
  try {
    const id = f.add(),
      original = f.tables.load().drawings[0]!,
      command = {
        type: "drawing.style.update" as const,
        drawingId: id,
        expectedVersion: 1,
        changes: { color: "#b45f4e", shapeStyle: style },
      };
    f.run(command);
    assert.deepEqual(f.tables.load().drawings[0], {
      ...original,
      color: command.changes.color,
      shapeStyle: style,
      version: 2,
    });
    assert.equal(f.history.status(f.player.member).undo!.action, "edit");
    const inverse = JSON.parse(
      String(
        f.db
          .prepare(
            "SELECT payload_json FROM scene_history_entries ORDER BY sequence DESC LIMIT 1",
          )
          .get()!.payload_json,
      ),
    );
    assert.equal(inverse.before.shapeStyle, null);
    f.action("scene.undo");
    assert.equal(
      Object.hasOwn(f.tables.load().drawings[0]!, "shapeStyle"),
      false,
    );
    assert.deepEqual(f.tables.load().drawings[0]!.points, original.points);
    assert.equal(f.tables.load().drawings[0]!.color, original.color);
    f.action("scene.redo");
    let current = f.tables.load().drawings[0]!;
    const before = f.tables.load(),
      status = f.history.status(f.player.member),
      other = f.access.redeemInvitation(
        f.access.createInvitation(f.gm.token).token,
        "Other",
      ).member;
    assert.throws(() => f.run(command));
    assert.throws(() =>
      f.run({ ...command, expectedVersion: current.version }),
    );
    assert.throws(() =>
      f.run(
        {
          ...command,
          expectedVersion: current.version,
          changes: { ...command.changes, color: "#123456" },
        },
        other,
      ),
    );
    for (const bad of [
      { lineWidth: 0, fill: null },
      { lineWidth: 33, fill: null },
      { lineWidth: 3, fill: { color: "red", opacity: 1 } },
      { lineWidth: 3, fill: { color: "#123456", opacity: 0 } },
      { ...style, ownerId: other.id },
    ])
      assert.throws(() =>
        f.run({
          ...command,
          expectedVersion: current.version,
          changes: { color: "#123456", shapeStyle: bad },
        } as unknown as CommandInput),
      );
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(f.history.status(f.player.member), status);
    const stroke = f.add("stroke");
    assert.throws(() =>
      f.run({ ...command, drawingId: stroke, expectedVersion: 1 }),
    );
    f.run({
      ...command,
      drawingId: stroke,
      expectedVersion: 1,
      changes: { color: "#a27a44", shapeStyle: { lineWidth: 24, fill: null } },
    });
    current = f.tables.load().drawings.find((d) => d.id === id)!;
    f.run({
      type: "objects.resize",
      objects: [
        { objectId: id, expectedVersion: current.version },
        { objectId: stroke, expectedVersion: 2 },
      ],
      scale: 1.5,
    });
    const resized = f.tables.load();
    assert.equal(shapeStyleOf(resized.drawings[0]!).lineWidth, 12.5);
    f.run({
      type: "objects.delete",
      objects: resized.drawings.map((d) => ({
        objectId: d.id,
        expectedVersion: d.version,
      })),
    });
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().drawings.map((d) => d.shapeStyle),
      [style, { lineWidth: 24, fill: null }],
    );
    f.action("scene.undo");
    assert.deepEqual(f.tables.load().drawings[0]!.points, original.points);
    const saved = f.tables.load(),
      cursor = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_shape_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture shape rollback'); END",
    );
    assert.throws(
      () =>
        f.run({
          ...command,
          expectedVersion: saved.drawings[0]!.version,
          changes: {
            color: "#123456",
            shapeStyle: { lineWidth: 1, fill: null },
          },
        }),
      /fixture shape rollback/,
    );
    assert.deepEqual(f.tables.load(), saved);
    assert.deepEqual(f.history.status(f.player.member), cursor);
    f.db.exec("DROP TRIGGER reject_shape_receipt");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      cursor,
    );
    f.run(
      {
        ...command,
        expectedVersion: saved.drawings[0]!.version,
        changes: { color: "#123456", shapeStyle: { lineWidth: 1, fill: null } },
      },
      f.gm.member,
    );
    f.action("scene.undo");
    f.action("scene.undo");
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
  } finally {
    f.db.close();
  }
});

test("campaign 5/history 11 upgrades preserve active/offstage shapes, exact inverse bytes/cursors, and roll back failed markers or disguised future styles", () => {
  for (const mode of [
    "none",
    "campaign",
    "offstage",
    "history",
    "future-history",
    "future-snapshot",
  ] as const) {
    const f = fixture();
    try {
      const id = f.add(),
        stroke = f.add("stroke"),
        original = f.tables.load(),
        off = f.tables.createScene(f.gm.member.tableId, { name: "Offstage" }),
        offId = randomUUID();
      f.db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
        JSON.stringify({
          drawings: [{ ...original.drawings[0], id: offId }],
          tokens: [],
        }),
        off.id,
      );
      f.db
        .prepare(
          "INSERT INTO object_id_reservations(campaign_id,id) VALUES(?,?)",
        )
        .run(f.gm.member.tableId, offId);
      f.run({
        type: "objects.delete",
        objects: [
          { objectId: id, expectedVersion: 1 },
          { objectId: stroke, expectedVersion: 1 },
        ],
      });
      const state = f.tables.load(),
        status = f.history.status(f.player.member),
        rows = f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        scenes = f.db.prepare("SELECT * FROM scene_records ORDER BY id").all();
      for (const row of f.db
        .prepare("SELECT id,state_json FROM campaign_records")
        .all()) {
        const data = JSON.parse(String(row.state_json));
        data.schemaVersion = 8;
        f.db
          .prepare("UPDATE campaign_records SET state_json=? WHERE id=?")
          .run(JSON.stringify(data), row.id as string);
      }
      f.db.exec(
        "UPDATE campaign_storage_version SET version=5; UPDATE scene_history_version SET version=11",
      );
      if (mode === "campaign")
        f.db.exec(
          "CREATE TRIGGER reject_shape_campaign BEFORE UPDATE ON campaign_storage_version BEGIN SELECT RAISE(ABORT,'fixture shape upgrade'); END",
        );
      if (mode === "offstage")
        f.db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
          JSON.stringify({
            drawings: [
              { ...original.drawings[0], id: offId, shapeStyle: style },
            ],
            tokens: [],
          }),
          off.id,
        );
      const oldCampaign = f.db
          .prepare("SELECT * FROM campaign_records ORDER BY id")
          .all(),
        oldScenes = f.db
          .prepare("SELECT * FROM scene_records ORDER BY id")
          .all();
      if (mode === "campaign" || mode === "offstage") {
        assert.throws(() => new TableStore(f.db));
        assert.deepEqual(
          f.db.prepare("SELECT * FROM campaign_records ORDER BY id").all(),
          oldCampaign,
        );
        assert.deepEqual(
          f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
          oldScenes,
        );
        assert.equal(
          f.db.prepare("SELECT version FROM campaign_storage_version").get()!
            .version,
          5,
        );
        continue;
      }
      const tables = new TableStore(f.db);
      assert.deepEqual(tables.load(), state);
      assert.deepEqual(
        f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
        scenes,
      );
      assert.equal(
        f.db.prepare("SELECT version FROM campaign_storage_version").get()!
          .version,
        6,
      );
      if (mode === "history")
        f.db.exec(
          "CREATE TRIGGER reject_shape_history BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture shape history'); END",
        );
      if (mode === "future-history")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=? WHERE sequence=1",
          )
          .run(
            JSON.stringify({
              kind: "shape-update",
              objectType: "drawing",
              before: { color: "#405f4d", shapeStyle: null },
              after: { color: "#123456", shapeStyle: style },
            }),
          );
      if (mode === "future-snapshot") {
        const payload = JSON.parse(String(rows[0]!.payload_json));
        payload.object.shapeStyle = style;
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=? WHERE sequence=1",
          )
          .run(JSON.stringify(payload));
      }
      const oldRows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, tables));
        assert.deepEqual(
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
          oldRows,
        );
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          11,
        );
        if (mode === "history") f.db.exec("DROP TRIGGER reject_shape_history");
        else
          f.db
            .prepare(
              "UPDATE scene_history_entries SET payload_json=? WHERE sequence=1",
            )
            .run(rows[0]!.payload_json as string);
      }
      const history = new SceneHistoryStore(f.db, tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        12,
      );
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        rows,
      );
      assert.deepEqual(history.status(f.player.member), status);
      f.action("scene.undo");
      assert.deepEqual(
        tables.load().drawings.map((d) => shapeStyleOf(d)),
        original.drawings.map((d) => shapeStyleOf(d)),
      );
      assert.ok(
        tables.load().drawings.every((d) => !Object.hasOwn(d, "shapeStyle")),
      );
    } finally {
      f.db.close();
    }
  }
});
