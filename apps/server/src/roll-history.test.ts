import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_TOTAL_ROLLS,
  MAX_ROLL_HISTORY,
  tableSchema,
} from "@tableloom/core";
import type { Roll } from "@tableloom/core";
import { applyCommand, projectTable } from "@tableloom/core/server";
import {
  rollSelectionSchema,
  MAX_ARCHIVED_ROLLS,
} from "@tableloom/core/roll-history";
import { AccessStore } from "./access.js";
import { TableStore, StoreError } from "./store.js";
import { RollHistoryStore } from "./roll-history.js";

const KEY = "tableloom-roll-history-test-fixture-not-a-real-key";
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError && error.statusCode === code;
function fixture() {
  const db = new DatabaseSync(":memory:"),
    tables = new TableStore(db),
    access = new AccessStore(db, KEY),
    history = new RollHistoryStore(db, tables);
  const gm = access.setupHost(KEY, "GM"),
    alice = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Alice",
    ),
    bob = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Bob",
    );
  const roll = (actor = alice.member, visibility: "public" | "gm" = "gm") => {
    const id = randomUUID(),
      next = applyCommand(
        tables.load(),
        { id, type: "dice.roll", expression: "d6", visibility },
        actor,
      );
    tables.save(next, id);
    return next.rolls.at(-1)!;
  };
  return { db, tables, access, history, gm, alice, bob, roll };
}

test("roll archives preserve immutable outcomes/audiences and authorize full batches before changing live history", () => {
  const { db, tables, history, gm, alice, bob, roll } = fixture();
  try {
    const own = roll(),
      hidden = roll(gm.member),
      shared = roll(alice.member, "public");
    const before = tables.load(),
      bobView = projectTable(before, bob.member),
      campaign = tables.getCampaign();
    for (const action of ["archive", "delete"] as const) {
      assert.throws(
        () =>
          history.change(alice.member, { ids: [own.id, shared.id] }, action),
        status(403),
      );
      assert.throws(
        () => history.change(bob.member, { ids: [own.id] }, action),
        status(404),
      );
      assert.throws(
        () =>
          history.change(
            { ...bob.member, role: "gm" },
            { ids: [hidden.id] },
            action,
          ),
        status(404),
      );
      assert.deepEqual(tables.load(), before);
    }
    assert.throws(
      () =>
        history.change(
          alice.member,
          { ids: [own.id, randomUUID()] },
          "archive",
        ),
      status(404),
    );
    assert.equal(history.list(gm.member).entries.length, 0);
    history.change(alice.member, { ids: [own.id] }, "archive");
    assert.deepEqual(history.list(alice.member).entries[0]?.roll, own);
    assert.equal(history.list(bob.member).entries.length, 0);
    assert.deepEqual(projectTable(tables.load(), bob.member), bobView);
    assert.deepEqual(tables.getCampaign(), campaign);
    assert.throws(
      () => history.change(alice.member, { ids: [own.id] }, "archive"),
      status(404),
    );
    history.change(gm.member, { ids: [shared.id, hidden.id] }, "archive");
    assert.deepEqual(
      history.list(bob.member).entries.map((entry) => entry.roll.id),
      [shared.id],
    );
    assert.throws(
      () =>
        history.change(bob.member, { ids: [shared.id] }, "delete", "archive"),
      status(403),
    );
    assert.throws(
      () =>
        history.change(bob.member, { ids: [hidden.id] }, "delete", "archive"),
      status(404),
    );
    history.change(alice.member, { ids: [own.id] }, "delete", "archive");
    assert.equal(history.list(alice.member).entries.length, 1);
    assert.equal(tables.load().rolls.length, 0);
    const next = roll();
    history.change(gm.member, { ids: [next.id] }, "delete");
    assert.equal(history.list(gm.member).entries.length, 2);
  } finally {
    db.close();
  }
});

test("roll archive pagination filters before decoding, isolates campaigns, and retains removed owners for GM", () => {
  const { db, tables, access, history, gm, alice, bob, roll } = fixture();
  try {
    const secret = roll(gm.member);
    history.change(gm.member, { ids: [secret.id] }, "archive");
    db.prepare(
      "UPDATE roll_archive SET roll_json = 'hidden malformed payload' WHERE id = ?",
    ).run(secret.id);
    for (let i = 0; i < 57; i++) {
      const result = roll(alice.member, "public");
      history.change(gm.member, { ids: [result.id] }, "archive");
    }
    const ids = new Set<string>();
    let after: string | undefined;
    do {
      const page = history.list(bob.member, {
        limit: 7,
        ...(after ? { after } : {}),
      });
      for (const { roll } of page.entries) {
        assert.notEqual(roll.id, secret.id);
        assert.ok(!ids.has(roll.id));
        ids.add(roll.id);
      }
      after = page.next ?? undefined;
    } while (after);
    assert.equal(ids.size, 57);
    const owned = roll();
    history.change(alice.member, { ids: [owned.id] }, "archive");
    db.prepare("DELETE FROM roll_archive WHERE id = ?").run(secret.id);
    const other = tables.createCampaign({
      name: "Other",
      description: "",
      system: { id: "cyberpunk-red", version: "0.1.0" },
      contentPacks: [],
    });
    access.registerCampaign(gm.token, other.id);
    const selected = access.selectCampaign(gm.token, other.id);
    assert.equal(history.list(selected.member).entries.length, 0);
    assert.throws(
      () =>
        history.change(
          selected.member,
          { ids: [owned.id] },
          "delete",
          "archive",
        ),
      status(404),
    );
    const recovered = access.recoverHost(KEY);
    access.removeMember(recovered.token, alice.member.id);
    assert.throws(() => history.list(alice.member), status(403));
    assert.ok(
      history
        .list(gm.member, { after: owned.id })
        .entries.every((entry) => entry.roll.id > owned.id),
    );
    history.change(gm.member, { ids: [owned.id] }, "delete", "archive");
  } finally {
    db.close();
  }
});

