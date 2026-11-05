import { drawingOrderMatches } from "@tableloom/core";
import type { Drawing, TableView, CommandInput } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
export interface DrawingOrderReview {
  drawing: Drawing;
  order: string[];
}
export function captureDrawingOrder(
  drawing: Drawing,
  state: TableView,
): DrawingOrderReview {
  return {
    drawing: structuredClone(drawing),
    order: state.drawings.map((d) => d.id),
  };
}
export function drawingOrderCurrent(
  review: DrawingOrderReview,
  state: TableView,
  member: Member | null,
): boolean {
  return (
    deletionReviewCurrent(
      captureDeletionReview([review.drawing]),
      state,
      member,
    ) &&
    drawingOrderMatches(
      review.order,
      state.drawings.map((d) => d.id),
    )
  );
}
export function drawingOrderCommand(
  review: DrawingOrderReview,
  state: TableView,
  member: Member | null,
  direction: "front" | "back",
): CommandInput | null {
  if (
    !drawingOrderCurrent(review, state, member) ||
    (direction === "front" ? review.order.at(-1) : review.order[0]) ===
      review.drawing.id
  )
    return null;
  return {
    type: "drawing.reorder",
    drawingId: review.drawing.id,
    expectedVersion: review.drawing.version,
    expectedOrder: [...review.order],
    direction,
  };
}
export function drawingOrderName(drawing: Drawing): string {
  return drawing.kind === "text"
    ? `Text: ${drawing.text!.split("\n")[0]!.slice(0, 40)}`
    : drawing.kind === "rectangle"
      ? "Room drawing"
      : "Freehand stroke";
}
