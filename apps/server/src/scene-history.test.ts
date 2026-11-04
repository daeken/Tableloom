import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { commandSchema } from "@tableloom/core";
import type { Command, CommandInput } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import {
  SceneHistoryStore,
  MAX_MEMBER_SCENE_HISTORY,
} from "./scene-history.js";
import { transaction } from "./database.js";
const KEY = "tableloom-history-tests-not-a-real-key";
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY);
  const gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Player",
    );
  const history = new SceneHistoryStore(db, tables);
  function run(input: CommandInput, actor: Member = player.member) {
    return transaction(db, () => {
      const command = commandSchema.parse({ id: randomUUID(), ...input }),
        before = tables.load(actor.tableId);
      const next =
        command.type === "scene.undo" || command.type === "scene.redo"
          ? history.apply(actor, before, command)
          : applyCommand(
              before,
              command,
              actor,
              command.type === "object.assign"
                ? access.getMember(command.ownerId, actor.tableId)
                : undefined,
            );
      history.record(actor, before, next, command);
      tables.save(next, command.id, actor.tableId);
      return next;
    });
  }
  const add = (actor = player.member, id = randomUUID()) => {
    run(
      {
        type: "token.add",
        token: {
          id,
          name: "Scout",
          color: "#405f4d",
          position: { x: 0, y: 0 },
        },
      },
      actor,
    );
    return id;
  };
  const move = (id: string, x: number, actor = player.member) =>
    run(
      {
        type: "token.move",
        tokenId: id,
        position: { x, y: 0 },
        expectedVersion: tables
          .load(actor.tableId)
          .tokens.find((t) => t.id === id)!.version,
      },
      actor,
    );
  const action = (type: "scene.undo" | "scene.redo", actor = player.member) => {
    const entry =
      history.status(actor)[type === "scene.undo" ? "undo" : "redo"]!;
    return run(
      { type, historyId: entry.id, expectedVersion: entry.version },
      actor,
    );
  };
  return { db, tables, access, gm, player, history, run, add, move, action };
}

test("durable member move stacks rebase causal predecessors across interleaved tokens without rewinding versions", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add();
    f.move(a, 10);
    f.move(b, 20);
    f.move(a, 30);
    const original = f.history.status(f.player.member).undo!;
    assert.equal(
      f.action("scene.undo").tokens.find((t) => t.id === a)!.version,
      4,
    );
    f.action("scene.undo");
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().tokens.map((t) => t.position.x),
      [0, 0],
    );
    f.action("scene.redo");
    f.action("scene.redo");
    f.action("scene.redo");
    assert.deepEqual(
      f.tables.load().tokens.map((t) => t.position.x),
      [30, 20],
    );
    assert.deepEqual(
      f.tables.load().tokens.map((t) => t.version),
      [7, 4],
    );
    assert.equal(f.history.status(f.gm.member).undo, null);
    assert.throws(
      () =>
        f.run({
          type: "scene.undo",
          historyId: original.id,
          expectedVersion: original.version,
        }),
      /changed/,
    );
    const reopened = new SceneHistoryStore(f.db, f.tables);
    assert.deepEqual(
      reopened.status(f.player.member),
      f.history.status(f.player.member),
    );
    f.action("scene.undo");
    f.move(b, 40);
    assert.equal(f.history.status(f.player.member).redo, null);
  } finally {
    f.db.close();
  }
});

test("remote movement including away-and-back and ownership changes permanently break older move chains", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.move(id, 10);
    const cursor = f.history.status(f.player.member).undo!;
    f.move(id, 90, f.gm.member);
    f.move(id, 10, f.gm.member);
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    const before = f.tables.load();
    assert.throws(() => f.action("scene.undo"), /newer edits/);
    assert.deepEqual(f.tables.load(), before);
    f.move(id, 20);
    f.action("scene.undo"); // Does not rebase the move before the GM's intervention.
    assert.equal(f.history.status(f.player.member).undo!.id, cursor.id);
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    const token = f.tables.load().tokens[0]!;
    // Current persisted role wins over a forged GM role.
    f.run(
      {
        type: "object.assign",
        objectId: id,
        expectedVersion: token.version,
        expectedOwnerId: token.ownerId,
        ownerId: f.gm.member.id,
      },
      f.gm.member,
    );
    assert.equal(
      f.history.status({ ...f.player.member, role: "gm" }).redo!.available,
      false,
    );
    assert.throws(
      () => f.action("scene.redo", { ...f.player.member, role: "gm" }),
      /unavailable/,
    );
    f.access.removeMember(f.gm.token, f.player.member.id);
    assert.throws(() => f.history.status(f.player.member), /Sign in/);
  } finally {
    f.db.close();
  }
});

