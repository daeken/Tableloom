import { drawingSchema, resizeBoundsSchema } from "./index.js";
import type { Drawing, Point, ResizeBounds } from "./index.js";

export function drawingBounds(drawing: Pick<Drawing, "points">): ResizeBounds {
  return {
    left: Math.min(...drawing.points.map((p) => p.x)),
    right: Math.max(...drawing.points.map((p) => p.x)),
    top: Math.min(...drawing.points.map((p) => p.y)),
    bottom: Math.max(...drawing.points.map((p) => p.y)),
  };
}
/** Pure shared preview/validation; the server always transforms its saved geometry. */
export function resizedDrawingPoints(
  drawing: Pick<Drawing, "points">,
  input: ResizeBounds,
): Point[] {
  const box = resizeBoundsSchema.parse(input),
    original = drawingBounds(drawing);
  if (original.left === original.right || original.top === original.bottom)
    throw new Error(
      "Drawings need width and height before they can be resized.",
    );
  if (
    box.left === original.left &&
    box.right === original.right &&
    box.top === original.top &&
    box.bottom === original.bottom
  )
    throw new Error("Change the drawing size before saving.");
  const axis = (
    value: number,
    from: number,
    to: number,
    min: number,
    max: number,
  ) =>
    from === min && to === max
      ? value
      : min + ((value - from) / (to - from)) * (max - min);
  const points = drawing.points.map((p) => ({
    x: axis(p.x, original.left, original.right, box.left, box.right),
    y: axis(p.y, original.top, original.bottom, box.top, box.bottom),
  }));
  return drawingSchema.shape.points.parse(points);
}
