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
      f.db.prepare("SELECT count(*) AS count FROM scene_history_entries").get()!
        .count,
      MAX_MEMBER_SCENE_HISTORY,
    );
    const oldest = JSON.parse(
      String(
        f.db
          .prepare(
            "SELECT targets_json FROM scene_history_entries ORDER BY sequence LIMIT 1",
          )
          .get()!.targets_json,
      ),
    )[0];
    assert.equal(
      f.db
        .prepare("SELECT id FROM scene_history_entries WHERE id=?")
        .get(oldest.previousId),
      undefined,
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
      "INSERT INTO scene_history_entries(id,campaign_id,scene_id,actor_id,state,version,targets_json,payload_json) VALUES(?,?,?,?,'done',1,?,?)",
    );
    transaction(f.db, () => {
      for (let n = 0; n < 10000; n++)
        insert.run(
          randomUUID(),
          campaign.id,
          scene.id,
          f.gm.member.id,
          JSON.stringify([
            { objectId: id, expectedVersion: 1, previousId: null },
          ]),
          '{"kind":"move","objectType":"token","before":{"x":0,"y":0},"after":{"x":1,"y":0}}',
        );
    });
    f.move(id, 200);
    assert.equal(
      f.db.prepare("SELECT count(*) AS count FROM scene_history_entries").get()!
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
      .prepare("UPDATE scene_history_entries SET payload_json=?")
      .run('{"x":"bad"}');
    assert.throws(() => f.history.status(f.player.member));
    f.db.exec("UPDATE scene_history_version SET version=99");
    assert.throws(() => new SceneHistoryStore(f.db, f.tables));
    f.db.exec(
      "UPDATE scene_history_version SET version=2; DROP TABLE scene_history_entries",
    );
    assert.throws(() => new SceneHistoryStore(f.db, f.tables), /incomplete/);
    f.db.exec(
      "DROP TABLE scene_history_version; CREATE TABLE scene_history_entries(id TEXT)",
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
      .prepare("DELETE FROM scene_history_entries WHERE campaign_id=?")
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
    f.db.prepare("DELETE FROM scene_history_entries").run();
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
          radius: 24,
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
      "INSERT INTO scene_history_entries(id,campaign_id,scene_id,actor_id,state,version,targets_json,payload_json) VALUES(?,?,?,?,'done',1,?,?)",
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
            JSON.stringify([
              { objectId, expectedVersion: 1, previousId: null },
            ]),
            payload,
          );
        }
    });
    assert.ok(
      Number(
        f.db
          .prepare(
            "SELECT SUM(length(CAST(payload_json AS BLOB))) AS bytes FROM scene_history_entries",
          )
          .get()!.bytes,
      ) >
        32 * 1024 * 1024,
    );
    f.move(id, 10);
    const bytes = Number(
      f.db
        .prepare(
          "SELECT SUM(length(CAST(payload_json AS BLOB))) AS bytes FROM scene_history_entries",
        )
        .get()!.bytes,
    );
    assert.ok(bytes <= 32 * 1024 * 1024);
    assert.equal(f.history.status(f.player.member).undo!.action, "move");
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM scene_history_entries WHERE scene_id=?",
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

test("a token group is one revision/history edit and its per-target causal links survive full undo/redo cycles", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add();
    f.move(a, 10);
    const before = f.tables.load(),
      count = Number(
        f.db.prepare("SELECT count(*) AS n FROM scene_history_entries").get()!
          .n,
      );
    f.run({
      type: "tokens.move",
      moves: [
        { tokenId: a, expectedVersion: 2, position: { x: 20, y: 0 } },
        { tokenId: b, expectedVersion: 1, position: { x: 30, y: 0 } },
      ],
    });
    assert.equal(f.tables.load().revision, before.revision + 1);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM scene_history_entries").get()!.n,
      count + 1,
    );
    const cursor = f.history.status(f.player.member).undo!;
    assert.equal(cursor.objectCount, 2);
    assert.equal(cursor.name, "2 tokens");
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().tokens.map((token) => token.position.x),
      [10, 0],
    );
    f.action("scene.undo");
    f.action("scene.undo");
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens.length, 0);
    f.action("scene.redo");
    f.action("scene.redo");
    f.action("scene.redo");
    f.action("scene.redo");
    assert.deepEqual(
      f.tables.load().tokens.map((token) => [token.position.x, token.version]),
      [
        [20, 9],
        [30, 6],
      ],
    );
    assert.throws(
      () =>
        f.run({
          type: "scene.undo",
          historyId: cursor.id,
          expectedVersion: cursor.version,
        }),
      /changed/,
    );
    assert.deepEqual(
      new SceneHistoryStore(f.db, f.tables).status(f.player.member),
      f.history.status(f.player.member),
    );
  } finally {
    f.db.close();
  }
});

test("overlapping token groups undo independently per target but one intervening remote edit blocks an entire group", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      c = f.add();
    const group = (ids: string[], x: number) =>
      f.run({
        type: "tokens.move",
        moves: ids.map((tokenId) => ({
          tokenId,
          expectedVersion: f.tables
            .load()
            .tokens.find((token) => token.id === tokenId)!.version,
          position: { x, y: 0 },
        })),
      });
    group([a, b], 10);
    group([b, c], 20);
    group([a, c], 30);
    for (let n = 0; n < 3; n++) f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().tokens.map((token) => token.position.x),
      [0, 0, 0],
    );
    for (let n = 0; n < 3; n++) f.action("scene.redo");
    assert.deepEqual(
      f.tables.load().tokens.map((token) => token.position.x),
      [30, 20, 30],
    );
    f.move(b, 90, f.gm.member);
    f.action("scene.undo"); // A/C undo remains valid.
    assert.deepEqual(
      f.tables.load().tokens.map((token) => token.position.x),
      [10, 90, 20],
    );
    const before = f.tables.load();
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"), /entire edit/);
    assert.deepEqual(f.tables.load(), before);
    assert.equal(f.history.status(f.gm.member).undo!.objectCount, 1);
  } finally {
    f.db.close();
  }
});

