import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema, createTable, parseDice } from "./index.js";
import { applyCommand, rollDice } from "./server.js";

const player = {
  id: randomUUID(),
  name: "Player",
  role: "player" as const,
  tableId: "00000000-0000-4000-8000-000000000001" as const,
};

test("dice expressions support defaults, whitespace, modifiers, and upper bounds", () => {
  assert.deepEqual(parseDice("d20"), { count: 1, sides: 20, modifier: 0 });
  assert.deepEqual(parseDice(" 2D6 - 3 "), {
    count: 2,
    sides: 6,
    modifier: -3,
  });
  assert.deepEqual(parseDice("100d1000 + 10000"), {
    count: 100,
    sides: 1000,
    modifier: 10000,
  });
  for (const input of [
    "0d6",
    "101d6",
    "1d1",
    "2d1001",
    "2d6 + 10001",
    "2d6 trailing",
    "Math.random()",
    "2d6 + 3d4",
    "",
  ]) {
    assert.throws(() => parseDice(input), Error, input);
  }
});

test("server dice preserve individual results, sides, and signed modifiers", () => {
  const calls: [number, number][] = [];
  const result = rollDice("2d6 - 3", "Player", (min, max) => {
    calls.push([min, max]);
    return 6;
  });
  assert.deepEqual(calls, [
    [1, 7],
    [1, 7],
  ]);
  assert.deepEqual(result.dice, [6, 6]);
  assert.equal(result.total, 9);
  assert.equal(result.modifier, -3);
  assert.equal(result.actor, "Player");
});

test("commands validate IDs, finite coordinates, bounded payloads, and extension system IDs", () => {
  assert.equal(
    commandSchema.safeParse({
      id: randomUUID(),
      type: "system.set",
      systemId: "a-future-game",
    }).success,
    true,
  );
  assert.equal(
    commandSchema.safeParse({ id: "bad", type: "dice.roll", expression: "d6" })
      .success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      id: randomUUID(),
      type: "token.move",
      tokenId: randomUUID(),
      position: { x: Infinity, y: 2 },
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      id: randomUUID(),
      type: "token.move",
      tokenId: randomUUID(),
      position: { x: 10001, y: 2 },
    }).success,
    false,
  );
});

test("mutations do not mutate old snapshots and reject duplicate/missing objects", () => {
  const before = createTable();
  const token = {
    id: randomUUID(),
    name: "Robin",
    position: { x: 10, y: 20 },
    color: "#405f4d",
  };
  const added = applyCommand(
    before,
    { id: randomUUID(), type: "token.add", token },
    player,
  );
  assert.equal(before.tokens.length, 0);
  assert.equal(added.revision, 1);
  const moved = applyCommand(
    added,
    {
      id: randomUUID(),
      type: "token.move",
      tokenId: token.id,
      position: { x: 40, y: 50 },
    },
    player,
  );
  assert.deepEqual(added.tokens[0]?.position, { x: 10, y: 20 });
  assert.deepEqual(moved.tokens[0]?.position, { x: 40, y: 50 });
  assert.throws(() =>
    applyCommand(added, { id: randomUUID(), type: "token.add", token }, player),
  );
  assert.throws(() =>
    applyCommand(
      before,
      {
        id: randomUUID(),
        type: "token.move",
        tokenId: token.id,
        position: { x: 0, y: 0 },
      },
      player,
    ),
  );
  const removed = applyCommand(
    moved,
    { id: randomUUID(), type: "object.delete", objectId: token.id },
    player,
  );
  assert.equal(removed.tokens.length, 0);
});

test("roll history is bounded", () => {
  let state = createTable();
  for (let i = 0; i < 110; i++)
    state = applyCommand(
      state,
      { id: randomUUID(), type: "dice.roll", expression: "d6" },
      player,
    );
  assert.equal(state.rolls.length, 100);
  assert.equal(state.revision, 110);
});