test("deleted IDs cannot be reused and old ordinary edits cannot target a history-restored object", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.move(id, 10);
    f.move(id, 20, f.gm.member);
    f.run(
      { type: "object.delete", objectId: id, expectedVersion: 3 },
      f.gm.member,
    );
    const history = f.history.status(f.gm.member);
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.add(f.player.member, id), /already been used/);
    assert.deepEqual(f.history.status(f.gm.member), history);
    const restored = f.action("scene.undo", f.gm.member).tokens[0]!;
    assert.equal(restored.version, 5);
    assert.equal(restored.position.x, 20);
    assert.throws(
      () => f.run({ type: "object.delete", objectId: id, expectedVersion: 3 }),
      /changed/,
    );
    assert.equal(f.history.status(f.player.member).undo!.available, false);
  } finally {
    f.db.close();
  }
});

test("history is scene-scoped, leaves private activity alone, and prunes bounded prefixes safely", () => {
  const f = fixture();
  try {
    const id = f.add();
    for (let x = 1; x <= MAX_MEMBER_SCENE_HISTORY + 3; x++) f.move(id, x);
    assert.equal(
      f.db.prepare("SELECT count(*) AS count FROM scene_edit_history").get()!
        .count,
      MAX_MEMBER_SCENE_HISTORY,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT previous_id FROM scene_edit_history ORDER BY sequence LIMIT 1",
        )
        .get()!.previous_id,
      null,
    );
    f.action("scene.undo");
    const current = f.history.status(f.player.member);
    f.run({ type: "dice.roll", expression: "d6", visibility: "gm" });
    assert.deepEqual(f.history.status(f.player.member), current);
    const campaign = f.tables.getCampaign(),
      scene = f.tables.createScene(campaign.id, { name: "Other" });
    f.tables.activateScene(campaign.id, scene.id, campaign.version);
    assert.deepEqual(f.history.status(f.player.member), {
      undo: null,
      redo: null,
    });
    f.tables.activateScene(
      campaign.id,
      campaign.activeSceneId,
      f.tables.getCampaign().version,
    );
    assert.deepEqual(f.history.status(f.player.member), current);
    // The campaign cap also evicts prefixes belonging to other members/scenes.
    const insert = f.db.prepare(
      "INSERT INTO scene_edit_history(id,campaign_id,scene_id,actor_id,object_id,state,version,expected_object_version,payload_json) VALUES(?,?,?,?,?,'done',1,1,?)",
    );
    transaction(f.db, () => {
      for (let n = 0; n < 10000; n++)
        insert.run(
          randomUUID(),
          campaign.id,
          scene.id,
          f.gm.member.id,
          id,
          '{"kind":"move","objectType":"token","before":{"x":0,"y":0},"after":{"x":1,"y":0}}',
        );
    });
    f.move(id, 200);
    assert.equal(
      f.db.prepare("SELECT count(*) AS count FROM scene_edit_history").get()!
        .count,
      10000,
    );
  } finally {
    f.db.close();
  }
});

test("history, scene state and receipt roll back together on failed writes; storage and inverse data fail closed", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.move(id, 10);
    const before = f.tables.load(),
      history = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
    );
    assert.throws(() => f.action("scene.undo"), /fixture failure/);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(f.history.status(f.player.member), history);
    f.db.exec("DROP TRIGGER reject_receipt");
    f.run({ type: "object.delete", objectId: id, expectedVersion: 2 });
    const absent = f.tables.load(),
      deletedHistory = f.history.status(f.player.member);
    f.db.exec(
      "CREATE TRIGGER reject_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture restoration failure'); END;",
    );
    assert.throws(() => f.action("scene.undo"), /fixture restoration failure/);
    assert.deepEqual(f.tables.load(), absent);
    assert.deepEqual(f.history.status(f.player.member), deletedHistory);
    f.db.exec("DROP TRIGGER reject_receipt");
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens[0]!.version, 4);
    f.db
      .prepare("UPDATE scene_edit_history SET payload_json=?")
      .run('{"x":"bad"}');
    assert.throws(() => f.history.status(f.player.member));
    f.db.exec("UPDATE scene_history_version SET version=99");
    assert.throws(() => new SceneHistoryStore(f.db, f.tables));
    f.db.exec(
      "UPDATE scene_history_version SET version=2; DROP TABLE scene_edit_history",
    );
    assert.throws(() => new SceneHistoryStore(f.db, f.tables), /incomplete/);
    f.db.exec(
      "DROP TABLE scene_history_version; CREATE TABLE scene_edit_history(id TEXT)",
    );
    assert.throws(
      () => new SceneHistoryStore(f.db, f.tables),
      /missing its version/,
    );
  } finally {
    f.db.close();
  }
});

