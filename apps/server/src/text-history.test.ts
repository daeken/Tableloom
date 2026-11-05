import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { commandSchema } from "@tableloom/core";
import type { CommandInput } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { SceneHistoryStore } from "./scene-history.js";
import { transaction } from "./database.js";
const KEY = "tableloom-text-history-private-fixture-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Player",
    ),
    history = new SceneHistoryStore(db, tables);
  const run = (input: CommandInput, member: Member = player.member) =>
    transaction(db, () => {
      const command = commandSchema.parse({ ...input, id: randomUUID() }),
        before = tables.load(member.tableId),
        after =
          command.type === "scene.undo" || command.type === "scene.redo"
            ? history.apply(member, before, command)
            : applyCommand(
                before,
                command,
                member,
                command.type === "object.assign"
                  ? access.getMember(command.ownerId, member.tableId)
                  : undefined,
              );
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
  const add = (text = "North gate\nCourtyard") => {
    const id = randomUUID();
    run({
      type: "drawing.add",
      drawing: {
        id,
        kind: "text",
        text,
        color: "#405f4d",
        points: [
          { x: 60, y: 90 },
          { x: 220, y: 154 },
        ],
      },
    });
    return id;
  };
  return { db, tables, access, gm, player, history, run, action, add };
}
test("text create/move/resize/mixed-delete history preserves exact text/geometry/ownership and rejects conflicts with atomic rollback", () => {
  const f = fixture();
  try {
    const id = f.add(),
      original = f.tables.load().drawings[0]!;
    f.run({
      type: "objects.move",
      objects: [{ objectId: id, expectedVersion: 1 }],
      delta: { x: 10.5, y: 20.25 },
    });
    const moved = f.tables.load().drawings[0]!;
    f.run({
      type: "drawing.resize",
      drawingId: id,
      expectedVersion: 2,
      bounds: { left: 70.5, top: 110.25, right: 390.5, bottom: 238.25 },
    });
    const resized = f.tables.load().drawings[0]!;
    assert.equal(resized.text, original.text);
    assert.equal(resized.ownerId, original.ownerId);
    f.run({ type: "object.delete", objectId: id, expectedVersion: 3 });
    assert.equal(f.tables.load().drawings.length, 0);
    f.action("scene.undo");
    assert.equal(f.tables.load().drawings[0]!.text, original.text);
    f.action("scene.undo");
    assert.deepEqual(f.tables.load().drawings[0]!.points, moved.points);
    f.action("scene.undo");
    assert.deepEqual(f.tables.load().drawings[0]!.points, original.points);
    f.action("scene.undo");
    assert.equal(f.tables.load().drawings.length, 0);
    for (let i = 0; i < 4; i++) f.action("scene.redo");
    assert.equal(f.tables.load().drawings.length, 0);
    f.action("scene.undo");
    const restored = f.tables.load().drawings[0]!;
    const before = f.tables.load();
    assert.throws(() =>
      f.run({
        type: "drawing.resize",
        drawingId: id,
        expectedVersion: 1,
        bounds: { left: 0, top: 0, right: 10, bottom: 10 },
      }),
    );
    assert.deepEqual(f.tables.load(), before);
    const other = f.access.redeemInvitation(
      f.access.createInvitation(f.gm.token).token,
      "Other",
    ).member;
    assert.throws(() =>
      f.run(
        {
          type: "object.delete",
          objectId: id,
          expectedVersion: restored.version,
        },
        other,
      ),
    );
    const token = randomUUID();
    f.run({
      type: "token.add",
      token: {
        id: token,
        name: "Scout",
        position: { x: 100, y: 200 },
        color: "#405f4d",
      },
    });
    f.run({
      type: "objects.resize",
      objects: [
        { objectId: id, expectedVersion: restored.version },
        { objectId: token, expectedVersion: 1 },
      ],
      scale: 1.5,
    });
    const grouped = f.tables.load();
    f.run({
      type: "objects.delete",
      objects: [
        { objectId: id, expectedVersion: grouped.drawings[0]!.version },
        { objectId: token, expectedVersion: 2 },
      ],
    });
    f.action("scene.undo");
    assert.equal(f.tables.load().drawings[0]!.text, original.text);
    assert.deepEqual(
      f.tables.load().drawings[0]!.points,
      grouped.drawings[0]!.points,
    );
    const captured = f.tables.load(),
      cursor = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_text_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture text failure'); END",
    );
    assert.throws(() => f.action("scene.undo"), /fixture text failure/);
    assert.deepEqual(f.tables.load(), captured);
    assert.deepEqual(f.history.status(f.player.member), cursor);
    f.db.exec("DROP TRIGGER reject_text_receipt");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      cursor,
    );
    f.run(
      {
        type: "object.assign",
        objectId: id,
        expectedVersion: captured.drawings[0]!.version,
        expectedOwnerId: f.player.member.id,
        ownerId: other.id,
      },
      f.gm.member,
    );
    assert.equal(f.history.status(f.player.member).undo!.available, false);
  } finally {
    f.db.close();
  }
});
test("campaign 3/history 8 upgrade existing scenes/inverses exactly and roll back failed markers or future text under old markers", () => {
  for (const failure of [
    "none",
    "campaign",
    "history",
    "future",
    "future-history",
  ] as const) {
    const f = fixture();
    try {
      const id = randomUUID();
      f.run({
        type: "drawing.add",
        drawing: {
          id,
          kind: "rectangle",
          color: "#405f4d",
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 80 },
          ],
        },
      });
      const offstage = f.tables.createScene(f.gm.member.tableId, {
        name: "Offstage",
      });
      const oldState = f.tables.load(),
        oldScenes = f.db
          .prepare("SELECT * FROM scene_records ORDER BY id")
          .all(),
        oldHistory = f.db.prepare("SELECT * FROM scene_history_entries").all();
      for (const row of f.db
        .prepare("SELECT id,state_json FROM campaign_records")
        .all()) {
        const data = JSON.parse(String(row.state_json));
        data.schemaVersion = 6;
        f.db
          .prepare("UPDATE campaign_records SET state_json=? WHERE id=?")
          .run(JSON.stringify(data), row.id as string);
      }
      f.db.exec(
        "UPDATE campaign_storage_version SET version=3; UPDATE scene_history_version SET version=8",
      );
      if (failure === "campaign")
        f.db.exec(
          "CREATE TRIGGER reject_text_upgrade BEFORE UPDATE ON campaign_storage_version BEGIN SELECT RAISE(ABORT,'fixture text upgrade'); END",
        );
      if (failure === "future")
        f.db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
          JSON.stringify({
            tokens: [],
            drawings: [
              { ...oldState.drawings[0], kind: "text", text: "Future label" },
            ],
          }),
          offstage.id,
        );
      if (failure === "campaign" || failure === "future") {
        const rows = f.db.prepare("SELECT * FROM campaign_records").all();
        assert.throws(() => new TableStore(f.db));
        assert.deepEqual(
          f.db.prepare("SELECT * FROM campaign_records").all(),
          rows,
        );
        assert.equal(
          f.db.prepare("SELECT version FROM campaign_storage_version").get()!
            .version,
          3,
        );
      } else {
        const migrated = new TableStore(f.db);
        assert.deepEqual(migrated.load(), oldState);
        assert.deepEqual(
          f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
          oldScenes,
        );
        if (failure === "future-history") {
          const row = f.db
              .prepare("SELECT payload_json FROM scene_history_entries")
              .get()!,
            payload = JSON.parse(String(row.payload_json));
          payload.object.kind = "text";
          payload.object.text = "Future label";
          f.db
            .prepare("UPDATE scene_history_entries SET payload_json=?")
            .run(JSON.stringify(payload));
        }
        const beforeHistory = f.db
          .prepare("SELECT * FROM scene_history_entries")
          .all();
        if (failure === "history")
          f.db.exec(
            "CREATE TRIGGER reject_text_history BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture text history'); END",
          );
        if (failure === "history" || failure === "future-history") {
          assert.throws(() => new SceneHistoryStore(f.db, migrated));
          assert.deepEqual(
            f.db.prepare("SELECT * FROM scene_history_entries").all(),
            beforeHistory,
          );
          assert.equal(
            f.db.prepare("SELECT version FROM scene_history_version").get()!
              .version,
            8,
          );
        } else {
          new SceneHistoryStore(f.db, migrated);
          assert.deepEqual(
            f.db.prepare("SELECT * FROM scene_history_entries").all(),
            oldHistory,
          );
          assert.equal(
            f.db.prepare("SELECT version FROM scene_history_version").get()!
              .version,
            12,
          );
        }
      }
    } finally {
      f.db.close();
    }
  }
});

