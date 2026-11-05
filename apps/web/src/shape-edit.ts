import {
  shapeContentSchema,
  shapeStyleOf,
  sameShapeStyle,
} from "@tableloom/core";
import type { CommandInput, Drawing, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
/** Shift the validated 0.01–1 decimal representation without multiplying binary floats. */
export function fillOpacityPercent(opacity: number): string {
  const [whole, fraction = ""] = String(opacity).split("."),
    digits = whole! + fraction.padEnd(2, "0"),
    split = whole!.length + 2,
    integer = String(Number(digits.slice(0, split))),
    remainder = digits.slice(split);
  return remainder ? `${integer}.${remainder}` : integer;
}
export function shapeEditCommand(
  captured: Drawing,
  state: TableView,
  member: Member | null,
  color: string,
  lineWidth: string,
  filled: boolean,
  fillColor: string,
  opacity: string,
): CommandInput | null {
  if (
    captured.kind === "text" ||
    (captured.kind === "stroke" && filled) ||
    !deletionReviewCurrent(captureDeletionReview([captured]), state, member)
  )
    return null;
  const original = shapeStyleOf(captured);
  const changes = shapeContentSchema.safeParse({
    color,
    shapeStyle: {
      lineWidth: Number(lineWidth),
      fill: filled
        ? {
            color: fillColor,
            opacity:
              original.fill &&
              opacity === fillOpacityPercent(original.fill.opacity)
                ? original.fill.opacity
                : Number(opacity) / 100,
          }
        : null,
    },
  });
  if (
    !changes.success ||
    (color === captured.color &&
      sameShapeStyle(changes.data.shapeStyle, original))
  )
    return null;
  return {
    type: "drawing.style.update",
    drawingId: captured.id,
    expectedVersion: captured.version,
    changes: changes.data,
  };
}
