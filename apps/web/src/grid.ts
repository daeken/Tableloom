import { DEFAULT_GRID, type GridSettings } from "@tableloom/core/scene-grid";
import type { Point } from "@tableloom/core";
import { objectBounds, selectionDelta } from "./scene-selection.js";
import type { SceneObject } from "./scene-selection.js";

export const GRID_SIZE = 60;
const WORLD_MIN = -10000,
  WORLD_MAX = 10000;
export interface SnapAnchor {
  point: Point;
  offset: number;
  grid?: GridSettings;
}
/** Nearest point of the configured grid that also fits the complete selection. */
export function gridCoordinate(
  value: number,
  offset: number,
  min: number,
  max: number,
  spacing = GRID_SIZE,
): number | null {
  const first = Math.ceil((min - offset) / spacing),
    last = Math.floor((max - offset) / spacing);
  if (first > last) return null;
  const index = Math.max(
    first,
    Math.min(last, Math.round((value - offset) / spacing)),
  );
  return Math.max(min, Math.min(max, offset + index * spacing));
}
export function snapPoint(
  point: Point,
  offset = 0,
  grid: GridSettings = DEFAULT_GRID,
): Point {
  return {
    x: gridCoordinate(
      point.x,
      grid.origin.x + offset,
      WORLD_MIN,
      WORLD_MAX,
      grid.spacing,
    )!,
    y: gridCoordinate(
      point.y,
      grid.origin.y + offset,
      WORLD_MIN,
      WORLD_MAX,
      grid.spacing,
    )!,
  };
}
export function snapAnchor(
  object: SceneObject,
  grid?: GridSettings,
): SnapAnchor {
  const settings = grid ?? DEFAULT_GRID;
  const position =
    "position" in object
      ? { ...object.position }
      : (() => {
          const b = objectBounds(object);
          return { x: b.left, y: b.top };
        })();
  return {
    point: position,
    offset: "position" in object ? settings.spacing / 2 : 0,
    ...(grid ? { grid: structuredClone(grid) } : {}),
  };
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
  const settings = anchor.grid ?? DEFAULT_GRID;
  const x = gridCoordinate(
    anchor.point.x + raw.x,
    settings.origin.x + anchor.offset,
    anchor.point.x + WORLD_MIN - left,
    anchor.point.x + WORLD_MAX - right,
    settings.spacing,
  );
  const y = gridCoordinate(
    anchor.point.y + raw.y,
    settings.origin.y + anchor.offset,
    anchor.point.y + WORLD_MIN - top,
    anchor.point.y + WORLD_MAX - bottom,
    settings.spacing,
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
  grid: GridSettings = DEFAULT_GRID,
) {
  if (
    !grid.visible ||
    !Number.isFinite(grid.spacing) ||
    grid.spacing < 10 ||
    grid.spacing > 500 ||
    ![grid.origin.x, grid.origin.y].every(
      (v) => Number.isFinite(v) && Math.abs(v) <= 10000,
    )
  )
    return null;
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
  const spacing = grid.spacing;
  const lines = (min: number, max: number, origin: number) => {
    const result: number[] = [];
    for (
      let index = Math.ceil((min - origin) / spacing);
      index <= Math.floor((max - origin) / spacing);
      index++
    )
      result.push(origin + index * spacing);
    return result;
  };
  return {
    left,
    right,
    top,
    bottom,
    vertical: lines(left, right, grid.origin.x),
    horizontal: lines(top, bottom, grid.origin.y),
  };
}