test("group commands reject stale, unauthorized, missing, duplicate or invalid targets without partial edits or history", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      other = f.add(f.gm.member);
    const valid = { tokenId: a, expectedVersion: 1, position: { x: 10, y: 0 } };
    const reject = (second: typeof valid) => {
      const before = f.tables.load(),
        history = f.history.status(f.player.member);
      assert.throws(() =>
        f.run({ type: "tokens.move", moves: [valid, second] }),
      );
      assert.deepEqual(f.tables.load(), before);
      assert.deepEqual(f.history.status(f.player.member), history);
    };
    reject({ ...valid, tokenId: b, expectedVersion: 2 });
    reject({ ...valid, tokenId: other });
    reject({ ...valid, tokenId: randomUUID() });
    reject(valid);
    reject({ ...valid, tokenId: b, position: { x: 10001, y: 0 } });
    for (const moves of [
      [valid],
      Array.from({ length: 101 }, () => ({ ...valid, tokenId: randomUUID() })),
    ])
      assert.equal(
        commandSchema.safeParse({
          id: randomUUID(),
          type: "tokens.move",
          moves,
        }).success,
        false,
      );
  } finally {
    f.db.close();
  }
});

test("group history and all neighboring cursor rebases roll back with a failed receipt write", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add();
    f.run({
      type: "tokens.move",
      moves: [
        { tokenId: a, expectedVersion: 1, position: { x: 10, y: 0 } },
        { tokenId: b, expectedVersion: 1, position: { x: 20, y: 0 } },
      ],
    });
    const before = f.tables.load(),
      rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    f.db.exec(
      "CREATE TRIGGER reject_group_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture group failure'); END;",
    );
    assert.throws(() => f.action("scene.undo"), /fixture group failure/);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    f.db.exec("DROP TRIGGER reject_group_receipt");
    f.action("scene.undo");
    assert.deepEqual(
      f.tables.load().tokens.map((token) => token.position.x),
      [0, 0],
    );
    f.db
      .prepare("UPDATE scene_history_entries SET targets_json=? WHERE id=?")
      .run("[]", f.history.status(f.player.member).redo!.id);
    assert.throws(() => f.history.status(f.player.member));
  } finally {
    f.db.close();
  }
});

test("a bounded hundred-token move and its undo remain one persisted history entry", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 100 }, () => f.add());
    f.run({
      type: "tokens.move",
      moves: ids.map((tokenId) => ({
        tokenId,
        expectedVersion: 1,
        position: { x: 50, y: 60 },
      })),
    });
    assert.equal(f.history.status(f.player.member).undo!.objectCount, 100);
    const view = f.action("scene.undo");
    assert.ok(
      view.tokens.every(
        (token) =>
          token.version === 3 &&
          token.position.x === 0 &&
          token.position.y === 0,
      ),
    );
    assert.ok(
      Number(
        f.db.prepare("SELECT count(*) AS n FROM scene_history_entries").get()!
          .n,
      ) <= 100,
    );
  } finally {
    f.db.close();
  }
});

test("drawing and mixed translations preserve geometry and ownership through complete create/move/delete undo cycles", () => {
  const f = fixture();
  try {
    const drawingId = randomUUID(),
      tokenId = f.add(),
      drawing = {
        id: drawingId,
        kind: "stroke" as const,
        points: [
          { x: 10, y: 20 },
          { x: 40, y: 50 },
          { x: 70, y: 60 },
        ],
        color: "#405f4d",
      };
    f.run({ type: "drawing.add", drawing });
    f.run({
      type: "objects.move",
      objects: [{ objectId: drawingId, expectedVersion: 1 }],
      delta: { x: 20, y: -10 },
    });
    assert.equal(f.history.status(f.player.member).undo!.objectType, "drawing");
    assert.equal(f.history.status(f.player.member).undo!.available, true);
    f.run({
      type: "objects.move",
      objects: [
        { objectId: drawingId, expectedVersion: 2 },
        { objectId: tokenId, expectedVersion: 1 },
      ],
      delta: { x: 50, y: 30 },
    });
    const cursor = f.history.status(f.player.member).undo!;
    assert.equal(cursor.objectType, "mixed");
    assert.equal(cursor.objectCount, 2);
    assert.equal(cursor.name, "2 objects");
    assert.equal(cursor.available, true);
    assert.deepEqual(
      f.tables.load().drawings[0]!.points,
      drawing.points.map((point) => ({ x: point.x + 70, y: point.y + 20 })),
    );
    assert.equal(f.tables.load().drawings[0]!.ownerId, f.player.member.id);
    assert.equal(f.tables.load().drawings[0]!.kind, "stroke");
    assert.equal(f.tables.load().drawings[0]!.color, drawing.color);
    f.run({ type: "object.delete", objectId: drawingId, expectedVersion: 3 });
    f.action("scene.undo");
    f.action("scene.undo");
    f.action("scene.undo");
    assert.deepEqual(f.tables.load().drawings[0]!.points, drawing.points);
    assert.deepEqual(f.tables.load().tokens[0]!.position, { x: 0, y: 0 });
    f.action("scene.undo");
    f.action("scene.undo");
    assert.equal(
      f.tables.load().drawings.length + f.tables.load().tokens.length,
      0,
    );
    for (let i = 0; i < 4; i++) f.action("scene.redo");
    assert.deepEqual(
      f.tables.load().drawings[0]!.points,
      drawing.points.map((point) => ({ x: point.x + 70, y: point.y + 20 })),
    );
    assert.equal(f.tables.load().drawings[0]!.version, 11);
    assert.equal(f.tables.load().tokens[0]!.version, 6);
    f.action("scene.redo");
    assert.equal(f.tables.load().drawings.length, 0);
  } finally {
    f.db.close();
  }
});

