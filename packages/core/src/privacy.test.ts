import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  createTable,
  restoreTable,
  tableSchema,
} from "./index.js";
import type { Roll, TableState } from "./index.js";
import type { Member } from "./access.js";
import { applyCommand, projectTable, rollDice } from "./server.js";

const alice: Member = {
  id: randomUUID(),
  name: "Alice",
  role: "player",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const bob: Member = {
  id: randomUUID(),
  name: "Bob",
  role: "player",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const gm: Member = {
  id: randomUUID(),
  name: "GM",
  role: "gm",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const roll = (
  state: TableState,
  member: Member,
  visibility: "public" | "gm" = "public",
) =>
  applyCommand(
    state,
    {
      id: randomUUID(),
      type: "dice.roll",
      expression: "2d37 + 19",
      visibility,
    },
    member,
  );

test("projections omit private results, identifiers, and global revisions for other players", () => {
  const publicState = roll(createTable(), bob);
  const privateState = roll(publicState, alice, "gm");
  const privateRoll = privateState.rolls.at(-1)!;
  const bobBefore = projectTable(publicState, bob);
  const bobAfter = projectTable(privateState, bob);
  assert.deepEqual(bobAfter, bobBefore);
  assert.equal("revision" in bobAfter, false);
  assert.equal(JSON.stringify(bobAfter).includes(privateRoll.id), false);
  assert.equal(projectTable(privateState, alice).rolls.length, 2);
  assert.equal(projectTable(privateState, gm).rolls.length, 2);
  assert.deepEqual(
    projectTable({ ...privateState, revision: 999 }, bob),
    bobAfter,
  );
  assert.equal(privateRoll.ownerId, alice.id);
  assert.equal(privateRoll.visibility, "gm");
  const gmSecret = roll(privateState, gm, "gm");
  assert.deepEqual(
    projectTable(gmSecret, alice),
    projectTable(privateState, alice),
  );
  assert.deepEqual(projectTable(gmSecret, bob), bobAfter);
  assert.equal(projectTable(gmSecret, gm).rolls.length, 3);
});

test("public is the default and invalid visibility cannot silently create a public roll", () => {
  const command = { id: randomUUID(), type: "dice.roll", expression: "d6" };
  const state = applyCommand(
    createTable(),
    commandSchema.parse(command),
    alice,
  );
  assert.equal(state.rolls[0]?.visibility, "public");
  assert.equal(projectTable(state, bob).rolls.length, 1);
  for (const visibility of ["blind", "private", null, 1]) {
    assert.equal(
      commandSchema.safeParse({ ...command, visibility }).success,
      false,
    );
  }
  assert.equal(
    commandSchema.safeParse({ ...command, visiblity: "gm" }).success,
    false,
  );
  assert.equal(
    tableSchema.safeParse({
      ...state,
      rolls: [{ ...state.rolls[0], visibility: "gm", ownerId: null }],
    }).success,
    false,
  );
  const publicRoll = state.rolls[0]!;
  assert.equal(
    tableSchema.safeParse({
      ...state,
      rolls: Array.from({ length: 101 }, () => ({
        ...publicRoll,
        id: randomUUID(),
      })),
    }).success,
    false,
  );
});

test("private roll retention never evicts public history or another player's private rolls", () => {
  let state = roll(createTable(), gm);
  const publicId = state.rolls[0]!.id;
  state = roll(state, bob, "gm");
  const bobId = state.rolls[1]!.id;
  const before = projectTable(state, bob);
  for (let i = 0; i < 120; i++) state = roll(state, alice, "gm");
  assert.equal(state.rolls.length, 102);
  assert.equal(
    state.rolls.filter((result) => result.ownerId === alice.id).length,
    100,
  );
  assert.equal(
    state.rolls.some((result) => result.id === publicId),
    true,
  );
  assert.equal(
    state.rolls.some((result) => result.id === bobId),
    true,
  );
  assert.deepEqual(projectTable(state, bob), before);
});

test("overall roll capacity rejects growth without evicting a different audience", () => {
  const base = rollDice("d6", "Fixture", (min) => min);
  const rolls: Roll[] = [];
  for (let bucket = 0; bucket < 11; bucket++) {
    const ownerId = randomUUID();
    for (let i = 0; i < 100; i++)
      rolls.push({
        ...base,
        id: randomUUID(),
        ownerId,
        visibility: bucket === 0 ? "public" : "gm",
      });
  }
  const full = tableSchema.parse({ ...createTable(), rolls });
  assert.throws(() => roll(full, alice, "gm"), /roll history limit/);
  assert.equal(full.revision, 0);
  const next = roll(full, alice, "public");
  assert.equal(next.rolls.length, 1100);
  assert.equal(
    next.rolls.filter((result) => result.visibility === "public").length,
    100,
  );
  assert.equal(
    next.rolls.filter((result) => result.visibility === "gm").length,
    1000,
  );
});

test("version 2 migration preserves object ownership and marks old dice public; incomplete current saves fail", () => {
  const token = {
    id: randomUUID(),
    name: "Scout",
    position: { x: 0, y: 0 },
    color: "#405f4d",
    ownerId: alice.id,
  };
  const oldRoll = rollDice("d6", "Old player");
  const legacy = {
    ...createTable(),
    schemaVersion: 2,
    revision: 42,
    tokens: [token],
    rolls: [oldRoll],
  };
  Reflect.deleteProperty(legacy, "notes");
  const migrated = restoreTable(legacy);
  assert.equal(migrated.state.schemaVersion, 9);
  assert.equal(migrated.state.revision, 42);
  assert.deepEqual(migrated.state.tokens, [
    { ...token, radius: 24, version: 1 },
  ]);
  assert.deepEqual(migrated.state.rolls, [
    { ...oldRoll, ownerId: null, visibility: "public" },
  ]);
  assert.equal(projectTable(migrated.state, bob).rolls.length, 1);
  assert.throws(() => restoreTable({ ...legacy, schemaVersion: 3 }));
  assert.throws(() =>
    restoreTable({
      ...legacy,
      rolls: [{ ...oldRoll, ownerId: alice.id, visibility: "gm" }],
    }),
  );
});
