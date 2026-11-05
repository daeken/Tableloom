import { test } from "node:test";
import assert from "node:assert/strict";
import type { Drawing } from "@tableloom/core";
import { drawingBounds, resizedDrawingPoints } from "@tableloom/core/geometry";
import {
  canResize,
  corners,
  cornerPoint,
  resizeDrag,
} from "./drawing-resize.js";
const drawing: Drawing = {
  id: crypto.randomUUID(),
  ownerId: crypto.randomUUID(),
  version: 7,
  kind: "stroke",
  color: "#405f4d",
  points: [
    { x: 20, y: 30 },
    { x: 70, y: 80 },
    { x: 120, y: 130 },
  ],
};

test("resize corners keep the opposite corner and pointer offset; previews use authoritative affine geometry", () => {
  const box = drawingBounds(drawing);
  for (const corner of corners) {
    const p = cornerPoint(box, corner),
      start = { x: p.x + 3, y: p.y - 2 };
    const result = resizeDrag(
      drawing,
      corner,
      start,
      { x: start.x + 10, y: start.y + 20 },
      1,
      false,
    )!;
    assert.equal(result[corner.endsWith("w") ? "left" : "right"], p.x + 10);
    assert.equal(result[corner.startsWith("n") ? "top" : "bottom"], p.y + 20);
    assert.equal(
      result[corner.endsWith("w") ? "right" : "left"],
      box[corner.endsWith("w") ? "right" : "left"],
    );
    assert.equal(
      result[corner.startsWith("n") ? "bottom" : "top"],
      box[corner.startsWith("n") ? "bottom" : "top"],
    );
    const points = resizedDrawingPoints(drawing, result);
    assert.deepEqual(points[1], {
      x: (result.left + result.right) / 2,
      y: (result.top + result.bottom) / 2,
    });
  }
  const decimal = {
    ...drawing,
    points: [
      { x: 0.1, y: -20.4 },
      { x: 10.3, y: 0.2 },
      { x: 5.15, y: -11.7 },
    ],
  };
  const horizontal = resizedDrawingPoints(decimal, {
    ...drawingBounds(decimal),
    right: 123.4,
  });
  assert.deepEqual(
    horizontal.map((p) => p.y),
    decimal.points.map((p) => p.y),
  );
  assert.equal(drawing.version, 7);
});

test("resize intent threshold is screen-based, clicks never snap, and collapse/flips/world escape are prevented", () => {
  const start = { x: 120, y: 130 };
  assert.equal(resizeDrag(drawing, "se", start, start, 1, true), null);
  assert.equal(
    resizeDrag(drawing, "se", start, { x: 121, y: 131 }, 2, true),
    null,
  );
  assert.ok(resizeDrag(drawing, "se", start, { x: 122, y: 131 }, 2, true));
  assert.deepEqual(
    resizeDrag(drawing, "se", start, { x: -1000, y: -1000 }, 1, false),
    { left: 20, right: 21, top: 30, bottom: 31 },
  );
  assert.deepEqual(
    resizeDrag(drawing, "se", start, { x: -1000, y: -1000 }, 1, true),
    { left: 20, right: 60, top: 30, bottom: 60 },
  );
  const huge = resizeDrag(
    drawing,
    "se",
    start,
    { x: 50000, y: 50000 },
    1,
    true,
  )!;
  assert.deepEqual(huge, { left: 20, top: 30, right: 9960, bottom: 9960 });
  const flat = {
    ...drawing,
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ],
  };
  assert.equal(canResize(flat), false);
  assert.equal(
    resizeDrag(flat, "se", start, { x: 200, y: 200 }, 1, false),
    null,
  );
});

test("resize uses shifted saved grid lines on each axis and rejects no-fit corners", () => {
  const grid = { spacing: 80, origin: { x: 15, y: -25 }, visible: false },
    start = { x: 120, y: 130 };
  assert.deepEqual(
    resizeDrag(drawing, "se", start, { x: 190, y: 190 }, 1, true, grid),
    { left: 20, top: 30, right: 175, bottom: 215 },
  );
  assert.deepEqual(
    resizeDrag(drawing, "se", start, { x: 190, y: 190 }, 1, false, grid),
    { left: 20, top: 30, right: 190, bottom: 190 },
  );
  const tiny = {
    ...drawing,
    points: [
      { x: -10000, y: -10000 },
      { x: -9999, y: -9999 },
    ],
  };
  assert.equal(
    resizeDrag(
      tiny,
      "nw",
      { x: -10000, y: -10000 },
      { x: -9990, y: -9990 },
      1,
      true,
      grid,
    ),
    null,
  );
});
