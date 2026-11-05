import {
  drawingSchema,
  resizeBoundsSchema,
  groupScaleSchema,
  pointSchema,
  tokenRadiusSchema,
} from "./index.js";
import type { Drawing, Point, ResizeBounds, Token } from "./index.js";

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

export type SceneObject = Token | Drawing;
/** Only group scaling uses token footprints; ordinary movement keeps center anchors. */
export function groupBounds(objects: readonly SceneObject[]): ResizeBounds {
  if (!objects.length) throw new Error("Choose objects to resize.");
  const boxes = objects.map((object) =>
    "position" in object
      ? {
          left: object.position.x - object.radius,
          right: object.position.x + object.radius,
          top: object.position.y - object.radius,
          bottom: object.position.y + object.radius,
        }
      : drawingBounds(object),
  );
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    right: Math.max(...boxes.map((b) => b.right)),
    top: Math.min(...boxes.map((b) => b.top)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}
/** Uniform scale about a server-chosen center, preserving circular tokens and shape proportions. */
export function resizedObjects(
  objects: readonly SceneObject[],
  input: number,
): SceneObject[] {
  const scale = groupScaleSchema.parse(input);
  if (
    objects.length < 2 ||
    objects.length > 100 ||
    new Set(objects.map((o) => o.id)).size !== objects.length
  )
    throw new Error("Choose 2–100 distinct objects to resize.");
  const box = groupBounds(objects),
    center = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  const point = (p: Point) =>
    pointSchema.parse({
      x: center.x + (p.x - center.x) * scale,
      y: center.y + (p.y - center.y) * scale,
    });
  const result = objects.map((object) =>
    "position" in object
      ? {
          ...object,
          position: point(object.position),
          radius: tokenRadiusSchema.parse(object.radius * scale),
        }
      : {
          ...object,
          points: drawingSchema.shape.points.parse(object.points.map(point)),
        },
  );
  if (
    result.every((object, i) => {
      const before = objects[i]!;
      return "position" in object && "position" in before
        ? object.radius === before.radius &&
            object.position.x === before.position.x &&
            object.position.y === before.position.y
        : "points" in object &&
            "points" in before &&
            object.points.every(
              (p, n) =>
                p.x === before.points[n]!.x && p.y === before.points[n]!.y,
            );
    })
  )
    throw new Error("This scale would not change the selection.");
  return result;
}
