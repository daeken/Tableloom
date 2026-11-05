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
import { entryOf, payloadSchema } from "./scene-history-model.js";
import {
  SceneHistoryStore,
  MAX_CAMPAIGN_HISTORY_BYTES,
} from "./scene-history.js";
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
test("deletion restoration preserves drawing slots and leaves earlier order inverses usable", () => {
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
      [b, c, a],
    );
    assert.equal(f.history.status(f.player.member).undo!.available, true);
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().drawings.map((d) => d.id),
      [a, b, c],
    );
    f.action("scene.redo");
    f.action("scene.redo");
    assert.deepEqual(
      f.tables.load().drawings.map((d) => d.id),
      [c, a],
    );
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().drawings.map((d) => d.id),
      [b, c, a],
    );
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
      // Reconstruct legacy history: drawing slots were not recorded yet.
      f.db.exec(
        "UPDATE scene_history_entries SET payload_json=json_remove(payload_json,'$.drawingOrder') WHERE json_type(payload_json,'$.drawingOrder') IS NOT NULL",
      );
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
        14,
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

test("mixed noncontiguous deletion restores saved drawing slots regardless of request order, retaining current survivor content", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add(),
      d = f.add(),
      tokenId = randomUUID();
    f.run({
      type: "token.add",
      token: {
        id: tokenId,
        name: "Scout",
        color: "#123456",
        position: { x: 30, y: 40 },
      },
    });
    const before = f.tables.load();
    f.run({
      type: "objects.delete",
      objects: [d, tokenId, b].map((objectId) => ({
        objectId,
        expectedVersion: 1,
      })),
    });
    assert.deepEqual(
      f.tables.load().drawings.map((drawing) => drawing.id),
      [a, c],
    );
    // Content changes to surviving drawings are independent of stack membership/order.
    f.run(
      {
        type: "drawing.style.update",
        drawingId: c,
        expectedVersion: 1,
        changes: {
          color: "#abcdef",
          shapeStyle: { lineWidth: 20, fill: null },
        },
      },
      f.gm.member,
    );
    const survivor = f.tables
      .load()
      .drawings.find((drawing) => drawing.id === c)!;
    const rows = () =>
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    const savedRows = rows(),
      savedState = f.tables.load(),
      status = f.history.status(f.player.member);
    assert.equal(status.undo!.available, true);
    f.db.exec(
      "CREATE TRIGGER reject_slot_restore BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture slot restore'); END",
    );
    assert.throws(() => f.action("scene.undo"), /fixture slot restore/);
    assert.deepEqual(rows(), savedRows);
    assert.deepEqual(f.tables.load(), savedState);
    assert.deepEqual(f.history.status(f.player.member), status);
    f.db.exec("DROP TRIGGER reject_slot_restore");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      status,
    );
    f.action("scene.undo");
    const restored = f.tables.load();
    assert.deepEqual(
      restored.drawings.map((drawing) => drawing.id),
      [a, b, c, d],
    );
    assert.deepEqual(
      restored.drawings.find((drawing) => drawing.id === c),
      survivor,
    );
    for (const id of [b, d])
      assert.deepEqual(
        restored.drawings.find((drawing) => drawing.id === id),
        {
          ...before.drawings.find((drawing) => drawing.id === id)!,
          version: 3,
        },
      );
    assert.deepEqual(restored.tokens[0], { ...before.tokens[0]!, version: 3 });
    f.action("scene.redo");
    assert.deepEqual(
      f.tables.load().drawings.map((drawing) => drawing.id),
      [a, c],
    );
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().drawings.map((drawing) => drawing.id),
      [a, b, c, d],
    );
  } finally {
    f.db.close();
  }
});

