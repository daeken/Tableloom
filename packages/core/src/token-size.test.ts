import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTable,
  commandSchema,
  tableSchema,
  restoreTable,
} from "./index.js";
import { applyCommand } from "./server.js";
import type { Member } from "./access.js";
const player: Member = {
    id: crypto.randomUUID(),
    tableId: crypto.randomUUID(),
    name: "Player",
    role: "player",
  },
  other = { ...player, id: crypto.randomUUID() },
  gm: Member = { ...other, role: "gm" };

test("token size is server-assigned at creation, version-checked and permission-guarded without moving its center or changing identity/style", () => {
  const token = {
      id: crypto.randomUUID(),
      name: "Scout",
      color: "#405f4d",
      position: { x: 9999.9, y: -10000 },
    },
    add = { id: crypto.randomUUID(), type: "token.add" as const, token },
    state = applyCommand(createTable(), add, player),
    saved = state.tokens[0]!;
  assert.equal(saved.radius, 24);
  assert.equal(
    commandSchema.safeParse({ ...add, token: { ...token, radius: 300 } })
      .success,
    false,
  );
  const command = {
    id: crypto.randomUUID(),
    type: "token.resize" as const,
    tokenId: token.id,
    expectedVersion: 1,
    radius: 75.125,
  };
  assert.throws(() => applyCommand(state, command, other), /owner or GM/);
  const next = applyCommand(state, command, player);
  assert.deepEqual(next.tokens[0], { ...saved, radius: 75.125, version: 2 });
  assert.equal(next.revision, state.revision + 1);
  assert.throws(() => applyCommand(next, command, gm), /changed/);
  assert.throws(
    () => applyCommand(next, { ...command, expectedVersion: 2 }, gm),
    /size before/,
  );
  for (const radius of [NaN, Infinity, 3.99, 300.01, -1]) {
    assert.equal(
      commandSchema.safeParse({ ...command, radius }).success,
      false,
    );
    assert.throws(() => applyCommand(state, { ...command, radius }, gm));
  }
  for (const radius of [4, 300])
    assert.equal(
      applyCommand(state, { ...command, radius }, gm).tokens[0]!.radius,
      radius,
    );
  assert.equal(
    commandSchema.safeParse({ ...command, ownerId: other.id }).success,
    false,
  );
  assert.equal(state.tokens[0]!.radius, 24);
});

test("table-5 migration assigns legacy token radius 24 while preserving versions, owners and all other state; incomplete table-6 sizes fail closed", () => {
  const state = applyCommand(
    createTable(),
    {
      id: crypto.randomUUID(),
      type: "token.add",
      token: {
        id: crypto.randomUUID(),
        name: "Scout",
        color: "#405f4d",
        position: { x: 0.1, y: -20.4 },
      },
    },
    player,
  );
  state.tokens[0]!.version = 17;
  const legacy = {
    ...state,
    schemaVersion: 5,
    tokens: state.tokens.map(({ radius: _, ...token }) => token),
  };
  assert.deepEqual(restoreTable(legacy), { migrated: true, state });
  assert.equal(restoreTable(state).migrated, false);
  assert.equal(
    tableSchema.safeParse({ ...legacy, schemaVersion: 6 }).success,
    false,
  );
  assert.throws(() => restoreTable({ ...legacy, schemaVersion: 6 }));
  assert.throws(() =>
    restoreTable({ ...legacy, tokens: [{ ...legacy.tokens[0], radius: 100 }] }),
  );
});
