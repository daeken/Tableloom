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
import { SceneHistoryStore, MAX_MEMBER_MOVE_HISTORY } from "./scene-history.js";
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

test("deletion expires all actors' target history and UUID reuse cannot resurrect an old inverse", () => {
  const f = fixture();
  try {
    const id = f.add();
    f.move(id, 10);
    f.move(id, 20, f.gm.member);
    f.run(
      { type: "object.delete", objectId: id, expectedVersion: 3 },
      f.gm.member,
    );
    assert.equal(f.history.status(f.player.member).undo, null);
    assert.equal(f.history.status(f.gm.member).undo, null);
    f.add(f.player.member, id);
    f.move(id, 100);
    f.action("scene.undo");
    assert.equal(f.tables.load().tokens[0]!.position.x, 0);
    assert.equal(f.history.status(f.player.member).undo, null);
  } finally {
    f.db.close();
  }
});

test("history is scene-scoped, leaves private activity alone, and prunes bounded prefixes safely", () => {
  const f = fixture();
  try {
    const id = f.add();
    for (let x = 1; x <= MAX_MEMBER_MOVE_HISTORY + 3; x++) f.move(id, x);
    assert.equal(
      f.db.prepare("SELECT count(*) AS count FROM scene_move_history").get()!
        .count,
      MAX_MEMBER_MOVE_HISTORY,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT previous_id FROM scene_move_history ORDER BY sequence LIMIT 1",
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
      "INSERT INTO scene_move_history(id,campaign_id,scene_id,actor_id,token_id,state,version,expected_token_version,from_json,to_json) VALUES(?,?,?,?,?,'done',1,1,?,?)",
    );
    transaction(f.db, () => {
      for (let n = 0; n < 10000; n++)
        insert.run(
          randomUUID(),
          campaign.id,
          scene.id,
          f.gm.member.id,
          id,
          '{"x":0,"y":0}',
          '{"x":1,"y":0}',
        );
    });
    f.move(id, 200);
    assert.equal(
      f.db.prepare("SELECT count(*) AS count FROM scene_move_history").get()!
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
    f.db.exec(
      'DROP TRIGGER reject_receipt; UPDATE scene_move_history SET from_json=\'{"x":"bad"}\';',
    );
    assert.throws(() => f.history.status(f.player.member));
    f.db.exec("UPDATE scene_history_version SET version=99");
    assert.throws(() => new SceneHistoryStore(f.db, f.tables));
    f.db.exec(
      "UPDATE scene_history_version SET version=1; DROP TABLE scene_move_history",
    );
    assert.throws(() => new SceneHistoryStore(f.db, f.tables), /incomplete/);
    f.db.exec(
      "DROP TABLE scene_history_version; CREATE TABLE scene_move_history(id TEXT)",
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
