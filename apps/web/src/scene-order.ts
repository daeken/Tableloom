import {
  objectOrderMatches,
  drawingLayerOf,
  drawingLayersOf,
} from "@tableloom/core";
import type { TableView, CommandInput, DrawingLayer } from "@tableloom/core";
import type { SceneObject } from "./scene-selection.js";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
export interface SceneOrderReview {
  object: SceneObject;
  order: string[];
  layers?: DrawingLayer[];
}
export function captureSceneOrder(
  object: SceneObject,
  state: TableView,
): SceneOrderReview {
  return {
    object: structuredClone(object),
    ...("points" in object ? { layers: drawingLayersOf(state.drawings) } : {}),
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
    (!review.layers ||
      objectOrderMatches(review.layers, drawingLayersOf(state.drawings))) &&
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
    (direction === "front"
      ? sceneOrderIds(review).at(-1)
      : sceneOrderIds(review)[0]) === review.object.id
  )
    return null;
  return {
    ...("position" in review.object
      ? { type: "token.reorder" as const, tokenId: review.object.id }
      : {
          type: "drawing.reorder" as const,
          drawingId: review.object.id,
          expectedLayers: [...review.layers!],
        }),
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

export function sceneOrderIds(review: SceneOrderReview): string[] {
  if ("position" in review.object) return review.order;
  const layer = drawingLayerOf(review.object);
  return review.order.filter((_, i) => review.layers?.[i] === layer);
}
export function sceneLayerCommand(
  review: SceneOrderReview,
  state: TableView,
  member: Member | null,
  layer: DrawingLayer,
): CommandInput | null {
  if (
    !("points" in review.object) ||
    !sceneOrderCurrent(review, state, member) ||
    drawingLayerOf(review.object) === layer
  )
    return null;
  return {
    type: "drawing.layer.update",
    drawingId: review.object.id,
    expectedVersion: review.object.version,
    expectedOrder: [...review.order],
    expectedLayers: [...review.layers!],
    layer,
  };
}
