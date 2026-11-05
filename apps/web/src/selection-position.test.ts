import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema, type Drawing, type Token } from "@tableloom/core";
import {
  selectionPosition,
  selectionPositionCommand,
} from "./selection-position.js";
const member = {
  id: crypto.randomUUID(),
  tableId: crypto.randomUUID(),
  name: "Player",
  role: "player" as const,
};
const token: Token = {
  id: crypto.randomUUID(),
  name: "Scout",
  position: { x: -20, y: 10 },
  radius: 24,
  color: "#405f4d",
  ownerId: member.id,
  version: 4,
};
const drawing: Drawing = {
  id: crypto.randomUUID(),
  kind: "stroke",
  points: [
    { x: 80, y: -40 },
    { x: 25, y: 30 },
    { x: 100, y: 60 },
  ],
  color: "#405f4d",
  ownerId: member.id,
  version: 2,
};
const state = { tokens: [token], drawings: [drawing] };
test("exact position anchors use token centers and minima of every drawing point", () => {
  assert.equal(selectionPosition([]), null);
  assert.deepEqual(selectionPosition([token]), { x: -20, y: 10 });
  assert.deepEqual(selectionPosition([drawing]), { x: 25, y: -40 });
  assert.deepEqual(selectionPosition([token, drawing]), { x: -20, y: -40 });
  assert.deepEqual(selectionPosition([drawing, token]), { x: -20, y: -40 });
});
test("absolute positioning emits one rigid move with frozen version preconditions for single and mixed sets", () => {
  for (const objects of [[token], [drawing], [token, drawing]]) {
    const anchor = selectionPosition(objects)!,
      command = selectionPositionCommand(
        objects,
        String(anchor.x + 35.5),
        String(anchor.y - 20),
        state,
        member,
        true,
        false,
      );
    assert.deepEqual(command, {
      type: "objects.move",
      objects: objects.map((o) => ({
        objectId: o.id,
        expectedVersion: o.version,
      })),
      delta: { x: 35.5, y: -20 },
    });
    assert.equal(
      commandSchema.safeParse({ ...command, id: crypto.randomUUID() }).success,
      true,
    );
  }
  assert.deepEqual(drawing.points[1], { x: 25, y: 30 });
});
test("absolute coordinates reject blanks, nonfinite numbers, unchanged positions and any translated overflow rather than clamping", () => {
  const move = (x: string, y = "30") =>
    selectionPositionCommand(
      [token, drawing],
      x,
      y,
      state,
      member,
      true,
      false,
    );
  for (const x of [
    "",
    " ",
    "Infinity",
    "NaN",
    "10001",
    "-10001",
    "10000",
    "9990",
  ])
    assert.equal(move(x), null);
  for (const y of ["", " ", "-Infinity", "NaN", "10001", "10000"])
    assert.equal(move("1", y), null);
  assert.equal(move("-20", "-40"), null);
  assert.ok(move("9880", "9900"));
  // A token center may reach the limit even though its visual radius extends beyond it.
  assert.ok(
    selectionPositionCommand(
      [token],
      "10000",
      "-10000",
      state,
      member,
      true,
      false,
    ),
  );
});
test("coordinate drafts reject stale/missing/transferred targets, partial or invalid sets and pending/offline state", () => {
  const move = (
    objects = [token, drawing],
    view = state,
    actor: typeof member | null = member,
    enabled = true,
    pending = false,
  ) =>
    selectionPositionCommand(objects, "0", "0", view, actor, enabled, pending);
  assert.equal(move([], state), null);
  assert.equal(move([token, token], state), null);
  assert.equal(move(Array.from({ length: 101 }, () => token)), null);
  assert.equal(move([token], { ...state, tokens: [] }), null);
  assert.equal(
    move([token], { ...state, tokens: [{ ...token, version: 5 }] }),
    null,
  );
  assert.equal(
    move([token], {
      ...state,
      tokens: [{ ...token, ownerId: crypto.randomUUID() }],
    }),
    null,
  );
  assert.equal(move(undefined, undefined, null), null);
  assert.equal(
    move(undefined, undefined, { ...member, id: crypto.randomUUID() }),
    null,
  );
  assert.equal(move(undefined, undefined, member, false), null);
  assert.equal(move(undefined, undefined, member, true, true), null);
  const gm = { ...member, role: "gm" as const };
  assert.ok(
    selectionPositionCommand(
      [token, drawing],
      "0",
      "0",
      state,
      gm,
      true,
      false,
    ),
  );
});
