import { test } from "node:test";
import assert from "node:assert/strict";
import type { Token, Drawing } from "@tableloom/core";
import {
  GRID_SIZE,
  snapPoint,
  snapAnchor,
  dragDelta,
  visibleGrid,
} from "./grid.js";
import { translateObject } from "./scene-selection.js";
const token = (x: number, y: number): Token => ({
  id: crypto.randomUUID(),
  name: "Scout",
  position: { x, y },
  color: "#405f4d",
  ownerId: crypto.randomUUID(),
  version: 7,
});
const room = (
  left: number,
  top: number,
  right: number,
  bottom: number,
): Drawing => ({
  id: crypto.randomUUID(),
  kind: "rectangle",
  points: [
    { x: left, y: top },
    { x: right, y: bottom },
  ],
  color: "#405f4d",
  ownerId: crypto.randomUUID(),
  version: 4,
});

test("tokens snap to cell centers and room corners to grid lines, including negatives and world edges", () => {
  assert.deepEqual(snapPoint({ x: 91, y: -91 }, GRID_SIZE / 2), {
    x: 90,
    y: -90,
  });
  assert.deepEqual(snapPoint({ x: 91, y: -91 }), { x: 120, y: -120 });
  assert.deepEqual(snapPoint({ x: 10000, y: -10000 }, 30), {
    x: 9990,
    y: -9990,
  });
  assert.deepEqual(snapPoint({ x: 10000, y: -10000 }), { x: 9960, y: -9960 });
  assert.deepEqual(snapPoint({ x: 0, y: 0 }), { x: 0, y: 0 });
});

test("a mixed drag snaps the grabbed anchor while preserving exact spacing, shapes and captured versions", () => {
  const scout = token(5, 15),
    drawing = room(-20, -40, 80, 60),
    objects = [scout, drawing];
  const tokenDelta = dragDelta(objects, { x: 44, y: 35 }, 1, snapAnchor(scout));
  assert.deepEqual(tokenDelta, { x: 25, y: 15 });
  assert.deepEqual(translateObject(scout, tokenDelta), {
    ...scout,
    position: { x: 30, y: 30 },
  });
  assert.deepEqual(translateObject(drawing, tokenDelta), {
    ...drawing,
    points: [
      { x: 5, y: -25 },
      { x: 105, y: 75 },
    ],
  });
  const drawingDelta = dragDelta(
    objects,
    { x: 44, y: 35 },
    1,
    snapAnchor(drawing),
  );
  assert.deepEqual(drawingDelta, { x: 20, y: 40 });
  assert.deepEqual(translateObject(drawing, drawingDelta), {
    ...drawing,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ],
  });
  assert.equal(scout.version, 7);
  assert.equal(drawing.version, 4);
  assert.deepEqual(scout.position, { x: 5, y: 15 });
});

test("off-grid clicks and sub-threshold motion never become snapping edits, at any supported zoom", () => {
  const scout = token(5, 15),
    anchor = snapAnchor(scout);
  for (const scale of [0.25, 1, 3])
    assert.deepEqual(dragDelta([scout], { x: 0, y: 0 }, scale, anchor), {
      x: 0,
      y: 0,
    });
  assert.deepEqual(dragDelta([scout], { x: 8, y: 0 }, 0.25, anchor), {
    x: 0,
    y: 0,
  });
  assert.deepEqual(dragDelta([scout], { x: 16, y: 0 }, 0.25, anchor), {
    x: 25,
    y: 15,
  });
  assert.deepEqual(dragDelta([scout], { x: 4, y: 5 }, 1, null), { x: 4, y: 5 });
  assert.deepEqual(dragDelta([], { x: 100, y: 100 }, 1, null), { x: 0, y: 0 });
});

test("snapped groups choose valid grid positions for all geometry, and no-fit axes stay unchanged", () => {
  const scout = token(9990, 30),
    drawing = room(9950, 0, 10000, 60),
    objects = [scout, drawing];
  assert.deepEqual(dragDelta(objects, { x: 500, y: 0 }, 1, snapAnchor(scout)), {
    x: 0,
    y: 0,
  });
  const edge = token(9995, 30);
  assert.deepEqual(dragDelta([edge], { x: 100, y: 0 }, 1, snapAnchor(edge)), {
    x: -5,
    y: 0,
  });
  const huge = [token(-10000, 30), token(9999, 30)];
  assert.deepEqual(
    dragDelta(huge, { x: 100, y: 60 }, 1, snapAnchor(huge[0]!)),
    { x: 0, y: 60 },
  );
  assert.deepEqual(dragDelta(huge, { x: 100, y: 60 }, 1, null), {
    x: 1,
    y: 60,
  });
});

test("visible grids follow the camera and viewport at the same zero origin without unbounded offscreen lines", () => {
  const far = visibleGrid({ x: -6000, y: -6000, scale: 1 }, 600, 400)!;
  assert.equal(far.vertical[0], 6000);
  assert.equal(far.vertical.at(-1), 6600);
  assert.equal(far.horizontal.at(-1), 6360);
  const zoomed = visibleGrid({ x: 1200, y: 600, scale: 0.5 }, 600, 300)!;
  assert.deepEqual(
    [zoomed.left, zoomed.right, zoomed.top, zoomed.bottom],
    [-2400, -1200, -1200, -600],
  );
  assert.equal(zoomed.vertical.length, 21);
  assert.ok(zoomed.vertical.every((value) => value % 60 === 0));
  const whole = visibleGrid({ x: 20000, y: 20000, scale: 1 }, 40000, 40000)!;
  assert.ok(whole.vertical.length <= 334 && whole.horizontal.length <= 334);
  assert.ok(whole.vertical.every((value) => value >= -10000 && value <= 10000));
  assert.equal(visibleGrid({ x: 1e9, y: 0, scale: 1 }, 600, 400), null);
  assert.equal(visibleGrid({ x: 0, y: 0, scale: 0 }, 600, 400), null);
  assert.equal(visibleGrid({ x: NaN, y: 0, scale: 1 }, 600, 400), null);
  assert.equal(visibleGrid({ x: 0, y: 0, scale: 1 }, 0, 400), null);
});