test("mixed movement rejects a stale, unauthorized, missing, duplicate or out-of-bounds target as a whole", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID(),
      otherId = randomUUID();
    const drawing = (id: string) => ({
      id,
      kind: "rectangle" as const,
      points: [
        { x: 9990, y: 10 },
        { x: 10000, y: 50 },
      ],
      color: "#405f4d",
    });
    f.run({ type: "drawing.add", drawing: drawing(drawingId) });
    f.run({ type: "drawing.add", drawing: drawing(otherId) }, f.gm.member);
    const token = { objectId: tokenId, expectedVersion: 1 },
      own = { objectId: drawingId, expectedVersion: 1 };
    const reject = (objects: (typeof token)[], delta = { x: -10, y: 5 }) => {
      const before = f.tables.load(),
        history = f.history.status(f.player.member);
      assert.throws(() => f.run({ type: "objects.move", objects, delta }));
      assert.deepEqual(f.tables.load(), before);
      assert.deepEqual(f.history.status(f.player.member), history);
    };
    reject([token, { ...own, expectedVersion: 2 }]);
    reject([token, { ...own, objectId: otherId }]);
    reject([token, { ...own, objectId: randomUUID() }]);
    reject([own, own]);
    reject([token, own], { x: 1, y: 0 });
    for (const bad of [
      { delta: { x: 0, y: 0 }, objects: [own] },
      { delta: { x: 20001, y: 0 }, objects: [own] },
      { delta: { x: 1, y: 0 }, objects: [] },
      { delta: { x: 1, y: 0 }, objects: [{ ...own, points: [] }] },
      { delta: { x: 1, y: 0 }, objects: [{ ...own, ownerId: f.gm.member.id }] },
    ])
      assert.equal(
        commandSchema.safeParse({
          id: randomUUID(),
          type: "objects.move",
          ...bad,
        }).success,
        false,
      );
    f.run({
      type: "objects.move",
      objects: [token, own],
      delta: { x: -10, y: 5 },
    });
    assert.equal(f.tables.load().revision, 4); // Three creations plus one atomic move.
    assert.deepEqual(f.tables.load().tokens[0]!.position, { x: -10, y: 5 });
    assert.deepEqual(
      f.tables.load().drawings.find((drawing) => drawing.id === drawingId)!
        .points,
      [
        { x: 9980, y: 15 },
        { x: 9990, y: 55 },
      ],
    );
  } finally {
    f.db.close();
  }
});

test("remote drawing transfers block mixed undo, while neighboring token-only edits remain independent", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawingId,
        kind: "rectangle",
        points: [
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
        color: "#405f4d",
      },
    });
    f.run({
      type: "objects.move",
      objects: [
        { objectId: tokenId, expectedVersion: 1 },
        { objectId: drawingId, expectedVersion: 1 },
      ],
      delta: { x: 10, y: 10 },
    });
    f.move(tokenId, 100);
    f.run(
      {
        type: "object.assign",
        objectId: drawingId,
        expectedVersion: 2,
        expectedOwnerId: f.player.member.id,
        ownerId: f.gm.member.id,
      },
      f.gm.member,
    );
    f.action("scene.undo");
    const before = f.tables.load();
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"), /ownership changes/);
    assert.deepEqual(f.tables.load(), before);
    f.run(
      {
        type: "objects.move",
        objects: [{ objectId: drawingId, expectedVersion: 3 }],
        delta: { x: 10, y: 10 },
      },
      f.gm.member,
    );
    assert.equal(f.history.status(f.gm.member).undo!.objectType, "drawing");
    f.action("scene.undo", f.gm.member);
    assert.equal(f.tables.load().drawings[0]!.version, 5);
    assert.equal(f.tables.load().drawings[0]!.ownerId, f.gm.member.id);
  } finally {
    f.db.close();
  }
});

test("mixed history and causal rebases roll back with failed writes, and malformed saved translations fail closed", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawingId,
        kind: "stroke",
        points: [
          { x: 0, y: 0 },
          { x: 30, y: 40 },
        ],
        color: "#405f4d",
      },
    });
    f.run({
      type: "objects.move",
      objects: [
        { objectId: tokenId, expectedVersion: 1 },
        { objectId: drawingId, expectedVersion: 1 },
      ],
      delta: { x: 50, y: 60 },
    });
    const before = f.tables.load(),
      rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    f.db.exec(
      "CREATE TRIGGER reject_mixed_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture mixed failure'); END;",
    );
    assert.throws(() => f.action("scene.undo"), /fixture mixed failure/);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    f.db.exec("DROP TRIGGER reject_mixed_receipt");
    const cursor = f.history.status(f.player.member).undo!,
      payload = JSON.parse(
        String(
          f.db
            .prepare(
              "SELECT payload_json FROM scene_history_entries WHERE id=?",
            )
            .get(cursor.id)!.payload_json,
        ),
      );
    payload.delta.x = NaN;
    f.db
      .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
      .run(JSON.stringify(payload), cursor.id);
    assert.throws(() => f.history.status(f.player.member));
  } finally {
    f.db.close();
  }
});

