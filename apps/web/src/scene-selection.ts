import { MAX_SCENE_MOVE_OBJECTS } from "@tableloom/core";
import type { Point, Token, Drawing } from "@tableloom/core";
export type SceneObject = Token | Drawing;
type GeometryObject = { position: Point } | { points: Point[] };
export const objectPoints = (object: GeometryObject): Point[] =>
  "position" in object ? [object.position] : object.points;
export function objectBounds(object: GeometryObject) {
  const points = objectPoints(object);
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}
/** Clamp one translation for every point, retaining rigid shapes and relative spacing. */
export function selectionDelta(
  objects: readonly SceneObject[],
  delta: Point,
): Point {
  if (!objects.length) return { x: 0, y: 0 };
  const bounds = objects.map(objectBounds);
  return {
    x: Math.max(
      -10000 - Math.min(...bounds.map((box) => box.left)),
      Math.min(delta.x, 10000 - Math.max(...bounds.map((box) => box.right))),
    ),
    y: Math.max(
      -10000 - Math.min(...bounds.map((box) => box.top)),
      Math.min(delta.y, 10000 - Math.max(...bounds.map((box) => box.bottom))),
    ),
  };
}
export function translateObject(
  object: SceneObject,
  delta: Point,
): SceneObject {
  const point = (point: Point) => ({
    x: point.x + delta.x,
    y: point.y + delta.y,
  });
  return "position" in object
    ? { ...object, position: point(object.position) }
    : { ...object, points: object.points.map(point) };
}
function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x,
    dy = end.y - start.y,
    length = dx * dx + dy * dy;
  const fraction = length
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / length,
        ),
      )
    : 0;
  return Math.hypot(
    point.x - start.x - fraction * dx,
    point.y - start.y - fraction * dy,
  );
}
/** Room interiors stay available for box selection; strokes hit between sampled points. */
export function hitDrawing(
  drawing: Drawing,
  point: Point,
  tolerance: number,
): boolean {
  let points = drawing.points;
  if (drawing.kind === "rectangle") {
    const first = points[0]!,
      last = points.at(-1)!;
    points = [
      first,
      { x: last.x, y: first.y },
      last,
      { x: first.x, y: last.y },
      first,
    ];
  }
  return points
    .slice(1)
    .some(
      (end, index) => segmentDistance(point, points[index]!, end) <= tolerance,
    );
}
export function objectsInBox(
  objects: readonly SceneObject[],
  start: Point,
  end: Point,
): string[] {
  const left = Math.min(start.x, end.x),
    right = Math.max(start.x, end.x),
    top = Math.min(start.y, end.y),
    bottom = Math.max(start.y, end.y);
  return objects
    .filter((object) => {
      const box = objectBounds(object);
      return (
        box.left >= left &&
        box.right <= right &&
        box.top >= top &&
        box.bottom <= bottom
      );
    })
    .map((object) => object.id);
}
export function selectObjects(
  base: readonly string[],
  added: readonly string[],
): string[] | null {
  const ids = [...new Set([...base, ...added])];
  return ids.length <= MAX_SCENE_MOVE_OBJECTS ? ids : null;
}