test("history commands carry only a versioned cursor and cannot bypass the trusted history service", () => {
  const f = fixture();
  try {
    const valid = {
      id: randomUUID(),
      type: "scene.undo",
      historyId: randomUUID(),
      expectedVersion: 1,
    };
    assert.ok(commandSchema.safeParse(valid).success);
    for (const bad of [
      { ...valid, position: { x: 0, y: 0 } },
      { ...valid, ownerId: f.gm.member.id },
      { ...valid, expectedVersion: 0 },
    ])
      assert.equal(commandSchema.safeParse(bad).success, false);
    assert.throws(
      () =>
        applyCommand(
          f.tables.load(),
          commandSchema.parse(valid) as Command,
          f.player.member,
        ),
      /resolved by the server/,
    );
    assert.equal(f.history.status(f.player.member).undo, null);
  } finally {
    f.db.close();
  }
});

test("campaign stacks remain independent for the same identity and token UUID, and legacy moves gain no invented history", () => {
  const f = fixture();
  try {
    const id = f.add(f.gm.member);
    f.move(id, 10, f.gm.member);
    const first = f.history.status(f.gm.member);
    const campaign = f.tables.getCampaign();
    const other = f.tables.createCampaign({
      name: "Other campaign",
      description: "",
      system: campaign.system,
      contentPacks: campaign.contentPacks,
    });
    const gm = f.access.registerCampaign(f.gm.token, other.id);
    f.add(gm, id);
    f.db
      .prepare("DELETE FROM scene_edit_history WHERE campaign_id=?")
      .run(other.id);
    // A pre-history state has no usable inverse to reconstruct.
    const before = f.tables.load(other.id),
      cmd = commandSchema.parse({
        id: randomUUID(),
        type: "token.move",
        tokenId: id,
        position: { x: 90, y: 0 },
        expectedVersion: 1,
      });
    f.tables.save(applyCommand(before, cmd, gm), cmd.id, other.id);
    assert.deepEqual(new SceneHistoryStore(f.db, f.tables).status(gm), {
      undo: null,
      redo: null,
    });
    f.move(id, 100, gm);
    const second = f.history.status(gm);
    assert.notEqual(first.undo!.id, second.undo!.id);
    assert.throws(
      () =>
        f.run(
          {
            type: "scene.undo",
            historyId: first.undo!.id,
            expectedVersion: first.undo!.version,
          },
          gm,
        ),
      /unavailable/,
    );
    f.action("scene.undo", gm);
    assert.equal(f.tables.load(other.id).tokens[0]!.position.x, 90);
    assert.deepEqual(f.history.status(f.gm.member), first);
    assert.equal(f.tables.load().tokens[0]!.position.x, 10);
  } finally {
    f.db.close();
  }
});

test("create/move/delete token history undoes and redoes the whole causal chain with monotonic restored versions", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.move(id, 10);
    f.run({ type: "object.delete", objectId: id, expectedVersion: 2 });
    assert.equal(f.history.status(f.player.member).undo!.action, "delete");
    assert.equal(f.action("scene.undo").tokens[0]!.version, 4);
    assert.equal(f.action("scene.undo").tokens[0]!.version, 5);
    assert.equal(f.action("scene.undo").tokens.length, 0);
    assert.equal(f.history.status(f.player.member).undo, null);
    assert.equal(f.action("scene.redo").tokens[0]!.version, 7);
    assert.equal(f.action("scene.redo").tokens[0]!.version, 8);
    assert.equal(f.action("scene.redo").tokens.length, 0);
    assert.equal(f.action("scene.undo").tokens[0]!.version, 10);
    assert.equal(f.tables.load().tokens[0]!.ownerId, f.player.member.id);
    assert.equal(f.tables.load().tokens[0]!.position.x, 10);
    const before = f.tables.load();
    assert.throws(
      () => f.run({ type: "object.delete", objectId: id, expectedVersion: 2 }),
      /changed/,
    );
    assert.deepEqual(f.tables.load(), before);
  } finally {
    f.db.close();
  }
});