test("drawing translation undo/redo restores exact decimal coordinates without accumulating rounding drift", () => {
  const f = fixture();
  try {
    const id = randomUUID(),
      points = [
        { x: 0.1, y: -0.1 },
        { x: 0.7, y: 0.9 },
      ];
    f.run({
      type: "drawing.add",
      drawing: { id, kind: "stroke", points, color: "#405f4d" },
    });
    f.run({
      type: "objects.move",
      objects: [{ objectId: id, expectedVersion: 1 }],
      delta: { x: 0.2, y: 0.3 },
    });
    const moved = f.tables.load().drawings[0]!.points;
    for (let i = 0; i < 5; i++) {
      f.action("scene.undo");
      assert.deepEqual(f.tables.load().drawings[0]!.points, points);
      f.action("scene.redo");
      assert.deepEqual(f.tables.load().drawings[0]!.points, moved);
    }
    assert.equal(f.tables.load().drawings[0]!.version, 12);
  } finally {
    f.db.close();
  }
});

test("a full-size stroke moves with a token through compact commands and history cursors without losing points", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID(),
      points = Array.from({ length: 2000 }, (_, i) => ({
        x: i / 10,
        y: (i % 5) / 10,
      }));
    f.run({
      type: "drawing.add",
      drawing: { id: drawingId, kind: "stroke", points, color: "#405f4d" },
    });
    const command = {
      type: "objects.move" as const,
      objects: [
        { objectId: drawingId, expectedVersion: 1 },
        { objectId: tokenId, expectedVersion: 1 },
      ],
      delta: { x: 100, y: 200 },
    };
    assert.ok(JSON.stringify(command).length < 400);
    f.run(command);
    assert.deepEqual(
      f.tables.load().drawings[0]!.points,
      points.map((point) => ({ x: point.x + 100, y: point.y + 200 })),
    );
    const cursor = f.history.status(f.player.member);
    assert.ok(JSON.stringify(cursor).length < 600);
    assert.ok(!JSON.stringify(cursor).includes("points"));
    f.action("scene.undo");
    assert.deepEqual(f.tables.load().drawings[0]!.points, points);
    assert.deepEqual(f.tables.load().tokens[0]!.position, { x: 0, y: 0 });
  } finally {
    f.db.close();
  }
});

test("mixed group deletion is one revision and restores complete causal move/create histories with increasing versions", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID(),
      points = [
        { x: 0.1, y: 0.2 },
        { x: 40.3, y: 50.4 },
      ];
    f.run({
      type: "drawing.add",
      drawing: { id: drawingId, kind: "rectangle", points, color: "#405f4d" },
    });
    f.run({
      type: "objects.move",
      objects: [
        { objectId: tokenId, expectedVersion: 1 },
        { objectId: drawingId, expectedVersion: 1 },
      ],
      delta: { x: 10, y: 20 },
    });
    const before = f.tables.load(),
      count = f.db
        .prepare("SELECT count(*) AS n FROM scene_history_entries")
        .get()!.n;
    f.run({
      type: "objects.delete",
      objects: [
        { objectId: tokenId, expectedVersion: 2 },
        { objectId: drawingId, expectedVersion: 2 },
      ],
    });
    assert.equal(f.tables.load().revision, before.revision + 1);
    assert.equal(
      f.tables.load().tokens.length + f.tables.load().drawings.length,
      0,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM scene_history_entries").get()!.n,
      Number(count) + 1,
    );
    const cursor = f.history.status(f.player.member).undo!;
    assert.equal(cursor.action, "delete");
    assert.equal(cursor.objectType, "mixed");
    assert.equal(cursor.objectCount, 2);
    assert.equal(cursor.available, true);
    assert.ok(!JSON.stringify(cursor).includes("points"));
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens[0]!.version, 4);
    assert.equal(f.tables.load().drawings[0]!.ownerId, f.player.member.id);
    f.action("scene.undo");
    assert.deepEqual(f.tables.load().drawings[0]!.points, points);
    assert.deepEqual(f.tables.load().tokens[0]!.position, { x: 0, y: 0 });
    f.action("scene.undo");
    f.action("scene.undo");
    assert.equal(
      f.tables.load().tokens.length + f.tables.load().drawings.length,
      0,
    );
    for (let n = 0; n < 4; n++) f.action("scene.redo");
    assert.equal(
      f.tables.load().tokens.length + f.tables.load().drawings.length,
      0,
    );
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens[0]!.version, 10);
    assert.equal(f.tables.load().drawings[0]!.version, 10);
    assert.deepEqual(
      f.tables.load().drawings[0]!.points,
      before.drawings[0]!.points,
    );
    assert.equal(f.tables.load().drawings[0]!.kind, "rectangle");
    assert.equal(f.tables.load().drawings[0]!.color, "#405f4d");
  } finally {
    f.db.close();
  }
});

