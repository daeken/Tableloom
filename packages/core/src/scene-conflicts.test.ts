import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable, commandSchema, restoreTable } from "./index.js";
import { applyCommand } from "./server.js";
import type { Member } from "./access.js";
const gm: Member = {
  id: crypto.randomUUID(),
  name: "GM",
  role: "gm",
  tableId: "00000000-0000-4000-8000-000000000001",
};
const player: Member = {
  ...gm,
  id: crypto.randomUUID(),
  name: "Player",
  role: "player",
};
function fixture() {
  const id = crypto.randomUUID();
  return {
    id,
    state: applyCommand(
      createTable(),
      {
        id: crypto.randomUUID(),
        type: "token.add",
        token: {
          id,
          name: "Scout",
          position: { x: 10, y: 20 },
          color: "#405f4d",
        },
      },
      player,
    ),
  };
}

test("scene edit versions reject simultaneous and away-and-back moves without mutating the captured state", () => {
  const { id, state } = fixture();
  const move = {
    id: crypto.randomUUID(),
    type: "token.move" as const,
    tokenId: id,
    expectedVersion: 1,
    position: { x: 40, y: 50 },
  };
  const next = applyCommand(state, move, player);
  assert.equal(state.tokens[0]?.version, 1);
  assert.equal(next.tokens[0]?.version, 2);
  assert.throws(
    () =>
      applyCommand(
        next,
        { ...move, id: crypto.randomUUID(), position: { x: 90, y: 90 } },
        gm,
      ),
    /token changed/,
  );
  const returned = applyCommand(
    next,
    {
      ...move,
      id: crypto.randomUUID(),
      expectedVersion: 2,
      position: state.tokens[0]!.position,
    },
    gm,
  );
  assert.deepEqual(returned.tokens[0]?.position, state.tokens[0]?.position);
  assert.equal(returned.tokens[0]?.version, 3);
  assert.throws(
    () => applyCommand(returned, { ...move, id: crypto.randomUUID() }, player),
    /token changed/,
  );
  const rolled = applyCommand(
    state,
    {
      id: crypto.randomUUID(),
      type: "dice.roll",
      expression: "d6",
      visibility: "gm",
    },
    gm,
  );
  assert.equal(applyCommand(rolled, move, player).tokens[0]?.version, 2); // Unrelated private activity cannot invalidate public edits.
});

test("move/delete/ownership conflicts protect the latest object; edits on distinct objects remain independent", () => {
  const { id, state } = fixture(),
    move = {
      id: crypto.randomUUID(),
      type: "token.move" as const,
      tokenId: id,
      expectedVersion: 1,
      position: { x: 100, y: 100 },
    };
  const moved = applyCommand(state, move, player);
  const remove = {
    id: crypto.randomUUID(),
    type: "object.delete" as const,
    objectId: id,
    expectedVersion: 1,
  };
  assert.throws(() => applyCommand(moved, remove, gm), /object changed/);
  assert.throws(
    () => applyCommand(applyCommand(state, remove, gm), move, player),
    /no longer exists/,
  );
  const transfer = {
    id: crypto.randomUUID(),
    type: "object.assign" as const,
    objectId: id,
    expectedOwnerId: player.id,
    ownerId: gm.id,
    expectedVersion: 1,
  };
  assert.throws(() => applyCommand(moved, transfer, gm, gm), /object changed/);
  const assigned = applyCommand(state, transfer, gm, gm);
  assert.equal(assigned.tokens[0]?.version, 2);
  assert.throws(() => applyCommand(assigned, move, player), /owner or GM/);
  assert.throws(() => applyCommand(assigned, move, gm), /token changed/);
  const back = applyCommand(
    assigned,
    {
      ...transfer,
      id: crypto.randomUUID(),
      expectedOwnerId: gm.id,
      ownerId: player.id,
      expectedVersion: 2,
    },
    gm,
    player,
  );
  assert.equal(back.tokens[0]?.version, 3);
  assert.throws(() => applyCommand(back, move, player), /token changed/);
  const another = crypto.randomUUID();
  const two = applyCommand(
    moved,
    {
      id: crypto.randomUUID(),
      type: "token.add",
      token: {
        id: another,
        name: "Other",
        position: { x: 1, y: 2 },
        color: "#405f4d",
      },
    },
    player,
  );
  const independent = applyCommand(
    two,
    { ...move, id: crypto.randomUUID(), tokenId: another },
    player,
  );
  assert.equal(independent.tokens[0]?.version, 2);
  assert.equal(independent.tokens[1]?.version, 2);
});

test("drawing ownership advances its version, creation rejects forged versions, and legacy scene versions upgrade explicitly", () => {
  const id = crypto.randomUUID(),
    drawing = {
      id,
      kind: "rectangle" as const,
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 20 },
      ],
      color: "#405f4d",
    };
  const state = applyCommand(
    createTable(),
    { id: crypto.randomUUID(), type: "drawing.add", drawing },
    player,
  );
  const transferred = applyCommand(
    state,
    {
      id: crypto.randomUUID(),
      type: "object.assign",
      objectId: id,
      expectedOwnerId: player.id,
      ownerId: gm.id,
      expectedVersion: 1,
    },
    gm,
    gm,
  );
  assert.equal(transferred.drawings[0]?.version, 2);
  assert.throws(
    () =>
      applyCommand(
        transferred,
        {
          id: crypto.randomUUID(),
          type: "object.delete",
          objectId: id,
          expectedVersion: 1,
        },
        gm,
      ),
    /object changed/,
  );
  assert.equal(
    commandSchema.safeParse({
      id: crypto.randomUUID(),
      type: "drawing.add",
      drawing: { ...drawing, version: 42 },
    }).success,
    false,
  );
  for (const command of [
    { type: "token.move", tokenId: id, position: { x: 1, y: 2 } },
    { type: "object.delete", objectId: id },
    {
      type: "object.assign",
      objectId: id,
      expectedOwnerId: player.id,
      ownerId: gm.id,
    },
  ]) {
    const frame = { id: crypto.randomUUID(), ...command };
    assert.equal(commandSchema.safeParse(frame).success, false);
    assert.equal(
      commandSchema.safeParse({ ...frame, expectedVersion: 1 }).success,
      true,
    );
    assert.equal(
      commandSchema.safeParse({ ...frame, expectedVersion: 0 }).success,
      false,
    );
  }
  const legacy = {
    ...state,
    schemaVersion: 4,
    drawings: state.drawings.map(({ version: _, ...drawing }) => drawing),
  };
  const restored = restoreTable(legacy);
  assert.deepEqual(restored.state, state);
  assert.equal(restored.migrated, true);
  assert.throws(() => restoreTable({ ...legacy, schemaVersion: 5 }));
  assert.throws(() => restoreTable({ ...legacy, drawings: state.drawings }));
});
