import { objectOrderMatches } from "@tableloom/core";
import type { TableView, CommandInput } from "@tableloom/core";
import type { SceneObject } from "./scene-selection.js";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
export interface SceneOrderReview {
  object: SceneObject;
  order: string[];
}
export function captureSceneOrder(
  object: SceneObject,
  state: TableView,
): SceneOrderReview {
  return {
    object: structuredClone(object),
    order: ("position" in object ? state.tokens : state.drawings).map(
      (d) => d.id,
    ),
  };
}
export function sceneOrderCurrent(
  review: SceneOrderReview,
  state: TableView,
  member: Member | null,
): boolean {
  return (
    deletionReviewCurrent(
      captureDeletionReview([review.object]),
      state,
      member,
    ) &&
    objectOrderMatches(
      review.order,
      ("position" in review.object ? state.tokens : state.drawings).map(
        (d) => d.id,
      ),
    )
  );
}
export function sceneOrderCommand(
  review: SceneOrderReview,
  state: TableView,
  member: Member | null,
  direction: "front" | "back",
): CommandInput | null {
  if (
    !sceneOrderCurrent(review, state, member) ||
    (direction === "front" ? review.order.at(-1) : review.order[0]) ===
      review.object.id
  )
    return null;
  return {
    ...("position" in review.object
      ? { type: "token.reorder" as const, tokenId: review.object.id }
      : { type: "drawing.reorder" as const, drawingId: review.object.id }),
    expectedVersion: review.object.version,
    expectedOrder: [...review.order],
    direction,
  };
}
export function sceneOrderName(object: SceneObject): string {
  if ("position" in object) return object.name;
  return object.kind === "text"
    ? `Text: ${object.text!.split("\n")[0]!.slice(0, 40)}`
    : object.kind === "rectangle"
      ? "Room drawing"
      : "Freehand stroke";
}