test("batch deletion rejects stale, unauthorized, missing, duplicate, invalid and forged selections without partial changes", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID(),
      other = f.add(f.gm.member);
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawingId,
        kind: "stroke",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
        color: "#405f4d",
      },
    });
    const target = { objectId: tokenId, expectedVersion: 1 },
      drawing = { objectId: drawingId, expectedVersion: 1 };
    for (const objects of [
      [target, { ...drawing, expectedVersion: 2 }],
      [target, { ...drawing, objectId: other }],
      [target, { ...drawing, objectId: randomUUID() }],
      [target, target],
      [target, { ...drawing, expectedVersion: 0 }],
    ]) {
      const before = f.tables.load(),
        rows = f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all();
      assert.throws(() => f.run({ type: "objects.delete", objects }));
      assert.deepEqual(f.tables.load(), before);
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        rows,
      );
    }
    for (const objects of [
      [],
      Array.from({ length: 101 }, () => ({
        ...target,
        objectId: randomUUID(),
      })),
      [{ ...target, ownerId: f.gm.member.id }],
      [{ ...drawing, object: {} }],
    ])
      assert.equal(
        commandSchema.safeParse({
          id: randomUUID(),
          type: "objects.delete",
          objects,
        }).success,
        false,
      );
  } finally {
    f.db.close();
  }
});

test("restoration requires aggregate token and drawing capacity and never restores only part of a group", () => {
  const f = fixture();
  try {
    const ids = [f.add(), f.add()],
      drawings = [randomUUID(), randomUUID()];
    for (const id of drawings)
      f.run({
        type: "drawing.add",
        drawing: {
          id,
          kind: "rectangle",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          color: "#405f4d",
        },
      });
    f.run({
      type: "objects.delete",
      objects: [...ids, ...drawings].map((objectId) => ({
        objectId,
        expectedVersion: 1,
      })),
    });
    const state = f.tables.load();
    f.tables.save(
      {
        ...state,
        revision: state.revision + 1,
        tokens: Array.from({ length: 199 }, () => ({
          id: randomUUID(),
          name: "Filler",
          radius: 24,
          position: { x: 0, y: 0 },
          color: "#405f4d",
          ownerId: f.gm.member.id,
          version: 1,
        })),
        drawings: Array.from({ length: 1999 }, () => ({
          id: randomUUID(),
          kind: "rectangle" as const,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
          color: "#405f4d",
          ownerId: f.gm.member.id,
          version: 1,
        })),
      },
      randomUUID(),
    );
    const reject = () => {
      const before = f.tables.load(),
        history = f.history.status(f.player.member);
      assert.equal(history.undo!.available, false);
      assert.throws(() => f.action("scene.undo"), /full scene/);
      assert.deepEqual(f.tables.load(), before);
      assert.deepEqual(f.history.status(f.player.member), history);
    };
    reject();
    let current = f.tables.load();
    f.tables.save(
      {
        ...current,
        revision: current.revision + 1,
        tokens: current.tokens.slice(1),
      },
      randomUUID(),
    );
    reject();
    current = f.tables.load();
    f.tables.save(
      {
        ...current,
        revision: current.revision + 1,
        drawings: current.drawings.slice(1),
      },
      randomUUID(),
    );
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens.length, 200);
    assert.equal(f.tables.load().drawings.length, 2000);
    assert.ok(
      f.tables
        .load()
        .tokens.filter((token) => (ids as string[]).includes(token.id))
        .every((token) => token.version === 3),
    );
  } finally {
    f.db.close();
  }
});

test("GM group restoration retains removed owners and current roles/versions gate the entire inverse", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawingId,
        kind: "stroke",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 3 },
        ],
        color: "#405f4d",
      },
    });
    f.run(
      {
        type: "objects.delete",
        objects: [
          { objectId: tokenId, expectedVersion: 1 },
          { objectId: drawingId, expectedVersion: 1 },
        ],
      },
      f.gm.member,
    );
    f.db
      .prepare(
        "UPDATE access_memberships SET role='player' WHERE user_id=? AND table_id=?",
      )
      .run(f.gm.member.id, f.gm.member.tableId);
    assert.equal(
      f.history.status({ ...f.gm.member, role: "gm" }).undo!.available,
      false,
    );
    assert.throws(
      () => f.action("scene.undo", { ...f.gm.member, role: "gm" }),
      /ownership changes/,
    );
    f.db
      .prepare(
        "UPDATE access_memberships SET role='gm' WHERE user_id=? AND table_id=?",
      )
      .run(f.gm.member.id, f.gm.member.tableId);
    f.access.removeMember(f.gm.token, f.player.member.id);
    f.action("scene.undo", f.gm.member);
    assert.equal(f.tables.load().tokens[0]!.ownerId, f.player.member.id);
    assert.equal(f.tables.load().drawings[0]!.ownerId, f.player.member.id);
    f.run(
      {
        type: "object.assign",
        objectId: drawingId,
        expectedVersion: 3,
        expectedOwnerId: f.player.member.id,
        ownerId: f.gm.member.id,
      },
      f.gm.member,
    );
    const before = f.tables.load();
    assert.equal(f.history.status(f.gm.member).redo!.available, false);
    assert.throws(() => f.action("scene.redo", f.gm.member), /entire edit/);
    assert.deepEqual(f.tables.load(), before);
  } finally {
    f.db.close();
  }
});