test("saved text/color edits keep geometry and owner, reject stale/foreign/nontext/no-op inputs, and join exact causal undo chains", () => {
  const f = fixture();
  try {
    const id = f.add(),
      original = f.tables.load().drawings[0]!;
    const edit = (
      text: string,
      color: string,
      expectedVersion = f.tables.load().drawings.find((d) => d.id === id)!
        .version,
    ) =>
      f.run({
        type: "drawing.text.update",
        drawingId: id,
        expectedVersion,
        changes: { text, color },
      });
    edit("  Courtyard\n<b>鍵</b>  ", "#ab1234");
    const edited = f.tables.load().drawings[0]!;
    assert.equal(edited.text, "  Courtyard\n<b>鍵</b>  ");
    assert.equal(edited.color, "#ab1234");
    assert.equal(edited.version, 2);
    assert.equal(edited.ownerId, original.ownerId);
    assert.deepEqual(edited.points, original.points);
    assert.equal(f.history.status(f.player.member).undo!.action, "edit");
    const before = f.tables.load(),
      cursor = f.history.status(f.player.member);
    for (const changes of [
      { text: "", color: edited.color },
      { text: "x".repeat(501), color: edited.color },
      { text: "x", color: "nope" },
      { text: "x\t", color: edited.color },
      { text: Array(21).fill("x").join("\n"), color: edited.color },
      { text: edited.text!, color: edited.color },
    ]) {
      assert.throws(() =>
        f.run({
          type: "drawing.text.update",
          drawingId: id,
          expectedVersion: 2,
          changes,
        }),
      );
      assert.deepEqual(f.tables.load(), before);
      assert.deepEqual(f.history.status(f.player.member), cursor);
    }
    assert.throws(() => edit("Stale", "#123456", 1));
    const other = f.access.redeemInvitation(
      f.access.createInvitation(f.gm.token).token,
      "Other",
    ).member;
    assert.throws(() =>
      f.run(
        {
          type: "drawing.text.update",
          drawingId: id,
          expectedVersion: 2,
          changes: { text: "Stolen", color: edited.color },
        },
        other,
      ),
    );
    const rectangle = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: rectangle,
        kind: "rectangle",
        points: original.points,
        color: original.color,
      },
    });
    assert.throws(() =>
      f.run({
        type: "drawing.text.update",
        drawingId: rectangle,
        expectedVersion: 1,
        changes: { text: "Wrong kind", color: original.color },
      }),
    );
    assert.throws(() =>
      f.run({
        type: "drawing.text.update",
        drawingId: randomUUID(),
        expectedVersion: 1,
        changes: { text: "Absent", color: original.color },
      }),
    );
    for (const changes of [
      { text: "ok", color: original.color, ownerId: other.id },
      { text: "ok", color: original.color, points: original.points },
    ])
      assert.throws(() =>
        commandSchema.parse({
          id: randomUUID(),
          type: "drawing.text.update",
          drawingId: id,
          expectedVersion: 2,
          changes,
        }),
      );
    // Color-only and wording-only edits both preserve the same exact box.
    edit(edited.text!, "#123456");
    edit("Final label", "#123456");
    f.run({
      type: "objects.move",
      objects: [{ objectId: id, expectedVersion: 4 }],
      delta: { x: 0.1, y: 0.2 },
    });
    f.run({ type: "object.delete", objectId: id, expectedVersion: 5 });
    for (let i = 0; i < 6; i++) f.action("scene.undo");
    const restored = f.tables.load().drawings.find((d) => d.id === id)!;
    assert.equal(restored.text, original.text);
    assert.equal(restored.color, original.color);
    assert.deepEqual(restored.points, original.points);
    for (let i = 0; i < 6; i++) f.action("scene.redo");
    assert.ok(!f.tables.load().drawings.some((d) => d.id === id));
    f.action("scene.undo");
    assert.equal(
      f.tables.load().drawings.find((d) => d.id === id)!.text,
      "Final label",
    );
    const saved = f.tables.load(),
      status = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_text_edit_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture edit rollback'); END",
    );
    assert.throws(() => edit("Rollback", "#654321"), /fixture edit rollback/);
    assert.deepEqual(f.tables.load(), saved);
    assert.deepEqual(f.history.status(f.player.member), status);
    f.db.exec("DROP TRIGGER reject_text_edit_receipt");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      status,
    );
    // A later GM edit is real intervening work, blocking the player's prior edge.
    f.run(
      {
        type: "drawing.text.update",
        drawingId: id,
        expectedVersion: saved.drawings.find((d) => d.id === id)!.version,
        changes: { text: "GM revision", color: "#abcdef" },
      },
      f.gm.member,
    );
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
    f.action("scene.undo", f.gm.member);
    assert.equal(
      f.tables.load().drawings.find((d) => d.id === id)!.text,
      "Final label",
    );
    // Transfer also prevents old owned edit cursors from becoming authority.
    const now = f.tables.load().drawings.find((d) => d.id === id)!;
    f.run(
      {
        type: "object.assign",
        objectId: id,
        expectedVersion: now.version,
        expectedOwnerId: f.player.member.id,
        ownerId: other.id,
      },
      f.gm.member,
    );
    assert.throws(() => edit("Former owner", "#123456"));
  } finally {
    f.db.close();
  }
});

