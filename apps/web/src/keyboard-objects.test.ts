import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema, type Drawing, type Token } from "@tableloom/core";
import {
  keyboardMoveCommand,
  keyboardObjectChoices,
  keyboardSelection,
  sceneObjectLabel,
} from "./keyboard-objects.js";
const member = {
  id: crypto.randomUUID(),
  tableId: crypto.randomUUID(),
  name: "Player",
  role: "player" as const,
};
const token: Token = {
  id: crypto.randomUUID(),
  name: "Scout <&>",
  position: { x: 10, y: 20 },
  radius: 24,
  color: "#405f4d",
  ownerId: member.id,
  version: 7,
};
const room: Drawing = {
  id: crypto.randomUUID(),
  kind: "rectangle",
  points: [
    { x: 20, y: 30 },
    { x: 40, y: 50 },
  ],
  color: "#405f4d",
  ownerId: member.id,
  version: 3,
};
const state = { tokens: [token], drawings: [room] };
test("keyboard selection resolves the exact ordered editable set, rejects duplicates/missing/unauthorized/over-cap choices, and allows local clear", () => {
  assert.deepEqual(keyboardSelection([room.id, token.id], state, member), [
    room,
    token,
  ]);
  assert.deepEqual(keyboardSelection([], state, member), []);
  for (const ids of [
    [token.id, token.id],
    [crypto.randomUUID()],
    [token.id, crypto.randomUUID()],
    Array.from({ length: 101 }, () => token.id),
  ])
    assert.equal(keyboardSelection(ids, state, member), null);
  assert.equal(keyboardSelection([token.id], state, null), null);
  assert.equal(
    keyboardSelection([token.id], state, {
      ...member,
      id: crypto.randomUUID(),
    }),
    null,
  );
  assert.deepEqual(
    keyboardSelection([token.id], state, {
      ...member,
      id: crypto.randomUUID(),
      role: "gm",
    }),
    [token],
  );
});
test("object lookup searches full literal text/names/IDs and excludes objects outside current edit permission", () => {
  const label: Drawing = {
      ...room,
      id: crypto.randomUUID(),
      kind: "text",
      text: "start " + "x".repeat(80) + " faraway clue",
      textStyle: { font: "monospace", weight: "normal", align: "left" },
    },
    foreign = {
      ...token,
      id: crypto.randomUUID(),
      ownerId: crypto.randomUUID(),
      name: "Other",
    },
    view = { tokens: [token, foreign], drawings: [room, label] };
  assert.deepEqual(keyboardObjectChoices(view, member, "  SCOUT <&> "), [
    token,
  ]);
  assert.deepEqual(keyboardObjectChoices(view, member, "faraway clue"), [
    label,
  ]);
  assert.deepEqual(keyboardObjectChoices(view, member, room.id), [room]);
  assert.deepEqual(keyboardObjectChoices(view, member, "Other"), []);
  assert.equal(
    keyboardObjectChoices(view, { ...member, role: "gm" }, "").length,
    4,
  );
  assert.deepEqual(keyboardObjectChoices(view, null, ""), []);
  assert.equal(sceneObjectLabel(token), "Token: Scout <&>");
});
test("keyboard movement uses captured versions and one bounded rigid command for token/drawing/mixed selections", () => {
  const command = keyboardMoveCommand(
    [token, room],
    state,
    member,
    "right",
    10,
    true,
    false,
  );
  assert.deepEqual(command, {
    type: "objects.move",
    objects: [
      { objectId: token.id, expectedVersion: 7 },
      { objectId: room.id, expectedVersion: 3 },
    ],
    delta: { x: 10, y: 0 },
  });
  assert.equal(
    commandSchema.safeParse({ ...command, id: crypto.randomUUID() }).success,
    true,
  );
  for (const [direction, delta] of [
    ["left", { x: -1, y: 0 }],
    ["up", { x: 0, y: -1 }],
    ["down", { x: 0, y: 1 }],
  ] as const) {
    const moved = keyboardMoveCommand(
      [token],
      state,
      member,
      direction,
      1,
      true,
      false,
    );
    assert.ok(moved?.type === "objects.move");
    assert.deepEqual(moved.delta, delta);
  }
  const edge = { ...token, position: { x: 9999, y: 20 } },
    edgeState = { tokens: [edge], drawings: [] };
  const capped = keyboardMoveCommand(
    [edge],
    edgeState,
    member,
    "right",
    5000,
    true,
    false,
  );
  assert.ok(capped?.type === "objects.move");
  assert.deepEqual(capped.delta, { x: 1, y: 0 });
  const atEdge = { ...edge, position: { x: 10000, y: 20 } };
  assert.equal(
    keyboardMoveCommand(
      [atEdge],
      { tokens: [atEdge], drawings: [] },
      member,
      "right",
      1,
      true,
      false,
    ),
    null,
  );
  assert.deepEqual(token.position, { x: 10, y: 20 });
});
test("nudge guards stale targets, ownership loss, removed objects, empty selections, pending/offline and invalid step data", () => {
  const move = (
    objects = [token, room],
    view = state,
    actor = member,
    distance = 1,
    enabled = true,
    pending = false,
  ) =>
    keyboardMoveCommand(
      objects,
      view,
      actor,
      "right",
      distance,
      enabled,
      pending,
    );
  assert.equal(move([], state), null);
  assert.equal(
    move([token], { ...state, tokens: [{ ...token, version: 8 }] }),
    null,
  );
  assert.equal(move([token], { ...state, tokens: [] }), null);
  assert.equal(
    move([token], {
      ...state,
      tokens: [{ ...token, ownerId: crypto.randomUUID() }],
    }),
    null,
  );
  assert.equal(
    move([token], state, { ...member, id: crypto.randomUUID() }),
    null,
  );
  assert.equal(move([token], state, member, 1, false), null);
  assert.equal(move([token], state, member, 1, true, true), null);
  for (const distance of [0, -1, NaN, Infinity, 5001])
    assert.equal(move([token], state, member, distance), null);
});
