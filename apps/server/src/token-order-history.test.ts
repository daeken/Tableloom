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
  const add = () => {
    const id = randomUUID();
    run({
      type: "token.add",
      token: {
        id,
        name: "Scout",
        color: "#405f4d",
        position: { x: 110, y: 100 },
      },
    });
    return id;
  };
  return { db, tables, access, gm, player, history, run, action, add };
}

test("token arrangement preserves content/ownership and target-only versions through move, deletion and exact causal history", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add();
    const ids = () => f.tables.load().tokens.map((token) => token.id);
    const arrange = (
      id: string,
      direction: "front" | "back",
      member = f.player.member,
    ) =>
      f.run(
        {
          type: "token.reorder",
          tokenId: id,
          direction,
          expectedVersion: f.tables
            .load()
            .tokens.find((token) => token.id === id)!.version,
          expectedOrder: ids(),
        },
        member,
      );
    const before = f.tables.load();
    arrange(b, "back");
    assert.deepEqual(ids(), [b, a, c]);
    for (const token of before.tokens)
      assert.deepEqual(
        f.tables.load().tokens.find((object) => object.id === token.id),
        { ...token, version: token.id === b ? 2 : 1 },
      );
    const other = f.access.redeemInvitation(
      f.access.createInvitation(f.gm.token).token,
      "Other",
    ).member;
    assert.throws(() => arrange(a, "front", other));
    assert.throws(() => arrange(b, "back"));
    assert.throws(() =>
      f.run({
        type: "token.reorder",
        tokenId: a,
        expectedVersion: 1,
        expectedOrder: [a, b, c],
        direction: "front",
      }),
    );
    f.run({
      type: "token.move",
      tokenId: b,
      expectedVersion: 2,
      position: { x: 40, y: 50 },
    });
    f.run({ type: "object.delete", objectId: a, expectedVersion: 1 });
    f.action("scene.undo");
    assert.deepEqual(ids(), [b, a, c]);
    f.action("scene.undo");
    f.action("scene.undo");
    assert.deepEqual(ids(), [a, b, c]);
    assert.deepEqual(
      f.tables.load().tokens.find((token) => token.id === b)!.position,
      before.tokens[1]!.position,
    );
    f.action("scene.redo");
    f.action("scene.redo");
    f.action("scene.redo");
    assert.deepEqual(ids(), [b, c]);
    f.action("scene.undo");
    assert.deepEqual(ids(), [b, a, c]);
    const state = f.tables.load(),
      rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    f.db.exec(
      "CREATE TRIGGER reject_token_order BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture token order'); END",
    );
    assert.throws(() => arrange(c, "back"), /fixture token order/);
    assert.deepEqual(f.tables.load(), state);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    f.db.exec("DROP TRIGGER reject_token_order");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      f.history.status(f.player.member),
    );
  } finally {
    f.db.close();
  }
});

test("mixed restoration guards both stacks, retains survivor edits and original slots regardless of request order, and captures latest slots on redo", () => {
  for (const kind of ["token", "drawing"] as const) {
    const f = fixture();
    try {
      const a = f.add(),
        b = f.add(),
        c = f.add(),
        drawingIds = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of drawingIds)
        f.run({
          type: "drawing.add",
          drawing: {
            id,
            kind: "rectangle",
            points: [
              { x: 0, y: 0 },
              { x: 100, y: 100 },
            ],
            color: "#123456",
          },
        });
      const before = f.tables.load();
      f.run({
        type: "objects.delete",
        objects: [c, drawingIds[1]!, a].map((objectId) => ({
          objectId,
          expectedVersion: 1,
        })),
      });
      const survivor = kind === "token" ? b : drawingIds[0]!;
      const order = kind === "token" ? [b] : [drawingIds[0]!, drawingIds[2]!];
      if (kind === "token")
        f.run(
          {
            type: "token.add",
            token: {
              id: randomUUID(),
              name: "Visitor",
              position: { x: 300, y: 300 },
              color: "#abcdef",
            },
          },
          f.gm.member,
        );
      else
        f.run(
          {
            expectedLayers: order.map(() => "below-tokens" as const),
            type: "drawing.reorder",
            drawingId: survivor,
            expectedVersion: 1,
            expectedOrder: order,
            direction: "front",
          },
          f.gm.member,
        );
      const concurrent = f.tables.load(),
        status = f.history.status(f.player.member);
      assert.equal(status.undo!.available, false);
      assert.throws(() => f.action("scene.undo"));
      assert.deepEqual(f.tables.load(), concurrent);
      assert.deepEqual(f.history.status(f.player.member), status);
      f.action("scene.undo", f.gm.member);
      f.run(
        {
          type: "token.move",
          tokenId: b,
          expectedVersion: 1,
          position: { x: 500, y: 600 },
        },
        f.gm.member,
      );
      assert.equal(f.history.status(f.player.member).undo!.available, true);
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().tokens.map((token) => token.id),
        [a, b, c],
      );
      assert.deepEqual(
        f.tables.load().drawings.map((drawing) => drawing.id),
        drawingIds,
      );
      assert.deepEqual(
        f.tables.load().tokens.find((token) => token.id === b)!.position,
        { x: 500, y: 600 },
      );
      for (const id of [a, c])
        assert.deepEqual(
          f.tables.load().tokens.find((token) => token.id === id),
          { ...before.tokens.find((token) => token.id === id)!, version: 3 },
        );
      // Removing unchanged targets preserves a newer survivor stack, then remembers it.
      f.run(
        {
          type: "token.reorder",
          tokenId: b,
          expectedVersion: 2,
          expectedOrder: [a, b, c],
          direction: "front",
        },
        f.gm.member,
      );
      f.action("scene.redo");
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().tokens.map((token) => token.id),
        [a, c, b],
      );
    } finally {
      f.db.close();
    }
  }
});