test("drawing creation/deletion history restores exact geometry and original ownership, including GM deletion", () => {
  const f = fixture();
  try {
    for (const kind of ["stroke", "rectangle"] as const) {
      const id = randomUUID(),
        drawing = {
          id,
          kind,
          color: "#405f4d",
          points: [
            { x: 1, y: 2 },
            { x: 30, y: 40 },
            { x: 50, y: 60 },
          ],
        };
      f.run({ type: "drawing.add", drawing });
      const created = f.tables.load().drawings.find((d) => d.id === id)!;
      f.run(
        { type: "object.delete", objectId: id, expectedVersion: 1 },
        f.gm.member,
      );
      assert.equal(f.history.status(f.player.member).undo!.available, false);
      const restored = f
        .action("scene.undo", f.gm.member)
        .drawings.find((d) => d.id === id)!;
      assert.deepEqual({ ...restored, version: 1 }, created);
      assert.equal(restored.version, 3);
      // The GM's intervening delete/restore does not make the creator's old cursor usable.
      assert.equal(f.history.status(f.player.member).undo!.available, false);
      f.action("scene.redo", f.gm.member);
      assert.ok(!f.tables.load().drawings.some((d) => d.id === id));
      f.action("scene.undo", f.gm.member);
      assert.equal(
        f.tables.load().drawings.find((d) => d.id === id)!.version,
        5,
      );
    }
    const id = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id,
        kind: "rectangle",
        color: "#405f4d",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    });
    f.action("scene.undo");
    assert.ok(!f.tables.load().drawings.some((d) => d.id === id));
    f.action("scene.redo");
    assert.equal(f.tables.load().drawings.find((d) => d.id === id)!.version, 3);
  } finally {
    f.db.close();
  }
});

test("reserved IDs reject replacements of another kind, private notes and other scenes even after history eviction", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.action("scene.undo");
    const redo = f.history.status(f.player.member);
    assert.throws(
      () =>
        f.run(
          {
            type: "drawing.add",
            drawing: {
              id,
              kind: "rectangle",
              color: "#405f4d",
              points: [
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ],
            },
          },
          f.gm.member,
        ),
      /already been used/,
    );
    assert.throws(
      () =>
        f.run({
          type: "note.add",
          note: {
            id,
            title: "Private replacement",
            body: "Not a scene object",
            visibility: "gm",
          },
        }),
      /already been used/,
    );
    assert.deepEqual(f.history.status(f.player.member), redo);
    f.db.prepare("DELETE FROM scene_edit_history").run();
    assert.throws(() => f.add(f.player.member, id), /already been used/);
    const campaign = f.tables.getCampaign(),
      scene = f.tables.createScene(campaign.id, { name: "Other scene" });
    f.tables.activateScene(campaign.id, scene.id, campaign.version);
    assert.throws(() => f.add(f.player.member, id), /already been used/);
    assert.equal(f.tables.load().tokens.length, 0);
  } finally {
    f.db.close();
  }
});

test("restore is permission-checked against the saved owner and current role; removed owners remain GM-controlled", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.run(
      { type: "object.delete", objectId: id, expectedVersion: 1 },
      f.gm.member,
    );
    const actor = f.gm.member;
    f.db
      .prepare(
        "UPDATE access_memberships SET role='player' WHERE user_id=? AND table_id=?",
      )
      .run(actor.id, actor.tableId);
    assert.equal(
      f.history.status({ ...actor, role: "gm" }).undo!.available,
      false,
    );
    assert.throws(
      () => f.action("scene.undo", { ...actor, role: "gm" }),
      /ownership changes/,
    );
    f.db
      .prepare(
        "UPDATE access_memberships SET role='gm' WHERE user_id=? AND table_id=?",
      )
      .run(actor.id, actor.tableId);
    f.access.removeMember(f.gm.token, f.player.member.id);
    const restored = f.action("scene.undo", actor).tokens[0]!;
    assert.equal(restored.ownerId, f.player.member.id);
    assert.equal(restored.version, 3);
    assert.throws(() => f.history.status(f.player.member), /Sign in/);
  } finally {
    f.db.close();
  }
});