test("archive and live cleanup roll back together on failed writes; capacity and schema markers fail closed", () => {
  const { db, tables, history, gm, alice, roll } = fixture();
  try {
    const result = roll(),
      before = tables.load();
    db.exec(
      "CREATE TRIGGER reject_history_save BEFORE UPDATE ON campaign_records BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    assert.throws(() =>
      history.change(alice.member, { ids: [result.id] }, "archive"),
    );
    assert.equal(history.list(gm.member).entries.length, 0);
    assert.deepEqual(tables.load(), before);
    assert.throws(() =>
      history.change(alice.member, { ids: [result.id] }, "delete"),
    );
    assert.deepEqual(tables.load(), before);
    db.exec("DROP TRIGGER reject_history_save");
    const insert = db.prepare("INSERT INTO roll_archive VALUES (?,?,?,?,?,?)");
    for (let i = 0; i < MAX_ARCHIVED_ROLLS; i++) {
      const copy = { ...result, id: randomUUID() };
      insert.run(
        gm.member.tableId,
        copy.id,
        copy.visibility,
        copy.ownerId,
        copy.at,
        JSON.stringify(copy),
      );
    }
    assert.throws(
      () => history.change(alice.member, { ids: [result.id] }, "archive"),
      status(409),
    );
    assert.deepEqual(tables.load(), before);
    const archived = history.list(alice.member).entries[0]!.roll;
    history.change(alice.member, { ids: [archived.id] }, "delete", "archive");
    history.change(alice.member, { ids: [result.id] }, "archive");
    assert.equal(tables.load().rolls.length, 0);
    db.exec("UPDATE roll_archive_version SET version=99");
    assert.throws(() => new RollHistoryStore(db, tables));
    db.exec(
      "UPDATE roll_archive_version SET version=1; DROP TABLE roll_archive;",
    );
    assert.throws(() => new RollHistoryStore(db, tables), /incomplete/);
  } finally {
    db.close();
  }
});

test("cleanup frees a full live history without growing snapshots or changing another audience's fingerprint", () => {
  const { db, tables, history, gm, bob, roll } = fixture();
  try {
    const base = roll(gm.member, "public");
    const rolls: Roll[] = [];
    for (let audience = 0; audience < 11; audience++)
      for (let i = 0; i < MAX_ROLL_HISTORY; i++)
        rolls.push({
          ...base,
          id: randomUUID(),
          ownerId: audience === 0 ? gm.member.id : randomUUID(),
          visibility: audience === 0 ? "public" : "gm",
        });
    // Use stable private owners to fill eleven independent audiences.
    for (let audience = 1; audience < 11; audience++) {
      const owner = randomUUID();
      for (let i = 0; i < 100; i++) rolls[audience * 100 + i]!.ownerId = owner;
    }
    const state = tables.load();
    tables.save(
      { ...state, revision: state.revision + 1, rolls },
      randomUUID(),
    );
    assert.equal(tables.load().rolls.length, MAX_TOTAL_ROLLS);
    const full = tables.load(),
      visible = projectTable(full, bob.member);
    assert.throws(
      () =>
        applyCommand(
          full,
          {
            id: randomUUID(),
            type: "dice.roll",
            expression: "d6",
            visibility: "gm",
          },
          bob.member,
        ),
      /history limit/,
    );
    const privateIds = rolls.slice(100, 200).map((result) => result.id);
    history.change(gm.member, { ids: privateIds }, "delete");
    assert.deepEqual(projectTable(tables.load(), bob.member), visible);
    assert.equal(tables.load().rolls.length, 1000);
    const next = applyCommand(
      tables.load(),
      {
        id: randomUUID(),
        type: "dice.roll",
        expression: "d6",
        visibility: "gm",
      },
      bob.member,
    );
    tables.save(next, randomUUID());
    assert.equal(tables.load().rolls.length, 1001);
    assert.ok(
      JSON.stringify(projectTable(tables.load(), bob.member)).length < 200000,
    );
    assert.equal(
      tableSchema.safeParse({ ...next, rolls: [base, base] }).success,
      false,
    );
    for (const ids of [
      [],
      [base.id, base.id],
      Array(101).fill(base.id),
      ["bad"],
    ])
      assert.equal(rollSelectionSchema.safeParse({ ids }).success, false);
  } finally {
    db.close();
  }
});
