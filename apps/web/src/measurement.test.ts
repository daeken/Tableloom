import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GRID } from "@tableloom/core/scene-grid";
import type { SceneGrid } from "@tableloom/core/scene-grid";
import {
  beginMeasurement,
  updateMeasurement,
  finishMeasurement,
  measurementCurrent,
  measurementDistance,
  formatDistance,
} from "./measurement.js";
const grid = (): SceneGrid => ({
  version: 3,
  settings: structuredClone(DEFAULT_GRID),
});
test("ruler reports Euclidean world distance and cell equivalents without imposing diagonal or game distance rules", () => {
  const g = grid(),
    drag = beginMeasurement({ x: -60, y: 120 }, g, false),
    ruler = updateMeasurement(drag, { x: 120, y: 360 });
  assert.deepEqual(measurementDistance(ruler), { units: 300, cells: 5 });
  assert.deepEqual(
    measurementDistance({ ...ruler, start: ruler.end, end: ruler.start }),
    { units: 300, cells: 5 },
  );
  assert.deepEqual(measurementDistance(drag), { units: 0, cells: 0 });
  const diagonal = updateMeasurement(
    beginMeasurement({ x: 0, y: 0 }, g, false),
    { x: 60, y: 60 },
  );
  assert.equal(measurementDistance(diagonal).cells, Math.SQRT2);
  const decimal = {
    version: 1,
    settings: {
      spacing: 80.5,
      origin: { x: 15.25, y: -25.75 },
      visible: false,
    },
  };
  assert.deepEqual(
    measurementDistance(
      updateMeasurement(
        beginMeasurement({ x: 0.25, y: 1.75 }, decimal, false),
        { x: 241.75, y: 323.75 },
      ),
    ),
    { units: 402.5, cells: 5 },
  );
});
test("ruler snapping captures shifted/hidden grid intersections and complete world bounds while preserving raw intent", () => {
  const g = {
      version: 4,
      settings: { spacing: 80, origin: { x: 15, y: -25 }, visible: false },
    },
    point = { x: 100, y: 100 },
    drag = beginMeasurement(point, g, true);
  assert.deepEqual(drag.start, { x: 95, y: 135 });
  assert.deepEqual(drag.rawStart, point);
  assert.deepEqual(updateMeasurement(drag, { x: 255, y: 300 }).end, {
    x: 255,
    y: 295,
  });
  assert.deepEqual(
    measurementDistance(updateMeasurement(drag, { x: 335, y: 455 })),
    { units: 400, cells: 5 },
  );
  point.x = 999;
  g.settings.spacing = 10;
  g.settings.origin.x = 999;
  assert.deepEqual(drag.start, { x: 95, y: 135 });
  assert.equal(drag.grid.settings.spacing, 80);
  assert.deepEqual(updateMeasurement(drag, { x: 255, y: 300 }).end, {
    x: 255,
    y: 295,
  });
  const edge = updateMeasurement(
    beginMeasurement({ x: -10000, y: 10000 }, grid(), true),
    { x: 10000, y: -10000 },
  );
  for (const p of [edge.start, edge.end])
    assert.ok(p.x >= -10000 && p.x <= 10000 && p.y >= -10000 && p.y <= 10000);
  assert.equal(
    measurementDistance(
      updateMeasurement(
        beginMeasurement({ x: -10000, y: -10000 }, grid(), false),
        { x: 10000, y: 10000 },
      ),
    ).units,
    Math.hypot(20000, 20000),
  );
});
test("ruler completion uses raw screen intent, latest pointer release and captured grid/version; stale or zero-length rulers disappear", () => {
  for (const scale of [0.25, 1, 3]) {
    const g = grid(),
      start = { x: 29.9, y: 0 },
      drag = beginMeasurement(start, g, true);
    assert.equal(finishMeasurement(drag, start, scale, g), null);
    // Crossing a snap midpoint alone is not sufficient intent.
    assert.equal(
      finishMeasurement(drag, { x: 29.9 + 2 / scale, y: 0 }, scale, g),
      null,
    );
    const free = beginMeasurement(start, g, false),
      last = { x: 29.9 + 4 / scale, y: 0 };
    const done = finishMeasurement(
      updateMeasurement(free, { x: 0, y: 0 }),
      last,
      scale,
      g,
    )!;
    assert.deepEqual(done.end, last);
    assert.ok(Math.abs(measurementDistance(done).units - 4 / scale) < 1e-10);
  }
  const g = grid(),
    drag = beginMeasurement({ x: 0, y: 0 }, g, true);
  assert.equal(finishMeasurement(drag, { x: 10, y: 10 }, 1, g), null); // Same snapped intersection.
  const done = finishMeasurement(drag, { x: 180, y: 240 }, 1, g)!;
  assert.deepEqual(measurementDistance(done), { units: 300, cells: 5 });
  assert.equal(measurementCurrent(done, structuredClone(g)), true);
  for (const next of [
    { ...g, version: 4 },
    { ...g, settings: { ...g.settings, spacing: 80 } },
    { ...g, settings: { ...g.settings, visible: false } },
    { ...g, settings: { ...g.settings, origin: { x: 1, y: 0 } } },
  ]) {
    assert.equal(measurementCurrent(done, next), false);
    assert.equal(finishMeasurement(drag, { x: 180, y: 240 }, 1, next), null);
  }
});
test("ruler readouts round to at most two decimal places without showing small positive distances as zero", () => {
  assert.equal(formatDistance(0), "0");
  assert.equal(formatDistance(5), "5");
  assert.equal(formatDistance(Math.SQRT2), "1.41");
  assert.equal(formatDistance(Math.hypot(20000, 20000)), "28,284.27");
  assert.equal(formatDistance(0.004), "<0.01");
  assert.equal(formatDistance(0.01), "0.01");
});