test("group deletion and restoration roll back all objects and neighboring history when receipt persistence fails", () => {
  const f = fixture();
  try {
    const tokenId = f.add(),
      drawingId = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: drawingId,
        kind: "rectangle",
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 30 },
        ],
        color: "#405f4d",
      },
    });
    const command = {
      type: "objects.delete" as const,
      objects: [
        { objectId: tokenId, expectedVersion: 1 },
        { objectId: drawingId, expectedVersion: 1 },
      ],
    };
    const fail = () =>
      f.db.exec(
        "CREATE TRIGGER reject_delete_receipt BEFORE INSERT ON campaign_receipts BEGIN SELECT RAISE(ABORT,'fixture batch receipt'); END;",
      );
    let before = f.tables.load(),
      rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
    fail();
    assert.throws(() => f.run(command), /fixture batch receipt/);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    f.db.exec("DROP TRIGGER reject_delete_receipt");
    f.run(command);
    before = f.tables.load();
    rows = f.db
      .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
      .all();
    fail();
    assert.throws(() => f.action("scene.undo"), /fixture batch receipt/);
    assert.deepEqual(f.tables.load(), before);
    assert.deepEqual(
      f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all(),
      rows,
    );
    f.db.exec("DROP TRIGGER reject_delete_receipt");
    const cursor = f.history.status(f.player.member).undo!,
      payload = JSON.parse(
        String(
          f.db
            .prepare(
              "SELECT payload_json FROM scene_history_entries WHERE id=?",
            )
            .get(cursor.id)!.payload_json,
        ),
      );
    payload.objects[0].object.id = randomUUID();
    f.db
      .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
      .run(JSON.stringify(payload), cursor.id);
    assert.throws(() => f.history.status(f.player.member));
  } finally {
    f.db.close();
  }
});

test("one hundred deleted objects restore as one retained edit, even after older create histories expire", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 100 }, () => f.add());
    f.run({
      type: "objects.delete",
      objects: ids.map((objectId) => ({ objectId, expectedVersion: 1 })),
    });
    assert.equal(f.tables.load().tokens.length, 0);
    assert.equal(f.history.status(f.player.member).undo!.objectCount, 100);
    assert.ok(
      Number(
        f.db.prepare("SELECT count(*) AS n FROM scene_history_entries").get()!
          .n,
      ) <= 100,
    );
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens.length, 100);
    assert.ok(
      f.tables
        .load()
        .tokens.every(
          (token) =>
            token.version === 3 && (ids as string[]).includes(token.id),
        ),
    );
    f.action("scene.redo");
    assert.equal(f.tables.load().tokens.length, 0);
  } finally {
    f.db.close();
  }
});

test("drawing resize preserves shape/owner/style and exact points through create, move, resize, delete undo/redo", () => {
  const f = fixture();
  try {
    for (const kind of ["rectangle", "stroke"] as const) {
      const id = randomUUID(),
        points = [
          { x: 10.3, y: -20.4 },
          { x: 0.1, y: 0.2 },
          { x: 5.15, y: -11.7 },
        ];
      f.run({
        type: "drawing.add",
        drawing: { id, kind, color: "#aabbcc", points },
      });
      f.run({
        type: "objects.move",
        objects: [{ objectId: id, expectedVersion: 1 }],
        delta: { x: 0.3, y: -0.1 },
      });
      const original = f.tables.load().drawings.find((d) => d.id === id)!;
      const resized = f
        .run({
          type: "drawing.resize",
          drawingId: id,
          expectedVersion: 2,
          bounds: { left: -10.7, top: -50.4, right: 70.3, bottom: 10.1 },
        })
        .drawings.find((d) => d.id === id)!;
      assert.deepEqual(
        { ...resized, points: original.points, version: original.version },
        original,
      );
      const edge = f.history.status(f.player.member).undo!;
      assert.equal(edge.action, "resize");
      assert.equal(edge.objectType, "drawing");
      assert.ok(!JSON.stringify(edge).includes("points"));
      f.run({ type: "object.delete", objectId: id, expectedVersion: 3 });
      assert.equal(
        f.action("scene.undo").drawings.find((d) => d.id === id)!.version,
        5,
      );
      assert.deepEqual(
        f.action("scene.undo").drawings.find((d) => d.id === id)!.points,
        original.points,
      );
      assert.deepEqual(
        f.action("scene.undo").drawings.find((d) => d.id === id)!.points,
        points,
      );
      assert.ok(!f.action("scene.undo").drawings.some((d) => d.id === id));
      f.action("scene.redo");
      f.action("scene.redo");
      const again = f.action("scene.redo").drawings.find((d) => d.id === id)!;
      assert.deepEqual(again.points, resized.points);
      assert.equal(again.version, 11);
      assert.ok(!f.action("scene.redo").drawings.some((d) => d.id === id));
    }
  } finally {
    f.db.close();
  }
});

test("resize rejects stale, unauthorized, missing, degenerate, unchanged and malformed geometry without state/history changes", () => {
  const f = fixture();
  try {
    const id = randomUUID();
    f.run(
      {
        type: "drawing.add",
        drawing: {
          id,
          kind: "stroke",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          color: "#405f4d",
        },
      },
      f.gm.member,
    );
    const command = {
      type: "drawing.resize" as const,
      drawingId: id,
      expectedVersion: 1,
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    };
    const before = f.tables.load(),
      rows = f.db.prepare("SELECT * FROM scene_history_entries").all();
    for (const input of [
      command,
      { ...command, drawingId: randomUUID() },
      { ...command, expectedVersion: 2 },
      { ...command, bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
      { ...command, bounds: { left: 0, top: 0, right: 10001, bottom: 10 } },
      { ...command, bounds: { left: 0, top: 0, right: 0, bottom: 10 } },
      { ...command, bounds: { left: 0, top: 0, right: NaN, bottom: 10 } },
    ]) {
      assert.throws(() =>
        f.run(input, input === command ? f.player.member : f.gm.member),
      );
      assert.deepEqual(f.tables.load(), before);
      assert.deepEqual(
        f.db.prepare("SELECT * FROM scene_history_entries").all(),
        rows,
      );
    }
    assert.equal(
      commandSchema.safeParse({
        id: randomUUID(),
        ...command,
        ownerId: f.player.member.id,
      }).success,
      false,
    );
    f.run(command, f.gm.member);
    f.run(
      {
        type: "object.assign",
        objectId: id,
        expectedVersion: 2,
        expectedOwnerId: f.gm.member.id,
        ownerId: f.player.member.id,
      },
      f.gm.member,
    );
    f.run({
      type: "objects.move",
      objects: [{ objectId: id, expectedVersion: 3 }],
      delta: { x: 1, y: 1 },
    });
    assert.equal(f.history.status(f.gm.member).undo!.available, false);
    assert.throws(
      () => f.action("scene.undo", f.gm.member),
      /changed|unavailable/,
    );
    const flat = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: flat,
        kind: "stroke",
        color: "#405f4d",
        points: [
          { x: 1, y: 0 },
          { x: 10, y: 0 },
        ],
      },
    });
    assert.throws(
      () => f.run({ ...command, drawingId: flat }),
      /width and height/,
    );
  } finally {
    f.db.close();
  }
});

