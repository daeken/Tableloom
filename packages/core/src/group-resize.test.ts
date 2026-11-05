import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema, createTable } from "./index.js";
import { groupBounds, resizedObjects } from "./geometry.js";
import type { Member } from "./access.js";
import { applyCommand } from "./server.js";
const owner: Member = {
    id: crypto.randomUUID(),
    tableId: crypto.randomUUID(),
    name: "Owner",
    role: "player",
  },
  stranger = { ...owner, id: crypto.randomUUID() };
const token = (x: number, y: number, radius = 24) => ({
  id: crypto.randomUUID(),
  name: "Scout",
  color: "#405f4d",
  position: { x, y },
  radius,
  ownerId: owner.id,
  version: 3,
});
const drawing = (x: number, y: number) => ({
  id: crypto.randomUUID(),
  kind: "stroke" as const,
  color: "#aabbcc",
  ownerId: owner.id,
  version: 5,
  points: [
    { x, y },
    { x: x + 10.3, y: y + 20.4 },
  ],
});

test("group scale uses footprint center, keeps token circles, proportions, spacing and metadata, and commits one revision for each selection kind", () => {
  const a = token(-20, 0, 10),
    b = token(40, 50, 20),
    d = {
      ...drawing(-50, -30),
      points: [
        { x: -50, y: -30 },
        { x: 70, y: 90 },
      ],
    };
  const result = resizedObjects([a, b, d], 2);
  assert.deepEqual(groupBounds([a, b, d]), {
    left: -50,
    right: 70,
    top: -30,
    bottom: 90,
  });
  assert.deepEqual(result[0], {
    ...a,
    radius: 20,
    position: { x: -50, y: -30 },
  });
  assert.deepEqual(result[1], { ...b, radius: 40, position: { x: 70, y: 70 } });
  assert.deepEqual(result[2], {
    ...d,
    points: [
      { x: -110, y: -90 },
      { x: 130, y: 150 },
    ],
  });
  for (const objects of [
    [a, b],
    [d, drawing(10.1, 20.2)],
    [a, d],
  ]) {
    const state = {
        ...createTable(),
        tokens: objects.filter((o) => "position" in o),
        drawings: objects.filter((o) => "points" in o),
      },
      before = structuredClone(state),
      command = {
        id: crypto.randomUUID(),
        type: "objects.resize" as const,
        objects: objects.map((o) => ({
          objectId: o.id,
          expectedVersion: o.version,
        })),
        scale: 1.75,
      };
    const next = applyCommand(state, command, owner);
    assert.equal(next.revision, state.revision + 1);
    const afterObjects = [...next.tokens, ...next.drawings];
    for (const object of objects)
      assert.equal(
        afterObjects.find((o) => o.id === object.id)!.version,
        object.version + 1,
      );
    assert.deepEqual(state, before);
  }
});

test("one stale/unauthorized/missing/duplicate/invalid/overflow target rejects the complete resize without mutation", () => {
  const a = token(0.1, 0.2),
    d = drawing(20.3, -30.4),
    state = { ...createTable(), tokens: [a], drawings: [d] },
    before = structuredClone(state),
    command = {
      id: crypto.randomUUID(),
      type: "objects.resize" as const,
      objects: [a, d].map((o) => ({
        objectId: o.id,
        expectedVersion: o.version,
      })),
      scale: 2,
    };
  assert.throws(() => applyCommand(state, command, stranger), /owner or GM/);
  for (const objects of [
    [{ objectId: a.id, expectedVersion: 2 }, command.objects[1]!],
    [
      command.objects[0]!,
      { objectId: crypto.randomUUID(), expectedVersion: 1 },
    ],
    [command.objects[0]!, command.objects[0]!],
    [command.objects[0]!],
  ])
    assert.throws(() => applyCommand(state, { ...command, objects }, owner));
  for (const scale of [0, -1, 1, NaN, Infinity, 0.009, 101, 100, 0.01]) {
    if ([100, 0.01].includes(scale))
      assert.equal(
        commandSchema.safeParse({ ...command, scale }).success,
        true,
      );
    else
      assert.equal(
        commandSchema.safeParse({ ...command, scale }).success,
        false,
      );
    assert.throws(() => applyCommand(state, { ...command, scale }, owner));
  }
  const far = {
    ...state,
    drawings: [
      {
        ...d,
        points: [
          { x: -9999, y: -9999 },
          { x: 9999, y: 9999 },
        ],
      },
    ],
  };
  assert.throws(() => applyCommand(far, command, owner));
  assert.equal(
    commandSchema.safeParse({ ...command, ownerId: owner.id }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      ...command,
      objects: Array.from({ length: 101 }, () => ({
        objectId: crypto.randomUUID(),
        expectedVersion: 1,
      })),
    }).success,
    false,
  );
  assert.deepEqual(state, before);
});

test("flat drawings scale without division by zero, but a coincident unchanged selection is rejected", () => {
  const a = {
      ...drawing(0, 0),
      points: [
        { x: 0.1, y: 0 },
        { x: 10.3, y: 0 },
      ],
    },
    b = {
      ...drawing(20, 0),
      points: [
        { x: 20, y: 0 },
        { x: 50, y: 0 },
      ],
    };
  const scaled = resizedObjects([a, b], 0.5);
  for (const object of scaled)
    assert.ok("points" in object && object.points.every((p) => p.y === 0));
  const point = {
    ...a,
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
  };
  assert.throws(
    () => resizedObjects([point, { ...point, id: crypto.randomUUID() }], 2),
    /would not change/,
  );
});