test("history 9 to 11 retains text snapshots/links while seeding only legacy style, rejects future edit payloads, and rolls back marker failures", () => {
  for (const mode of ["none", "marker", "future"] as const) {
    const f = fixture();
    try {
      const id = f.add();
      f.run({
        type: "objects.move",
        objects: [{ objectId: id, expectedVersion: 1 }],
        delta: { x: 0.25, y: 1.5 },
      });
      const state = f.tables.load(),
        status = f.history.status(f.player.member),
        rows = f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all();
      // Reconstruct real history-9 snapshots: text existed, style fields did not.
      for (const row of rows) {
        const payload = JSON.parse(String(row.payload_json));
        if (payload.kind === "create" || payload.kind === "delete")
          delete payload.object.textStyle;
        f.db
          .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
          .run(JSON.stringify(payload), row.id as string);
      }
      f.db.exec("UPDATE scene_history_version SET version=9");
      if (mode === "marker")
        f.db.exec(
          "CREATE TRIGGER reject_edit_upgrade BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture edit upgrade'); END",
        );
      if (mode === "future")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=? WHERE sequence=2",
          )
          .run(
            JSON.stringify({
              kind: "text-update",
              objectType: "drawing",
              before: { text: "Old", color: "#123456" },
              after: { text: "Future", color: "#654321" },
            }),
          );
      const expected = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, f.tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          9,
        );
        assert.deepEqual(
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
          expected,
        );
        assert.deepEqual(f.tables.load(), state);
        if (mode === "marker") f.db.exec("DROP TRIGGER reject_edit_upgrade");
        else
          f.db
            .prepare(
              "UPDATE scene_history_entries SET payload_json=? WHERE sequence=2",
            )
            .run(rows[1]!.payload_json as string);
      }
      const history = new SceneHistoryStore(f.db, f.tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        12,
      );
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all()
          .map((row) => ({
            ...row,
            payload_json: JSON.parse(String(row.payload_json)),
          })),
        rows.map((row) => ({
          ...row,
          payload_json: JSON.parse(String(row.payload_json)),
        })),
      );
      assert.deepEqual(history.status(f.player.member), status);
      assert.deepEqual(f.tables.load(), state);
      f.action("scene.undo");
      assert.equal(f.tables.load().drawings[0]!.text, "North gate\nCourtyard");
    } finally {
      f.db.close();
    }
  }
});

