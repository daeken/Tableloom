import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  drawingSchema,
  commandSchema,
  createTable,
  restoreTable,
  tableSchema,
} from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { textPlacement } from "./text-placement.js";
import {
  hitDrawing,
  objectBounds,
  translateObject,
  objectsInBox,
  captureDeletionReview,
} from "./scene-selection.js";
import type { Member } from "@tableloom/core/access";
const gm: Member = {
  id: randomUUID(),
  tableId: randomUUID(),
  name: "GM",
  role: "gm",
};
test("plain text labels have bounded validated text/boxes and server-assigned ownership; former saves remain explicit legacy data", () => {
  const drawing = textPlacement(
      "<b>North gate</b>\n鍵",
      { x: 9999, y: 9999 },
      "#405f4d",
      randomUUID(),
    ),
    command = commandSchema.parse({
      id: randomUUID(),
      type: "drawing.add",
      drawing,
    }),
    state = applyCommand(createTable(), command, gm);
  assert.equal(state.drawings[0]!.text, drawing.text);
  assert.equal(state.drawings[0]!.ownerId, gm.id);
  assert.equal(state.drawings[0]!.version, 1);
  assert.ok(drawing.points[1]!.x <= 10000 && drawing.points[1]!.y <= 10000);
  for (const change of [
    { text: undefined },
    { text: "  " },
    { text: "x".repeat(501) },
    { text: Array(21).fill("x").join("\n") },
    { text: "bad\u0000" },
    {
      points: [
        { x: 1, y: 1 },
        { x: 0, y: 0 },
      ],
    },
    {
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 5 },
      ],
    },
    { kind: "stroke" },
  ])
    assert.throws(() =>
      commandSchema.parse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: { ...drawing, ...change },
      }),
    );
  assert.throws(() =>
    commandSchema.parse({
      ...command,
      drawing: { ...drawing, ownerId: gm.id },
    }),
  );
  const old = { ...createTable(), schemaVersion: 6 };
  assert.equal(restoreTable(old).state.schemaVersion, 8);
  assert.ok(restoreTable(old).migrated);
  assert.throws(() => restoreTable({ ...old, drawings: state.drawings }));
  assert.ok(!tableSchema.safeParse({ ...state, schemaVersion: 6 }).success);
  assert.throws(() =>
    drawingSchema.parse({ ...state.drawings[0], text: undefined }),
  );
});
test("text selection hits its full box, translates/clamps neutral geometry and gives reviewed deletion a truthful label", () => {
  const input = textPlacement(
      "Courtyard\nNorth",
      { x: 60, y: 90 },
      "#405f4d",
      randomUUID(),
    ),
    drawing = drawingSchema.parse({ ...input, version: 1, ownerId: gm.id }),
    box = objectBounds(drawing);
  assert.equal(
    hitDrawing(drawing, { x: box.left + 12, y: box.top + 12 }, 0),
    true,
  );
  assert.equal(
    hitDrawing(drawing, { x: box.right + 10, y: box.bottom + 10 }, 1),
    false,
  );
  assert.deepEqual(
    objectsInBox(
      [drawing],
      { x: box.left, y: box.top },
      { x: box.right, y: box.bottom },
    ),
    [drawing.id],
  );
  const moved = translateObject(drawing, { x: 10.5, y: -20.25 });
  assert.ok("points" in moved);
  if ("points" in moved) assert.equal(moved.points[0]!.x, 70.5);
  assert.equal(captureDeletionReview([drawing])[0]!.label, "Text label");
  assert.throws(() =>
    textPlacement("bad\ttext", { x: 0, y: 0 }, "#405f4d", randomUUID()),
  );
});
