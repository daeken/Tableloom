import type { Drawing, Point, ResizeBounds } from "@tableloom/core";
import { drawingBounds } from "@tableloom/core/geometry";
import { gridCoordinate } from "./grid.js";
import { DEFAULT_GRID, type GridSettings } from "@tableloom/core/scene-grid";

export type Corner = "nw" | "ne" | "se" | "sw";
export const corners: Corner[] = ["nw", "ne", "se", "sw"];
export function cornerPoint(box: ResizeBounds, corner: Corner): Point {
  return {
    x: corner.endsWith("w") ? box.left : box.right,
    y: corner.startsWith("n") ? box.top : box.bottom,
  };
}
export function canResize(drawing: Drawing): boolean {
  const box = drawingBounds(drawing);
  return box.right > box.left && box.bottom > box.top;
}
/** Keep the opposite corner fixed, prevent flips/collapse, and retain pointer offset. */
export function resizeDrag(
  drawing: Drawing,
  corner: Corner,
  start: Point,
  pointer: Point,
  scale: number,
  snap: boolean,
  grid: GridSettings = DEFAULT_GRID,
): ResizeBounds | null {
  const dx = pointer.x - start.x,
    dy = pointer.y - start.y;
  if (Math.hypot(dx, dy) * scale < 3 || !canResize(drawing)) return null;
  const box = drawingBounds(drawing),
    origin = cornerPoint(box, corner);
  const coordinate = (
    value: number,
    min: number,
    max: number,
    origin: number,
  ): number | null => {
    if (snap) return gridCoordinate(value, origin, min, max, grid.spacing);
    return min > max ? null : Math.max(min, Math.min(max, value));
  };
  const west = corner.endsWith("w"),
    north = corner.startsWith("n");
  const x = coordinate(
      origin.x + dx,
      west ? -10000 : box.left + 1,
      west ? box.right - 1 : 10000,
      grid.origin.x,
    ),
    y = coordinate(
      origin.y + dy,
      north ? -10000 : box.top + 1,
      north ? box.bottom - 1 : 10000,
      grid.origin.y,
    );
  if (x === null || y === null) return null;
  const next = { ...box };
  if (west) next.left = x;
  else next.right = x;
  if (north) next.top = y;
  else next.bottom = y;
  // An existing sub-unit drawing may have no valid resize in this direction.
  if (
    next.left < -10000 ||
    next.top < -10000 ||
    next.right > 10000 ||
    next.bottom > 10000
  )
    return null;
  return next.left === box.left &&
    next.right === box.right &&
    next.top === box.top &&
    next.bottom === box.bottom
    ? null
    : next;
}