test("text style-only edits are bounded, owned and versioned, preserve exact boxes, and undo with wording/color and group geometry", () => {
  const f = fixture();
  try {
    const id = f.add(),
      original = f.tables.load().drawings[0]!,
      style = { font: "serif", weight: "bold", align: "center" } as const;
    const change = {
      type: "drawing.text.update" as const,
      drawingId: id,
      expectedVersion: 1,
      changes: {
        text: original.text!,
        color: original.color,
        textStyle: style,
      },
    };
    f.run(change);
    let label = f.tables.load().drawings[0]!;
    assert.deepEqual(label.textStyle, style);
    assert.deepEqual(label.points, original.points);
    assert.equal(label.ownerId, original.ownerId);
    assert.equal(label.version, 2);
    assert.throws(() => f.run(change));
    for (const bad of [
      { ...style, font: "url(https://example.invalid/font)" },
      { ...style, font: "Comic Sans" },
      { ...style, weight: "900" },
      { ...style, align: "justify" },
      { ...style, tracking: 100 },
      null,
    ]) {
      const before = f.tables.load(),
        status = f.history.status(f.player.member);
      assert.throws(() =>
        f.run({
          ...change,
          expectedVersion: 2,
          changes: { ...change.changes, textStyle: bad },
        } as unknown as CommandInput),
      );
      assert.deepEqual(f.tables.load(), before);
      assert.deepEqual(f.history.status(f.player.member), status);
    }
    assert.throws(() => f.run({ ...change, expectedVersion: 2 }));
    // Omitting style changes preserves the current style through existing wording/color calls.
    f.run({
      type: "drawing.text.update",
      drawingId: id,
      expectedVersion: 2,
      changes: { text: "Longer gate\nShort", color: "#ab1234" },
    });
    assert.deepEqual(f.tables.load().drawings[0]!.textStyle, style);
    const token = randomUUID();
    f.run({
      type: "token.add",
      token: {
        id: token,
        name: "Scout",
        color: "#123456",
        position: { x: 10, y: 10 },
      },
    });
    f.run({
      type: "objects.resize",
      objects: [
        { objectId: id, expectedVersion: 3 },
        { objectId: token, expectedVersion: 1 },
      ],
      scale: 1.25,
    });
    f.action("scene.undo");
    assert.deepEqual(f.tables.load().drawings[0]!.points, original.points);
    assert.deepEqual(f.tables.load().drawings[0]!.textStyle, style);
    f.action("scene.undo"); // token creation
    f.action("scene.undo");
    assert.equal(f.tables.load().drawings[0]!.text, original.text);
    assert.deepEqual(f.tables.load().drawings[0]!.textStyle, style);
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().drawings[0]!.textStyle,
      original.textStyle,
    );
    for (let i = 0; i < 4; i++) f.action("scene.redo");
    label = f.tables.load().drawings[0]!;
    assert.deepEqual(label.textStyle, style);
    assert.equal(label.text, "Longer gate\nShort");
    const saved = f.tables.load(),
      status = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_style_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture style rollback'); END",
    );
    assert.throws(
      () =>
        f.run({
          ...change,
          expectedVersion: label.version,
          changes: {
            ...change.changes,
            textStyle: { font: "sans-serif", weight: "normal", align: "right" },
          },
        }),
      /fixture style rollback/,
    );
    assert.deepEqual(f.tables.load(), saved);
    assert.deepEqual(f.history.status(f.player.member), status);
    f.db.exec("DROP TRIGGER reject_style_receipt");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      status,
    );
  } finally {
    f.db.close();
  }
});