test("restoration rejects changed survivor order or membership without consuming history; removals capture actual latest slots", () => {
  for (const change of ["reorder", "add", "delete"] as const) {
    const f = fixture();
    try {
      const a = f.add(),
        b = f.add(),
        c = f.add();
      f.run({ type: "object.delete", objectId: b, expectedVersion: 1 });
      if (change === "reorder")
        f.run(
          {
            type: "drawing.reorder",
            drawingId: a,
            expectedVersion: 1,
            expectedOrder: [a, c],
            direction: "front",
          },
          f.gm.member,
        );
      else if (change === "delete")
        f.run(
          { type: "object.delete", objectId: a, expectedVersion: 1 },
          f.gm.member,
        );
      else
        f.run(
          {
            type: "drawing.add",
            drawing: {
              id: randomUUID(),
              kind: "stroke",
              color: "#123456",
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ],
            },
          },
          f.gm.member,
        );
      const current = f.tables.load(),
        cursor = f.history.status(f.player.member);
      assert.equal(cursor.undo!.available, false);
      assert.throws(() => f.action("scene.undo"), /changed|unavailable/);
      assert.deepEqual(f.tables.load(), current);
      assert.deepEqual(f.history.status(f.player.member), cursor);
      // Restoring the exact surviving ID order makes the edge safe again.
      f.action("scene.undo", f.gm.member);
      assert.equal(f.history.status(f.player.member).undo!.available, true);
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().drawings.map((drawing) => drawing.id),
        [a, b, c],
      );
      // Redo deletion preserves a newer stack and records the actual pre-removal order.
      f.run(
        {
          type: "drawing.reorder",
          drawingId: a,
          expectedVersion: f.tables
            .load()
            .drawings.find((drawing) => drawing.id === a)!.version,
          expectedOrder: [a, b, c],
          direction: "front",
        },
        f.gm.member,
      );
      f.action("scene.redo");
      assert.deepEqual(
        f.tables.load().drawings.map((drawing) => drawing.id),
        [c, a],
      );
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().drawings.map((drawing) => drawing.id),
        [b, c, a],
      );
    } finally {
      f.db.close();
    }
  }
});

test("undoing creation captures its current slot and guards redo without blocking disjoint removals", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add();
    const c = randomUUID();
    f.run(
      {
        type: "drawing.add",
        drawing: {
          id: c,
          kind: "rectangle",
          color: "#123456",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      },
      f.gm.member,
    );
    f.action("scene.undo"); // Removes b without disturbing a or the new GM drawing.
    assert.deepEqual(
      f.tables.load().drawings.map((drawing) => drawing.id),
      [a, c],
    );
    f.run(
      {
        type: "drawing.reorder",
        drawingId: a,
        expectedVersion: 1,
        expectedOrder: [a, c],
        direction: "front",
      },
      f.gm.member,
    );
    assert.equal(f.history.status(f.player.member).redo!.available, false);
    assert.throws(() => f.action("scene.redo"));
    f.action("scene.undo", f.gm.member);
    f.action("scene.redo");
    assert.deepEqual(
      f.tables.load().drawings.map((drawing) => drawing.id),
      [a, b, c],
    );
    assert.equal(f.tables.load().drawings[1]!.version, 3);
  } finally {
    f.db.close();
  }
});

test("history 13 upgrades reorder and legacy deletion inverses byte-for-byte without inventing lost slots; future slots and marker failures roll back", () => {
  for (const mode of ["none", "marker", "future"] as const) {
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
      f.db.exec(
        "UPDATE scene_history_entries SET payload_json=json_remove(payload_json,'$.drawingOrder') WHERE json_type(payload_json,'$.drawingOrder') IS NOT NULL",
      );
      const cursor = f.history.status(f.player.member),
        state = f.tables.load();
      const rows = () =>
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all();
      const original = rows();
      f.db.exec("UPDATE scene_history_version SET version=13");
      if (mode === "marker")
        f.db.exec(
          "CREATE TRIGGER reject_slot_upgrade BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture slot upgrade'); END",
        );
      if (mode === "future")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=json_set(payload_json,'$.drawingOrder',json(?)) WHERE id=?",
          )
          .run(JSON.stringify([b, c, a]), cursor.undo!.id);
      const captured = rows();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, f.tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          13,
        );
        assert.deepEqual(rows(), captured);
        assert.deepEqual(f.tables.load(), state);
        if (mode === "marker") f.db.exec("DROP TRIGGER reject_slot_upgrade");
        else
          f.db
            .prepare(
              "UPDATE scene_history_entries SET payload_json=? WHERE id=?",
            )
            .run(original.at(-1)!.payload_json!, cursor.undo!.id);
      }
      const migrated = new SceneHistoryStore(f.db, f.tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        14,
      );
      assert.deepEqual(rows(), original);
      assert.deepEqual(migrated.status(f.player.member), cursor);
      assert.deepEqual(f.tables.load(), state);
      f.action("scene.undo"); // A real pre-upgrade deletion has no original slot to recover.
      assert.deepEqual(
        f.tables.load().drawings.map((drawing) => drawing.id),
        [c, a, b],
      );
      assert.equal(f.history.status(f.player.member).undo!.available, false);
      f.action("scene.redo"); // Actual removal now records a known order.
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().drawings.map((drawing) => drawing.id),
        [c, a, b],
      );
      assert.equal(
        JSON.parse(String(rows().at(-1)!.payload_json)).drawingOrder.length,
        3,
      );
    } finally {
      f.db.close();
    }
  }
});

