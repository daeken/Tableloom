import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  tokenLayersOf,
  tokenLayerOf,
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
  const layer = (
    id: string,
    layer: "between-drawings" | "above-drawings",
    member = player.member,
  ) => {
    const state = tables.load(member.tableId);
    return run(
      {
        type: "token.layer.update",
        tokenId: id,
        expectedVersion: state.tokens.find((d) => d.id === id)!.version,
        expectedOrder: state.tokens.map((d) => d.id),
        expectedLayers: tokenLayersOf(state.tokens),
        layer,
      },
      member,
    );
  };
  return { db, tables, access, gm, player, history, run, action, add, layer };
}

test("token layer, same-layer ordering and exact absence survive move/size/delete cycles and atomic rollback", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add(),
      original = f.tables.load();
    const ids = () => f.tables.load().tokens.map((t) => t.id);
    f.layer(a, "above-drawings");
    assert.deepEqual(ids(), [a, b, c]);
    for (const token of original.tokens)
      assert.deepEqual(
        f.tables.load().tokens.find((t) => t.id === token.id),
        token.id === a
          ? { ...token, layer: "above-drawings", version: 2 }
          : token,
      );
    assert.equal(f.history.status(f.player.member).undo!.action, "layer");
    assert.equal(f.history.status(f.player.member).undo!.name, "Scout");
    const reorder = () =>
      f.run({
        type: "token.reorder",
        tokenId: a,
        expectedVersion: f.tables.load().tokens.find((t) => t.id === a)!
          .version,
        expectedOrder: ids(),
        expectedLayers: tokenLayersOf(f.tables.load().tokens),
        direction: "front",
      });
    assert.throws(reorder, /already/);
    assert.throws(() => f.layer(a, "above-drawings"));
    f.layer(b, "above-drawings");
    reorder();
    assert.deepEqual(ids(), [b, c, a]);
    f.action("scene.undo");
    f.action("scene.undo");
    f.action("scene.undo");
    assert.deepEqual(ids(), [a, b, c]);
    assert.ok(f.tables.load().tokens.every((t) => !("layer" in t)));
    f.action("scene.redo");
    f.action("scene.redo");
    f.action("scene.redo");
    f.run({
      type: "token.resize",
      tokenId: a,
      expectedVersion: f.tables.load().tokens.at(-1)!.version,
      radius: 65,
    });
    f.run({
      type: "token.move",
      tokenId: a,
      expectedVersion: f.tables.load().tokens.at(-1)!.version,
      position: { x: 250, y: 350 },
    });
    f.run({
      type: "object.delete",
      objectId: a,
      expectedVersion: f.tables.load().tokens.at(-1)!.version,
    });
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens.at(-1)!.layer, "above-drawings");
    assert.equal(f.tables.load().tokens.at(-1)!.radius, 65);
    assert.deepEqual(ids(), [b, c, a]);
    f.action("scene.undo");
    f.action("scene.undo");
    f.action("scene.undo");
    assert.deepEqual(ids(), [a, b, c]);
    assert.equal(f.tables.load().tokens[0]!.radius, 24);
    const state = f.tables.load(),
      cursor = f.history.status(f.player.member),
      rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    f.db.exec(
      "CREATE TRIGGER reject_token_layer_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture token layer receipt'); END",
    );
    assert.throws(
      () => f.layer(c, "above-drawings"),
      /fixture token layer receipt/,
    );
    assert.deepEqual(f.tables.load(), state);
    assert.deepEqual(f.history.status(f.player.member), cursor);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    f.db.exec("DROP TRIGGER reject_token_layer_receipt");
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      cursor,
    );
    f.layer(a, "between-drawings");
    f.layer(a, "above-drawings");
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens[0]!.layer, "between-drawings");
    assert.ok("layer" in f.tables.load().tokens[0]!);
  } finally {
    f.db.close();
  }
});