test("token resize exact size survives complete create/move/group-delete/restore causal cycles and remote changes block old size history", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.move(id, 0.1);
    f.run({
      type: "token.resize",
      tokenId: id,
      expectedVersion: 2,
      radius: 75.125,
    });
    assert.equal(f.history.status(f.player.member).undo!.action, "resize");
    f.run({
      type: "objects.delete",
      objects: [{ objectId: id, expectedVersion: 3 }],
    });
    assert.equal(f.action("scene.undo").tokens[0]!.radius, 75.125);
    assert.equal(f.action("scene.undo").tokens[0]!.radius, 24);
    assert.equal(f.action("scene.undo").tokens[0]!.position.x, 0);
    assert.equal(f.action("scene.undo").tokens.length, 0);
    f.action("scene.redo");
    f.action("scene.redo");
    assert.equal(f.action("scene.redo").tokens[0]!.radius, 75.125);
    f.action("scene.redo");
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens[0]!.version, 13);
    f.run(
      { type: "token.resize", tokenId: id, expectedVersion: 13, radius: 100 },
      f.gm.member,
    );
    assert.equal(f.history.status(f.player.member).undo!.available, false);
    assert.throws(() => f.action("scene.undo"), /changed|unavailable/);
    assert.equal(f.tables.load().tokens[0]!.radius, 100);
  } finally {
    f.db.close();
  }
});

test("schema-6 token snapshots gain fixed legacy radius atomically, including group restoration; failed markers leave every inverse untouched", () => {
  for (const fail of [false, true]) {
    const f = fixture();
    try {
      const a = f.add(),
        b = f.add();
      f.run({
        type: "objects.delete",
        objects: [a, b].map((objectId) => ({ objectId, expectedVersion: 1 })),
      });
      const status = f.history.status(f.player.member);
      for (const row of f.db
        .prepare("SELECT id,payload_json FROM scene_history_entries")
        .all()) {
        const payload = JSON.parse(String(row.payload_json));
        if (payload.kind === "create" || payload.kind === "delete")
          delete payload.object.radius;
        if (payload.kind === "delete-many")
          for (const saved of payload.objects) delete saved.object.radius;
        f.db
          .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
          .run(JSON.stringify(payload), row.id!);
      }
      f.db.exec("UPDATE scene_history_version SET version=6");
      const rows = f.db
        .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
        .all();
      if (fail) {
        f.db.exec(
          "CREATE TRIGGER reject_size_history BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture size history'); END;",
        );
        assert.throws(
          () => new SceneHistoryStore(f.db, f.tables),
          /fixture size history/,
        );
        assert.deepEqual(
          f.db
            .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
            .all(),
          rows,
        );
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          6,
        );
        f.db.exec("DROP TRIGGER reject_size_history");
      }
      const history = new SceneHistoryStore(f.db, f.tables);
      assert.deepEqual(history.status(f.player.member), status);
      assert.equal(
        f.db.prepare("SELECT version FROM scene_history_version").get()!
          .version,
        13,
      );
      const restored = f.action("scene.undo");
      assert.deepEqual(
        restored.tokens.map((token) => token.radius),
        [24, 24],
      );
      assert.deepEqual(
        restored.tokens.map((token) => token.version),
        [3, 3],
      );
      f.action("scene.undo");
      f.action("scene.undo");
      assert.equal(f.tables.load().tokens.length, 0);
    } finally {
      f.db.close();
    }
  }
});

