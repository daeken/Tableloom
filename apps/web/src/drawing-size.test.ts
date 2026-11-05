import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema, type Drawing } from "@tableloom/core";
import { resizedDrawingPoints } from "@tableloom/core/geometry";
import { drawingSizeBounds, drawingSizeCommand } from "./drawing-size.js";
const member = {
  id: crypto.randomUUID(),
  tableId: crypto.randomUUID(),
  name: "Player",
  role: "player" as const,
};
const drawing: Drawing = {
  id: crypto.randomUUID(),
  kind: "stroke",
  points: [
    { x: 20, y: 30 },
    { x: 70, y: 50 },
    { x: 120, y: 130 },
  ],
  color: "#405f4d",
  ownerId: member.id,
  version: 7,
};
const state = { tokens: [], drawings: [drawing] };
test("drawing size entry keeps upper-left fixed and uses the authoritative independent-axis transform for all drawing kinds", () => {
  const bounds = drawingSizeBounds(drawing, "200.5", "50")!;
  assert.deepEqual(bounds, { left: 20, top: 30, right: 220.5, bottom: 80 });
  assert.deepEqual(resizedDrawingPoints(drawing, bounds), [
    { x: 20, y: 30 },
    { x: 120.25, y: 40 },
    { x: 220.5, y: 80 },
  ]);
  for (const kind of ["rectangle", "text", "stroke"] as const) {
    const object: Drawing = {
      ...drawing,
      kind,
      ...(kind === "text"
        ? {
            points: [drawing.points[0]!, drawing.points[2]!],
            text: "North <gate>",
            textStyle: { font: "serif", weight: "bold", align: "left" },
          }
        : {}),
    };
    const command = drawingSizeCommand(
      object,
      "200.5",
      "50",
      { ...state, drawings: [object] },
      member,
      true,
      false,
    );
    assert.deepEqual(command, {
      type: "drawing.resize",
      drawingId: object.id,
      expectedVersion: 7,
      bounds,
    });
    assert.equal(
      commandSchema.safeParse({ ...command, id: crypto.randomUUID() }).success,
      true,
    );
  }
  assert.deepEqual(drawing.points[1], { x: 70, y: 50 });
});
test("drawing size entry rejects blanks, nonfinite/sub-unit/no-op/overflow dimensions and flat geometry", () => {
  for (const value of ["", " ", "NaN", "Infinity", "0", "-1", "0.5", "20001"])
    for (const field of ["width", "height"]) {
      assert.equal(
        drawingSizeBounds(
          drawing,
          field === "width" ? value : "200",
          field === "height" ? value : "200",
        ),
        null,
      );
    }
  assert.equal(drawingSizeBounds(drawing, "100", "100"), null);
  assert.equal(drawingSizeBounds(drawing, "9981", "100"), null);
  assert.equal(drawingSizeBounds(drawing, "100", "9971"), null);
  assert.ok(drawingSizeBounds(drawing, "9980", "9970"));
  const flat = {
    ...drawing,
    points: [
      { x: 10, y: 20 },
      { x: 10, y: 40 },
    ],
  };
  assert.equal(drawingSizeBounds(flat, "10", "40"), null);
});
test("unchanged axis bounds and points remain exact, including decimal geometry", () => {
  const object = {
    ...drawing,
    points: [
      { x: 0.1, y: -20.4 },
      { x: 10.3, y: 0.2 },
      { x: 5.15, y: -11.7 },
    ],
  };
  const bounds = drawingSizeBounds(object, "123.4", String(0.2 - -20.4))!;
  assert.equal(bounds.top, -20.4);
  assert.equal(bounds.bottom, 0.2);
  assert.deepEqual(
    resizedDrawingPoints(object, bounds).map((p) => p.y),
    object.points.map((p) => p.y),
  );
});
test("resize drafts require current frozen versions, ownership, existence and a live idle scene", () => {
  const resize = (
    view = state,
    actor: typeof member | null = member,
    enabled = true,
    pending = false,
  ) => drawingSizeCommand(drawing, "200", "300", view, actor, enabled, pending);
  assert.equal(resize({ ...state, drawings: [] }), null);
  assert.equal(
    resize({ ...state, drawings: [{ ...drawing, version: 8 }] }),
    null,
  );
  assert.equal(
    resize({
      ...state,
      drawings: [{ ...drawing, ownerId: crypto.randomUUID() }],
    }),
    null,
  );
  assert.equal(resize(state, null), null);
  assert.equal(resize(state, { ...member, id: crypto.randomUUID() }), null);
  assert.equal(resize(state, member, false), null);
  assert.equal(resize(state, member, true, true), null);
  assert.ok(
    drawingSizeCommand(
      drawing,
      "200",
      "300",
      state,
      { ...member, id: crypto.randomUUID(), role: "gm" },
      true,
      false,
    ),
  );
});