test("saved restoration slots reject missing targets, duplicate/oversized/invalid IDs and token-only metadata", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add();
    f.run({ type: "object.delete", objectId: a, expectedVersion: 1 });
    const row = f.db
      .prepare(
        "SELECT * FROM scene_history_entries ORDER BY sequence DESC LIMIT 1",
      )
      .get()!;
    const payload = JSON.parse(String(row.payload_json));
    assert.deepEqual(entryOf(row).payload, payload);
    for (const drawingOrder of [
      [],
      [b],
      [a, a],
      ["bad"],
      Array.from({ length: 2001 }, () => randomUUID()),
    ]) {
      assert.throws(() =>
        entryOf({
          ...row,
          payload_json: JSON.stringify({ ...payload, drawingOrder }),
        }),
      );
    }
    const token = {
      id: randomUUID(),
      name: "Scout",
      position: { x: 0, y: 0 },
      radius: 24,
      color: "#123456",
      version: 1,
    };
    assert.equal(
      payloadSchema.safeParse({
        kind: "delete",
        objectType: "token",
        object: token,
        drawingOrder: [a],
      }).success,
      false,
    );
    assert.equal(
      payloadSchema.safeParse({
        kind: "delete-many",
        objectType: "token",
        objects: [{ objectType: "token", object: token }],
        drawingOrder: [a],
      }).success,
      false,
    );
    assert.equal(
      payloadSchema.safeParse({
        kind: "delete-many",
        objectType: "drawing",
        objects: [{ objectType: "drawing", object: payload.object }],
        drawingOrder: [b],
      }).success,
      false,
    );
  } finally {
    f.db.close();
  }
});

test("capturing slots during undo keeps the campaign inverse byte budget bounded", () => {
  const f = fixture();
  try {
    f.add();
    f.add();
    const rows = f.db
      .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
      .all();
    const total = Number(
      f.db
        .prepare(
          "SELECT SUM(length(CAST(payload_json AS BLOB))+length(CAST(targets_json AS BLOB))) AS bytes FROM scene_history_entries",
        )
        .get()!.bytes,
    );
    // Valid trailing JSON whitespace makes the older inverse fill the budget.
    f.db
      .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
      .run(
        String(rows[0]!.payload_json) +
          " ".repeat(MAX_CAMPAIGN_HISTORY_BYTES - total - 1),
        rows[0]!.id!,
      );
    f.action("scene.undo");
    const remaining = f.db
      .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
      .all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]!.id, rows[1]!.id);
    assert.ok(
      Number(
        f.db
          .prepare(
            "SELECT SUM(length(CAST(payload_json AS BLOB))+length(CAST(targets_json AS BLOB))) AS bytes FROM scene_history_entries",
          )
          .get()!.bytes,
      ) <= MAX_CAMPAIGN_HISTORY_BYTES,
    );
    assert.equal(f.history.status(f.player.member).redo!.available, true);
  } finally {
    f.db.close();
  }
});