test("campaign 4 and history 10 style upgrade seeds active/offstage and inverse defaults atomically, preserves unrelated state, and rejects future styles", () => {
  for (const mode of [
    "none",
    "campaign-marker",
    "offstage",
    "history-marker",
    "future-history",
  ] as const) {
    const f = fixture();
    try {
      const id = f.add();
      f.run({
        type: "drawing.text.update",
        drawingId: id,
        expectedVersion: 1,
        changes: { text: "Updated gate\nShort", color: "#123456" },
      });
      const offstage = f.tables.createScene(f.gm.member.tableId, {
          name: "Hidden sketch",
        }),
        label = f.tables.load().drawings[0]!,
        offId = randomUUID();
      f.db
        .prepare("UPDATE scene_records SET state_json=? WHERE id=?")
        .run(
          JSON.stringify({ tokens: [], drawings: [{ ...label, id: offId }] }),
          offstage.id,
        );
      f.db
        .prepare(
          "INSERT INTO object_id_reservations(campaign_id,id) VALUES(?,?)",
        )
        .run(f.gm.member.tableId, offId);
      // Real legacy inverse shapes include text in scalar and whole-group deletions.
      const spare = f.add("Spare label");
      f.run({
        type: "objects.delete",
        objects: [
          { objectId: id, expectedVersion: 2 },
          { objectId: spare, expectedVersion: 1 },
        ],
      });
      const third = f.add("Deleted label");
      f.run({ type: "object.delete", objectId: third, expectedVersion: 1 });
      const current = f.tables.load(),
        status = f.history.status(f.player.member),
        historyRows = f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        scenes = f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
        reservations = f.db
          .prepare("SELECT * FROM object_id_reservations ORDER BY id")
          .all();
      const strip = (value: unknown): unknown => {
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(strip);
        return Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== "textStyle")
            .map(([k, v]) => [k, strip(v)]),
        );
      };
      for (const row of f.db
        .prepare("SELECT id,state_json FROM campaign_records")
        .all()) {
        const data = JSON.parse(String(row.state_json));
        data.schemaVersion = 7;
        f.db
          .prepare("UPDATE campaign_records SET state_json=? WHERE id=?")
          .run(JSON.stringify(data), row.id as string);
      }
      for (const row of scenes)
        f.db
          .prepare("UPDATE scene_records SET state_json=? WHERE id=?")
          .run(
            JSON.stringify(strip(JSON.parse(String(row.state_json)))),
            row.id as string,
          );
      for (const row of historyRows)
        f.db
          .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
          .run(
            JSON.stringify(strip(JSON.parse(String(row.payload_json)))),
            row.id as string,
          );
      f.db.exec(
        "UPDATE campaign_storage_version SET version=4; UPDATE scene_history_version SET version=10",
      );
      if (mode === "campaign-marker")
        f.db.exec(
          "CREATE TRIGGER reject_style_campaign BEFORE UPDATE ON campaign_storage_version BEGIN SELECT RAISE(ABORT,'fixture style campaign'); END",
        );
      if (mode === "offstage")
        f.db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
          JSON.stringify({
            tokens: [],
            drawings: [
              {
                ...label,
                id: offId,
                textStyle: { font: "serif", weight: "bold", align: "right" },
              },
            ],
          }),
          offstage.id,
        );
      const oldCampaigns = f.db
          .prepare("SELECT * FROM campaign_records ORDER BY id")
          .all(),
        oldScenes = f.db
          .prepare("SELECT * FROM scene_records ORDER BY id")
          .all();
      if (mode === "campaign-marker" || mode === "offstage") {
        assert.throws(() => new TableStore(f.db));
        assert.equal(
          f.db.prepare("SELECT version FROM campaign_storage_version").get()!
            .version,
          4,
        );
        assert.deepEqual(
          f.db.prepare("SELECT * FROM campaign_records ORDER BY id").all(),
          oldCampaigns,
        );
        assert.deepEqual(
          f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
          oldScenes,
        );
        continue;
      }
      const tables = new TableStore(f.db);
      assert.deepEqual(tables.load(), current);
      assert.equal(
        f.db.prepare("SELECT version FROM campaign_storage_version").get()!
          .version,
        6,
      );
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_records ORDER BY id")
          .all()
          .map((r) => ({ ...r, state_json: JSON.parse(String(r.state_json)) })),
        scenes.map((r) => ({
          ...r,
          state_json: JSON.parse(String(r.state_json)),
        })),
      );
      if (mode === "history-marker")
        f.db.exec(
          "CREATE TRIGGER reject_style_history BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture style history'); END",
        );
      if (mode === "future-history")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=? WHERE sequence=2",
          )
          .run(historyRows[1]!.payload_json as string);
      const oldRows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          10,
        );
        assert.deepEqual(
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
          oldRows,
        );
        if (mode === "history-marker")
          f.db.exec("DROP TRIGGER reject_style_history");
        else
          f.db
            .prepare(
              "UPDATE scene_history_entries SET payload_json=? WHERE sequence=2",
            )
            .run(
              JSON.stringify(
                strip(JSON.parse(String(historyRows[1]!.payload_json))),
              ),
            );
      }
      const history = new SceneHistoryStore(f.db, tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        12,
      );
      assert.deepEqual(history.status(f.player.member), status);
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all()
          .map((r) => ({
            ...r,
            payload_json: JSON.parse(String(r.payload_json)),
          })),
        historyRows.map((r) => ({
          ...r,
          payload_json: JSON.parse(String(r.payload_json)),
        })),
      );
      assert.deepEqual(
        f.db.prepare("SELECT * FROM object_id_reservations ORDER BY id").all(),
        reservations,
      );
      for (let i = 0; i < 5; i++) f.action("scene.undo");
      assert.equal(tables.load().drawings[0]!.text, "North gate\nCourtyard");
      assert.deepEqual(tables.load().drawings[0]!.textStyle, label.textStyle);
    } finally {
      f.db.close();
    }
  }
});