test("mixed group resize restores exact decimal geometry and sizes through whole-group deletion and overlapping move history", () => {
  const f = fixture();
  try {
    const a = f.add(),
      b = f.add(),
      d = randomUUID();
    f.run({
      type: "drawing.add",
      drawing: {
        id: d,
        kind: "stroke",
        color: "#aabbcc",
        points: [
          { x: 0.1, y: 0.2 },
          { x: 10.3, y: 20.4 },
        ],
      },
    });
    f.move(b, 50.15);
    f.run({
      type: "token.resize",
      tokenId: a,
      expectedVersion: 1,
      radius: 15.125,
    });
    const before = f.tables.load(),
      refs = [...before.tokens, ...before.drawings].map((o) => ({
        objectId: o.id,
        expectedVersion: o.version,
      })),
      count = f.db
        .prepare("SELECT COUNT(*) AS n FROM scene_history_entries")
        .get()!.n;
    const resized = f.run({
      type: "objects.resize",
      objects: refs,
      scale: 1.75,
    });
    assert.equal(resized.revision, before.revision + 1);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM scene_history_entries").get()!.n,
      Number(count) + 1,
    );
    const cursor = f.history.status(f.player.member).undo!;
    assert.equal(cursor.action, "resize");
    assert.equal(cursor.objectCount, 3);
    assert.equal(cursor.objectType, "mixed");
    assert.ok(!JSON.stringify(cursor).includes("changes"));
    f.run({
      type: "objects.delete",
      objects: [...resized.tokens, ...resized.drawings].map((o) => ({
        objectId: o.id,
        expectedVersion: o.version,
      })),
    });
    f.action("scene.undo");
    const undone = f.action("scene.undo");
    assert.deepEqual(
      undone.tokens.map((t) => ({ position: t.position, radius: t.radius })),
      before.tokens.map((t) => ({ position: t.position, radius: t.radius })),
    );
    assert.deepEqual(undone.drawings[0]!.points, before.drawings[0]!.points);
    const again = f.action("scene.redo");
    assert.deepEqual(
      again.tokens.map((t) => ({ position: t.position, radius: t.radius })),
      resized.tokens.map((t) => ({ position: t.position, radius: t.radius })),
    );
    assert.deepEqual(again.drawings[0]!.points, resized.drawings[0]!.points);
    f.action("scene.undo");
    f.action("scene.undo");
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens.find((t) => t.id === b)!.position.x, 0);
    assert.equal(f.tables.load().tokens.find((t) => t.id === a)!.radius, 24);
    f.action("scene.redo");
    f.action("scene.redo");
    f.action("scene.redo");
    f.move(a, 100, f.gm.member);
    const blocked = f.history.status(f.player.member).undo!;
    assert.equal(blocked.available, false);
    assert.equal(blocked.objectCount, 3);
    const current = f.tables.load();
    assert.throws(() => f.action("scene.undo"), /changed|unavailable/);
    assert.deepEqual(f.tables.load(), current);
  } finally {
    f.db.close();
  }
});

test("schema-7 sized token and scalar resize histories upgrade intact to 8; failed marker and disguised future group payload roll back", () => {
  for (const failure of ["none", "marker", "future"]) {
    const f = fixture();
    try {
      const a = f.add(),
        b = f.add();
      f.run({
        type: "token.resize",
        tokenId: a,
        expectedVersion: 1,
        radius: 75.125,
      });
      f.run({
        type: "objects.delete",
        objects: [
          { objectId: a, expectedVersion: 2 },
          { objectId: b, expectedVersion: 1 },
        ],
      });
      const status = f.history.status(f.player.member);
      if (failure === "future") {
        f.action("scene.undo");
        const state = f.tables.load();
        f.run({
          type: "objects.resize",
          objects: state.tokens.map((t) => ({
            objectId: t.id,
            expectedVersion: t.version,
          })),
          scale: 1.25,
        });
      }
      f.db.exec("UPDATE scene_history_version SET version=7");
      if (failure === "marker")
        f.db.exec(
          "CREATE TRIGGER reject_group_size BEFORE UPDATE ON scene_history_version BEGIN SELECT RAISE(ABORT,'fixture group size marker'); END;",
        );
      const rows = f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        state = f.tables.load();
      if (failure !== "none") {
        assert.throws(() => new SceneHistoryStore(f.db, f.tables));
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          7,
        );
      } else {
        const history = new SceneHistoryStore(f.db, f.tables);
        assert.deepEqual(history.status(f.player.member), status);
        assert.equal(
          f.db.prepare("SELECT version FROM scene_history_version").get()!
            .version,
          13,
        );
      }
      assert.deepEqual(
        f.db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all(),
        rows,
      );
      assert.deepEqual(f.tables.load(), state);
      if (failure === "none")
        assert.equal(
          f.action("scene.undo").tokens.find((t) => t.id === a)!.radius,
          75.125,
        );
    } finally {
      f.db.close();
    }
  }
});

test("100-object resize stays one bounded edge with exact undo after predecessor expiry; malformed geometry links fail closed", () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 100 }, () => f.add());
    const before = f.tables.load();
    f.run({
      type: "objects.resize",
      objects: ids.map((objectId) => ({ objectId, expectedVersion: 1 })),
      scale: 2,
    });
    assert.equal(f.history.status(f.player.member).undo!.objectCount, 100);
    assert.ok(
      f
        .action("scene.undo")
        .tokens.every((t) => t.radius === 24 && t.version === 3),
    );
    f.action("scene.redo");
    const current = f.tables.load(),
      edge = f.history.status(f.player.member).undo!,
      row = f.db
        .prepare("SELECT payload_json FROM scene_history_entries WHERE id=?")
        .get(edge.id)!,
      original = JSON.parse(String(row.payload_json));
    for (const corrupt of ["duplicate", "kind", "point", "target"]) {
      const payload = structuredClone(original);
      if (corrupt === "duplicate")
        payload.changes[1].objectId = payload.changes[0].objectId;
      if (corrupt === "kind") payload.objectType = "mixed";
      if (corrupt === "point") payload.changes[0].after.position.x = 10001;
      if (corrupt === "target") payload.changes[0].objectId = randomUUID();
      f.db
        .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
        .run(JSON.stringify(payload), edge.id);
      assert.throws(() => f.history.status(f.player.member));
      assert.deepEqual(f.tables.load(), current);
    }
    f.db
      .prepare("UPDATE scene_history_entries SET payload_json=? WHERE id=?")
      .run(row.payload_json!, edge.id);
    const undone = f.action("scene.undo");
    assert.deepEqual(
      undone.tokens.map((t) => ({ position: t.position, radius: t.radius })),
      before.tokens.map((t) => ({ position: t.position, radius: t.radius })),
    );
  } finally {
    f.db.close();
  }
});