test("token layer/order guards reject stale peer layers, foreign or transferred targets and preserve unrelated drawing changes", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      other = f.access.redeemInvitation(
        f.access.createInvitation(f.gm.token).token,
        "Other",
      ).member;
    assert.throws(() => f.layer(a, "above-drawings", other));
    const command = {
      type: "token.layer.update" as const,
      tokenId: a,
      expectedVersion: 1,
      expectedOrder: [a, b],
      expectedLayers: tokenLayersOf(f.tables.load().tokens),
      layer: "above-drawings" as const,
    };
    f.layer(b, "above-drawings", f.gm.member);
    assert.throws(() => f.run(command), /layers changed/);
    assert.equal(f.tables.load().tokens[0]!.version, 1);
    f.action("scene.undo", f.gm.member);
    f.run(command);
    const drawingId = randomUUID();
    f.run(
      {
        type: "drawing.add",
        drawing: {
          id: drawingId,
          kind: "rectangle",
          color: "#123456",
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
        },
      },
      f.gm.member,
    );
    assert.equal(f.history.status(f.player.member).undo!.available, true);
    f.layer(b, "above-drawings", f.gm.member);
    const saved = f.tables.load();
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
    assert.deepEqual(f.tables.load(), saved);
    f.action("scene.undo", f.gm.member);
    f.action("scene.undo");
    f.action("scene.redo");
    f.layer(b, "above-drawings");
    f.run({
      type: "token.reorder",
      tokenId: a,
      expectedVersion: f.tables.load().tokens[0]!.version,
      expectedOrder: [a, b],
      expectedLayers: ["above-drawings", "above-drawings"],
      direction: "front",
    });
    f.layer(b, "between-drawings", f.gm.member);
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"));
    f.action("scene.undo", f.gm.member);
    f.action("scene.undo");
    const now = f.tables.load().tokens[0]!;
    f.run(
      {
        type: "object.assign",
        objectId: a,
        expectedVersion: now.version,
        expectedOwnerId: now.ownerId,
        ownerId: other.id,
      },
      f.gm.member,
    );
    assert.throws(() => f.layer(a, "between-drawings"));
    assert.equal(f.history.status(f.player.member).undo!.available, false);
  } finally {
    f.db.close();
  }
});

test("table-10 token defaults and layer vectors validate strictly without accepting drawing/private layers or creation-supplied overrides", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      state = f.tables.load(),
      old = { ...state, schemaVersion: 10 };
    assert.deepEqual(restoreTable(old).state, state);
    assert.equal(restoreTable(old).migrated, true);
    assert.throws(() =>
      restoreTable({
        ...old,
        tokens: [{ ...old.tokens[0], layer: "above-drawings" }, old.tokens[1]],
      }),
    );
    const command = {
      id: randomUUID(),
      type: "token.layer.update",
      tokenId: a,
      expectedVersion: 1,
      expectedOrder: [a, b],
      expectedLayers: ["between-drawings", "between-drawings"],
      layer: "above-drawings",
    };
    for (const fields of [
      { layer: "above-tokens" },
      { layer: "gm" },
      { layer: null },
      { expectedLayers: ["between-drawings"] },
      { expectedLayers: ["between-drawings", "hidden"] },
      { expectedOrder: [a, a] },
      { ownerId: f.player.member.id },
    ])
      assert.equal(
        commandSchema.safeParse({ ...command, ...fields }).success,
        false,
      );
    assert.equal(commandSchema.safeParse(command).success, true);
    assert.equal(
      commandSchema.safeParse({ ...command, expectedLayers: undefined })
        .success,
      false,
    );
    assert.equal(
      commandSchema.safeParse({
        id: randomUUID(),
        type: "token.add",
        token: {
          id: randomUUID(),
          name: "Scout",
          position: { x: 0, y: 0 },
          color: "#123456",
          layer: "above-drawings",
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
        objectType: "token",
        before: null,
        after: "between-drawings",
        order: [a, b],
        layers: ["between-drawings", "between-drawings"],
      },
      {
        kind: "layer",
        objectType: "token",
        before: null,
        after: "above-drawings",
        order: [b],
        layers: ["between-drawings"],
      },
      {
        kind: "layer",
        objectType: "token",
        before: null,
        after: "above-drawings",
        order: [a, b],
        layers: ["above-drawings", "between-drawings"],
      },
    ])
      assert.throws(() =>
        entryOf({ ...row, payload_json: JSON.stringify(payload) }),
      );
    assert.equal(
      payloadSchema.safeParse({
        kind: "reorder",
        objectType: "token",
        before: [a, b],
        after: [b, a],
        layers: ["between-drawings"],
      }).success,
      false,
    );
    assert.equal(tokenLayerOf(state.tokens[0]!), "between-drawings");
  } finally {
    f.db.close();
  }
});