test("full scenes block restoration without consuming history, and rejected creation cannot erase retained inverses", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.run({ type: "object.delete", objectId: id, expectedVersion: 1 });
    const cursor = f.history.status(f.player.member);
    const before = f.tables.load();
    f.tables.save(
      {
        ...before,
        revision: before.revision + 1,
        tokens: Array.from({ length: 200 }, () => ({
          id: randomUUID(),
          name: "Filler",
          position: { x: 0, y: 0 },
          color: "#405f4d",
          ownerId: f.gm.member.id,
          version: 1,
        })),
      },
      randomUUID(),
    );
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"), /full scene/);
    assert.throws(() => f.add(f.gm.member, id), /token limit/);
    assert.equal(f.history.status(f.player.member).undo!.id, cursor.undo!.id);
    const full = f.tables.load();
    f.tables.save(
      { ...full, revision: full.revision + 1, tokens: full.tokens.slice(1) },
      randomUUID(),
    );
    assert.equal(f.history.status(f.player.member).undo!.available, true);
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens.find((t) => t.id === id)!.version, 3);
  } finally {
    f.db.close();
  }
});

test("history geometry byte retention prunes a contiguous prefix across scenes", () => {
  const f = fixture();
  try {
    const id = f.add(),
      campaign = f.tables.getCampaign();
    const scenes = Array.from({ length: 6 }, (_, i) =>
      f.tables.createScene(campaign.id, { name: `Geometry ${i}` }),
    );
    const points = Array.from({ length: 2000 }, () => ({
      x: 1234.123456789,
      y: 9876.987654321,
    }));
    const insert = f.db.prepare(
      "INSERT INTO scene_edit_history(id,campaign_id,scene_id,actor_id,object_id,state,version,expected_object_version,payload_json) VALUES(?,?,?,?,?,'done',1,1,?)",
    );
    transaction(f.db, () => {
      for (const scene of scenes)
        for (let n = 0; n < 100; n++) {
          const objectId = randomUUID(),
            payload = JSON.stringify({
              kind: "create",
              objectType: "drawing",
              object: {
                id: objectId,
                kind: "stroke",
                points,
                color: "#405f4d",
                ownerId: f.gm.member.id,
                version: 1,
              },
            });
          insert.run(
            randomUUID(),
            campaign.id,
            scene.id,
            f.gm.member.id,
            objectId,
            payload,
          );
        }
    });
    assert.ok(
      Number(
        f.db
          .prepare(
            "SELECT SUM(length(CAST(payload_json AS BLOB))) AS bytes FROM scene_edit_history",
          )
          .get()!.bytes,
      ) >
        32 * 1024 * 1024,
    );
    f.move(id, 10);
    const bytes = Number(
      f.db
        .prepare(
          "SELECT SUM(length(CAST(payload_json AS BLOB))) AS bytes FROM scene_edit_history",
        )
        .get()!.bytes,
    );
    assert.ok(bytes <= 32 * 1024 * 1024);
    assert.equal(f.history.status(f.player.member).undo!.action, "move");
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM scene_edit_history WHERE scene_id=?",
        )
        .get(scenes[0]!.id)!.n,
      0,
    );
  } finally {
    f.db.close();
  }
});

test("object ID reservations have a campaign cap, roll back rejected edits, and fail closed on missing/future storage", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.action("scene.undo");
    const before = f.tables.load(),
      history = f.history.status(f.player.member);
    f.db
      .prepare(
        `WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<249999)
      INSERT INTO object_id_reservations(campaign_id,id) SELECT ?,'ffffffff-ffff-4fff-8fff-'||printf('%012x',n) FROM ids`,
      )
      .run(f.player.member.tableId);
    assert.throws(() => f.add(), /reserved object ID limit/);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(f.history.status(f.player.member), history);
    f.action("scene.redo");
    assert.equal(f.tables.load().tokens[0]!.id, id); // Restores consume no new reservation.
    f.db.exec("UPDATE object_identity_version SET version=99");
    assert.throws(() => new SceneHistoryStore(f.db, f.tables));
    f.db.exec(
      "UPDATE object_identity_version SET version=1; DROP TABLE object_id_reservations",
    );
    assert.throws(() => new SceneHistoryStore(f.db, f.tables), /incomplete/);
    f.db.exec("DROP TABLE object_identity_version");
    assert.throws(
      () => new SceneHistoryStore(f.db, f.tables),
      /missing from scene history/,
    );
  } finally {
    f.db.close();
  }
});
