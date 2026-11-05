import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { commandSchema } from "@tableloom/core";
import type { CommandInput } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
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
  return { db, tables, access, gm, player, history, run, action, add };
}

test("drawing arrangement changes only its target version/order, preserves geometry/styles/owners, and supports guarded exact history/rollback", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add(),
      before = f.tables.load(),
      ids = () => f.tables.load().drawings.map((d) => d.id),
      arrange = (
        id: string,
        direction: "front" | "back",
        member = f.player.member,
      ) =>
        f.run(
          {
            type: "drawing.reorder",
            drawingId: id,
            expectedVersion: f.tables.load().drawings.find((d) => d.id === id)!
              .version,
            expectedOrder: ids(),
            direction,
          },
          member,
        );
    arrange(b, "back");
    assert.deepEqual(ids(), [b, a, c]);
    assert.equal(f.history.status(f.player.member).undo!.action, "reorder");
    for (const d of before.drawings)
      assert.deepEqual(
        f.tables.load().drawings.find((n) => n.id === d.id),
        { ...d, version: d.id === b ? 2 : 1 },
      );
    const current = f.tables.load(),
      status = f.history.status(f.player.member),
      other = f.access.redeemInvitation(
        f.access.createInvitation(f.gm.token).token,
        "Other",
      ).member;
    assert.throws(() => arrange(b, "back"));
    assert.throws(() => arrange(a, "front", other));
    assert.throws(() =>
      f.run({
        type: "drawing.reorder",
        drawingId: a,
        expectedVersion: 1,
        expectedOrder: [a, b, c],
        direction: "front",
      }),
    );
    assert.deepEqual(f.tables.load(), current);
    assert.deepEqual(f.history.status(f.player.member), status);
    f.action("scene.undo");
    assert.deepEqual(ids(), [a, b, c]);
    f.action("scene.redo");
    assert.deepEqual(ids(), [b, a, c]);
    f.run({
      type: "drawing.style.update",
      drawingId: b,
      expectedVersion: 4,
      changes: { color: "#123456", shapeStyle: { lineWidth: 12, fill: null } },
    });
    f.action("scene.undo");
    f.action("scene.undo");
    assert.deepEqual(ids(), [a, b, c]);
    f.action("scene.redo");
    f.action("scene.redo");
    assert.deepEqual(ids(), [b, a, c]);
    assert.equal(f.tables.load().drawings[0]!.color, "#123456");
    const saved = f.tables.load(),
      cursor = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_order_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture order receipt'); END",
    );
    assert.throws(() => arrange(a, "front"), /fixture order receipt/);
    assert.deepEqual(f.tables.load(), saved);
    assert.deepEqual(f.history.status(f.player.member), cursor);
    f.db.exec("DROP TRIGGER reject_order_receipt");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      cursor,
    );
    arrange(c, "back", f.gm.member);
    f.action("scene.undo"); // undo own style; disjoint order work is preserved
    assert.deepEqual(ids(), [c, b, a]);
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
  } finally {
    f.db.close();
  }
});
test("order inverses never overwrite changed membership or deletion-restore append order", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add();
    f.run({
      type: "drawing.reorder",
      drawingId: a,
      expectedVersion: 1,
      expectedOrder: [a, b, c],
      direction: "front",
    });
    f.run({ type: "object.delete", objectId: b, expectedVersion: 1 });
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().drawings.map((d) => d.id),
      [c, a, b],
    );
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
  } finally {
    f.db.close();
  }
});
test("history 12 to 13 preserves shape payload bytes/cursors and rejects future ordering and failed marker writes atomically", () => {
  for (const mode of ["none", "marker", "future"] as const) {
    const f = fixture();
    try {
      const a = f.add(),
        b = f.add("stroke");
      f.run({
        type: "drawing.style.update",
        drawingId: a,
        expectedVersion: 1,
        changes: {
          color: "#123456",
          shapeStyle: { lineWidth: 12, fill: null },
        },
      });
      f.run({ type: "object.delete", objectId: a, expectedVersion: 2 });
      const state = f.tables.load(),
        status = f.history.status(f.player.member),
        rows = f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all();
      f.db.exec("UPDATE scene_history_version SET version=12");
      if (mode === "marker")
        f.db.exec(
          "CREATE TRIGGER reject_order_upgrade BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture order upgrade'); END",
        );
      if (mode === "future")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=? WHERE sequence=1",
          )
          .run(
            JSON.stringify({
              kind: "reorder",
              objectType: "drawing",
              before: [a, b],
              after: [b, a],
            }),
          );
      const captured = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, f.tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          12,
        );
        assert.deepEqual(
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
          captured,
        );
        if (mode === "marker") f.db.exec("DROP TRIGGER reject_order_upgrade");
        else
          f.db
            .prepare(
              "UPDATE scene_history_entries SET payload_json=? WHERE sequence=1",
            )
            .run(rows[0]!.payload_json as string);
      }
      const history = new SceneHistoryStore(f.db, f.tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        13,
      );
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        rows,
      );
      assert.deepEqual(f.tables.load(), state);
      assert.deepEqual(history.status(f.player.member), status);
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().drawings.find((d) => d.id === a)!.shapeStyle,
        { lineWidth: 12, fill: null },
      );
    } finally {
      f.db.close();
    }
  }
});
