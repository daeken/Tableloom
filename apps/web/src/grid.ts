import type { Point } from "@tableloom/core";
import { objectBounds, selectionDelta } from "./scene-selection.js";
import type { SceneObject } from "./scene-selection.js";

export const GRID_SIZE = 60;
const WORLD_MIN = -10000,
  WORLD_MAX = 10000;
export interface SnapAnchor {
  point: Point;
  offset: number;
}
/** Nearest point of the zero-origin grid that also fits the complete selection. */
function coordinate(
  value: number,
  offset: number,
  min: number,
  max: number,
): number | null {
  const first = Math.ceil((min - offset) / GRID_SIZE),
    last = Math.floor((max - offset) / GRID_SIZE);
  if (first > last) return null;
  const index = Math.max(
    first,
    Math.min(last, Math.round((value - offset) / GRID_SIZE)),
  );
  return offset + index * GRID_SIZE;
}
export function snapPoint(point: Point, offset = 0): Point {
  return {
    x: coordinate(point.x, offset, WORLD_MIN, WORLD_MAX)!,
    y: coordinate(point.y, offset, WORLD_MIN, WORLD_MAX)!,
  };
}
export function snapAnchor(object: SceneObject): SnapAnchor {
  if ("position" in object)
    return { point: { ...object.position }, offset: GRID_SIZE / 2 };
  const bounds = objectBounds(object);
  return { point: { x: bounds.left, y: bounds.top }, offset: 0 };
}
/** A click never becomes an edit, even if its object began off-grid. */
export function dragDelta(
  objects: readonly SceneObject[],
  raw: Point,
  scale: number,
  anchor: SnapAnchor | null,
): Point {
  if (!objects.length || Math.hypot(raw.x * scale, raw.y * scale) < 3)
    return { x: 0, y: 0 };
  if (!anchor) return selectionDelta(objects, raw);
  const bounds = objects.map(objectBounds),
    left = Math.min(...bounds.map((box) => box.left)),
    right = Math.max(...bounds.map((box) => box.right)),
    top = Math.min(...bounds.map((box) => box.top)),
    bottom = Math.max(...bounds.map((box) => box.bottom));
  const x = coordinate(
    anchor.point.x + raw.x,
    anchor.offset,
    anchor.point.x + WORLD_MIN - left,
    anchor.point.x + WORLD_MAX - right,
  );
  const y = coordinate(
    anchor.point.y + raw.y,
    anchor.offset,
    anchor.point.y + WORLD_MIN - top,
    anchor.point.y + WORLD_MAX - bottom,
  );
  // An almost world-sized off-grid group may have no grid-compatible translation
  // on an axis. Keep that axis unchanged rather than distorting or leaving bounds.
  return {
    x: x === null ? 0 : x - anchor.point.x,
    y: y === null ? 0 : y - anchor.point.y,
  };
}
export function visibleGrid(
  view: { x: number; y: number; scale: number },
  width: number,
  height: number,
) {
  if (
    ![view.x, view.y, view.scale, width, height].every(Number.isFinite) ||
    view.scale <= 0 ||
    width <= 0 ||
    height <= 0
  )
    return null;
  const left = Math.max(WORLD_MIN, -view.x / view.scale),
    right = Math.min(WORLD_MAX, (width - view.x) / view.scale),
    top = Math.max(WORLD_MIN, -view.y / view.scale),
    bottom = Math.min(WORLD_MAX, (height - view.y) / view.scale);
  if (left > right || top > bottom) return null;
  const lines = (min: number, max: number) => {
    const result: number[] = [];
    for (
      let index = Math.ceil(min / GRID_SIZE);
      index <= Math.floor(max / GRID_SIZE);
      index++
    )
      result.push(index * GRID_SIZE);
    return result;
  };
  return {
    left,
    right,
    top,
    bottom,
    vertical: lines(left, right),
    horizontal: lines(top, bottom),
  };
}
