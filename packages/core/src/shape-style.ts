import { z } from "zod";
import type { Drawing } from "./index.js";
const color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const shapeStyleSchema = z
  .object({
    lineWidth: z.number().finite().min(0.5).max(32),
    fill: z
      .object({ color, opacity: z.number().finite().min(0.01).max(1) })
      .strict()
      .nullable(),
  })
  .strict();
export type ShapeStyle = z.infer<typeof shapeStyleSchema>;
export const shapeContentSchema = z
  .object({ color, shapeStyle: shapeStyleSchema })
  .strict();
/** Null records absence of an override, so an inverse restores exact legacy state. */
export const shapeSnapshotSchema = z
  .object({ color, shapeStyle: shapeStyleSchema.nullable() })
  .strict();
export function shapeStyleOf(
  drawing: Pick<Drawing, "kind" | "color" | "shapeStyle">,
): ShapeStyle {
  if (drawing.kind === "text")
    throw new Error("Text labels do not have shape styles.");
  return (
    drawing.shapeStyle ?? {
      lineWidth: 3,
      fill:
        drawing.kind === "rectangle"
          ? { color: drawing.color, opacity: 0.07 }
          : null,
    }
  );
}
export function sameShapeStyle(a: ShapeStyle, b: ShapeStyle): boolean {
  return (
    a.lineWidth === b.lineWidth &&
    (a.fill === null
      ? b.fill === null
      : b.fill !== null &&
        a.fill.color === b.fill.color &&
        a.fill.opacity === b.fill.opacity)
  );
}
export function shapeSnapshot(drawing: Drawing) {
  return shapeSnapshotSchema.parse({
    color: drawing.color,
    shapeStyle: drawing.shapeStyle ?? null,
  });
}