test("campaign 7/history 16 upgrades regular tokens across all scenes while preserving drawing layers/inverses and rolling back future token data", () => {
  for (const mode of [
    "none",
    "campaign-marker",
    "offstage-token",
    "history-marker",
    "future-snapshot",
    "future-payload",
    "future-layers",
  ] as const) {
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
            { x: 100, y: 100 },
          ],
        },
      });
      f.run({
        type: "drawing.layer.update",
        drawingId,
        expectedVersion: 1,
        expectedOrder: [drawingId],
        expectedLayers: ["below-tokens"],
        layer: "above-tokens",
      });
      const before = f.tables.load(),
        off = f.tables.createScene(f.gm.member.tableId, {
          name: "Hidden layers",
        }),
        offToken = randomUUID(),
        offDrawing = randomUUID();
      f.db.prepare("UPDATE scene_records SET state_json=? WHERE id=?").run(
        JSON.stringify({
          tokens: [{ ...before.tokens[0], id: offToken }],
          drawings: [{ ...before.drawings[0], id: offDrawing }],
        }),
        off.id,
      );
      for (const id of [offToken, offDrawing])
        f.db
          .prepare(
            "INSERT INTO object_id_reservations(campaign_id,id) VALUES(?,?)",
          )
          .run(f.gm.member.tableId, id);
      f.run({
        type: "token.reorder",
        tokenId: a,
        expectedVersion: 1,
        expectedOrder: [a, b],
        expectedLayers: ["between-drawings", "between-drawings"],
        direction: "front",
      });
      f.run({
        type: "objects.delete",
        objects: [
          { objectId: a, expectedVersion: 2 },
          { objectId: drawingId, expectedVersion: 2 },
        ],
      });
      f.db.exec(
        "UPDATE scene_history_entries SET payload_json=json_remove(payload_json,'$.layers') WHERE json_extract(payload_json,'$.kind')='reorder' AND json_extract(payload_json,'$.objectType')='token'",
      );
      const state = f.tables.load(),
        status = f.history.status(f.player.member),
        rows = () =>
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
        original = rows(),
        reorder = original.find(
          (row) => JSON.parse(String(row.payload_json)).kind === "reorder",
        )!;
      for (const row of f.db
        .prepare("SELECT id,state_json FROM campaign_records")
        .all()) {
        const data = JSON.parse(String(row.state_json));
        data.schemaVersion = 10;
        f.db
          .prepare("UPDATE campaign_records SET state_json=? WHERE id=?")
          .run(JSON.stringify(data), row.id!);
      }
      f.db.exec(
        "UPDATE campaign_storage_version SET version=7; UPDATE scene_history_version SET version=16",
      );
      if (mode === "campaign-marker")
        f.db.exec(
          "CREATE TRIGGER reject_token_layer_campaign BEFORE UPDATE ON campaign_storage_version BEGIN SELECT RAISE(ABORT,'fixture token layer campaign'); END",
        );
      if (mode === "offstage-token")
        f.db
          .prepare(
            "UPDATE scene_records SET state_json=json_set(state_json,'$.tokens[0].layer','above-drawings') WHERE id=?",
          )
          .run(off.id);
      const campaigns = f.db
          .prepare("SELECT * FROM campaign_records ORDER BY id")
          .all(),
        scenes = f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
        reservations = f.db
          .prepare("SELECT * FROM object_id_reservations ORDER BY id")
          .all();
      if (mode === "campaign-marker" || mode === "offstage-token") {
        assert.throws(() => new TableStore(f.db));
        assert.equal(
          f.db.prepare("SELECT version FROM campaign_storage_version").get()!
            .version,
          7,
        );
        assert.deepEqual(
          f.db.prepare("SELECT * FROM campaign_records ORDER BY id").all(),
          campaigns,
        );
        assert.deepEqual(
          f.db.prepare("SELECT * FROM scene_records ORDER BY id").all(),
          scenes,
        );
        assert.deepEqual(rows(), original);
        continue;
      }
      const tables = new TableStore(f.db);
      assert.deepEqual(tables.load(), state);
      assert.equal(
        f.db.prepare("SELECT version FROM campaign_storage_version").get()!
          .version,
        8,
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
            schemaVersion: 11,
          },
        })),
      );
      if (mode === "history-marker")
        f.db.exec(
          "CREATE TRIGGER reject_token_layer_history BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture token layer history'); END",
        );
      if (mode === "future-snapshot")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=json_set(payload_json,'$.objects[0].object.layer','above-drawings') WHERE id=?",
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
              objectType: "token",
              before: null,
              after: "above-drawings",
              order: [a, b],
              layers: ["between-drawings", "between-drawings"],
            }),
          );
      if (mode === "future-layers")
        f.db
          .prepare(
            "UPDATE scene_history_entries SET payload_json=json_set(payload_json,'$.layers',json(?)) WHERE id=?",
          )
          .run(
            JSON.stringify(["between-drawings", "between-drawings"]),
            reorder.id!,
          );
      const captured = rows();
      if (mode !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          16,
        );
        assert.deepEqual(rows(), captured);
        assert.deepEqual(tables.load(), state);
        if (mode === "history-marker")
          f.db.exec("DROP TRIGGER reject_token_layer_history");
        else
          for (const row of original)
            f.db
              .prepare(
                "UPDATE scene_history_entries SET payload_json=? WHERE id=?",
              )
              .run(row.payload_json!, row.id!);
      }
      const upgraded = new SceneHistoryStore(f.db, tables);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        17,
      );
      assert.deepEqual(rows(), original);
      assert.deepEqual(upgraded.status(f.player.member), status);
      assert.deepEqual(
        f.db.prepare("SELECT * FROM object_id_reservations ORDER BY id").all(),
        reservations,
      );
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().tokens.map((t) => t.id),
        [b, a],
      );
      assert.ok(f.tables.load().tokens.every((t) => !("layer" in t)));
      assert.equal(f.tables.load().drawings[0]!.layer, "above-tokens");
      f.layer(b, "above-drawings", f.gm.member);
      assert.equal(upgraded.status(f.player.member).undo!.available, false);
      f.action("scene.undo", f.gm.member);
      f.action("scene.undo");
      assert.deepEqual(
        f.tables.load().tokens.map((t) => t.id),
        [a, b],
      );
    } finally {
      f.db.close();
    }
  }
});

