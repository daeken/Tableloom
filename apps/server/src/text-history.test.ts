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
            9,
          );
        }
      }
    } finally {
      f.db.close();
    }
  }
});