test("history 14 upgrades drawing slots byte-for-byte but rejects future token ordering/slots and failed marker writes", () => {
  for (const mode of ["none", "marker", "order", "slots"] as const) {
    const f = fixture();
    try {
      const a = f.add(),
        b = f.add(),
        drawingId = randomUUID();
      f.run({
        type: "drawing.add",
        drawing: {
          id: drawingId,
          kind: "rectangle",
          color: "#123456",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
        },
      });
      f.run({
        type: "objects.delete",
        objects: [a, drawingId].map((objectId) => ({
          objectId,
          expectedVersion: 1,
        })),
      });
      f.db.exec(
        "UPDATE scene_history_entries SET payload_json=json_remove(payload_json,'$.tokenOrder') WHERE json_type(payload_json,'$.tokenOrder') IS NOT NULL",
      );
      const status = f.history.status(f.player.member),
        state = f.tables.load(),
        rows = () =>
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
        original = rows();
      f.db.exec("UPDATE scene_history_version SET version=14");
      if (mode === "marker")
        f.db.exec(
          "CREATE TRIGGER reject_token_upgrade BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture token upgrade'); END",
        );
      if (mode === "slots")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=json_set(payload_json,'$.tokenOrder',json(?)) WHERE id=?",
          )
          .run(JSON.stringify([a, b]), status.undo!.id);
      if (mode === "order")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=? WHERE sequence=1",
          )
          .run(
            JSON.stringify({
              kind: "reorder",
              objectType: "token",
              before: [a, b],
              after: [b, a],
            }),
          );
      const captured = rows();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, f.tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          14,
        );
        assert.deepEqual(rows(), captured);
        assert.deepEqual(f.tables.load(), state);
        if (mode === "marker") f.db.exec("DROP TRIGGER reject_token_upgrade");
        else
          for (const row of original)
            f.db
              .prepare(
                "UPDATE scene_history_entries SET payload_json=? WHERE id=?",
              )
              .run(row.payload_json!, row.id!);
      }
      const upgraded = new SceneHistoryStore(f.db, f.tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        16,
      );
      assert.deepEqual(rows(), original);
      assert.deepEqual(upgraded.status(f.player.member), status);
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().tokens.map((token) => token.id),
        [b, a],
      ); // Legacy token slots never existed.
      assert.deepEqual(
        f.tables.load().drawings.map((drawing) => drawing.id),
        [drawingId],
      );
      f.action("scene.redo");
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().tokens.map((token) => token.id),
        [b, a],
      );
    } finally {
      f.db.close();
    }
  }
});

test("token inverse orders validate target relationships and strict restoration fields", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add();
    f.run({
      type: "token.reorder",
      tokenId: a,
      expectedVersion: 1,
      expectedOrder: [a, b],
      direction: "front",
    });
    const row = f.db
      .prepare(
        "SELECT * FROM scene_history_entries ORDER BY sequence DESC LIMIT 1",
      )
      .get()!;
    for (const payload of [
      { kind: "reorder", objectType: "token", before: [a, b], after: [a, b] },
      {
        kind: "reorder",
        objectType: "token",
        before: [a, b],
        after: [b, randomUUID()],
      },
      { kind: "reorder", objectType: "token", before: [a, b], after: [b, b] },
      {
        kind: "reorder",
        objectType: "token",
        before: Array.from({ length: 201 }, () => randomUUID()),
        after: [b, a],
      },
    ])
      assert.throws(() =>
        entryOf({ ...row, payload_json: JSON.stringify(payload) }),
      );
    f.run({ type: "object.delete", objectId: a, expectedVersion: 2 });
    const deletion = f.db
      .prepare(
        "SELECT * FROM scene_history_entries ORDER BY sequence DESC LIMIT 1",
      )
      .get()!;
    const payload = JSON.parse(String(deletion.payload_json));
    for (const tokenOrder of [
      [],
      [b],
      [a, a],
      ["invalid"],
      Array.from({ length: 201 }, () => randomUUID()),
    ])
      assert.throws(() =>
        entryOf({
          ...deletion,
          payload_json: JSON.stringify({ ...payload, tokenOrder }),
        }),
      );
    assert.equal(
      payloadSchema.safeParse({ ...payload, drawingOrder: [a] }).success,
      false,
    );
  } finally {
    f.db.close();
  }
});