test("mixed restoration returns upper tokens and drawings to saved layers/slots while preserving a survivor's newer layer", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      drawingId = randomUUID();
    f.layer(a, "above-drawings");
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawingId,
        kind: "rectangle",
        color: "#123456",
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
      },
    });
    f.run({
      type: "drawing.layer.update",
      drawingId,
      expectedVersion: 1,
      expectedOrder: [drawingId],
      expectedLayers: ["below-tokens"],
      layer: "above-tokens",
    });
    const original = f.tables.load();
    f.run({
      type: "objects.delete",
      objects: [
        { objectId: drawingId, expectedVersion: 2 },
        { objectId: a, expectedVersion: 2 },
      ],
    });
    f.layer(b, "above-drawings", f.gm.member);
    const survivor = f.tables.load().tokens[0]!;
    assert.equal(f.history.status(f.player.member).undo!.available, true);
    f.action("scene.undo");
    const restored = f.tables.load();
    assert.deepEqual(
      restored.tokens.map((token) => token.id),
      [a, b],
    );
    assert.deepEqual(restored.tokens[0], {
      ...original.tokens[0]!,
      version: 4,
    });
    assert.deepEqual(restored.tokens[1], survivor);
    assert.deepEqual(restored.drawings, [
      { ...original.drawings[0]!, version: 4 },
    ]);
    f.action("scene.redo");
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens[0]!.layer, "above-drawings");
    assert.equal(f.tables.load().drawings[0]!.layer, "above-tokens");
    assert.deepEqual(f.tables.load().tokens[1], survivor);
  } finally {
    f.db.close();
  }
});
