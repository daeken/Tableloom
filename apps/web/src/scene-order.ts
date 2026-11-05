import {
  objectOrderMatches,
  drawingLayerOf,
  drawingLayersOf,
  tokenLayerOf,
  tokenLayersOf,
} from "@tableloom/core";
import type {
  TableView,
  CommandInput,
  DrawingLayer,
  TokenLayer,
  Drawing,
  Token,
} from "@tableloom/core";
import type { SceneObject } from "./scene-selection.js";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
export type SceneOrderReview =
  | {
      kind: "drawing";
      object: Drawing;
      order: string[];
      layers: DrawingLayer[];
    }
  | { kind: "token"; object: Token; order: string[]; layers: TokenLayer[] };
export function captureSceneOrder(
  object: SceneObject,
  state: TableView,
): SceneOrderReview {
  return "position" in object
    ? {
        kind: "token",
        object: structuredClone(object),
        order: state.tokens.map((t) => t.id),
        layers: tokenLayersOf(state.tokens),
      }
    : {
        kind: "drawing",
        object: structuredClone(object),
        order: state.drawings.map((d) => d.id),
        layers: drawingLayersOf(state.drawings),
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
      review.layers,
      review.kind === "token"
        ? tokenLayersOf(state.tokens)
        : drawingLayersOf(state.drawings),
    ) &&
    objectOrderMatches(
      review.order,
      (review.kind === "token" ? state.tokens : state.drawings).map(
        (object) => object.id,
      ),
    )
  );
}
export function sceneOrderIds(review: SceneOrderReview): string[] {
  const layer =
    review.kind === "token"
      ? tokenLayerOf(review.object)
      : drawingLayerOf(review.object);
  return review.order.filter((_, i) => review.layers[i] === layer);
}
export function sceneOrderCommand(
  review: SceneOrderReview,
  state: TableView,
  member: Member | null,
  direction: "front" | "back",
): CommandInput | null {
  const ids = sceneOrderIds(review);
  if (
    !sceneOrderCurrent(review, state, member) ||
    (direction === "front" ? ids.at(-1) : ids[0]) === review.object.id
  )
    return null;
  return review.kind === "token"
    ? {
        type: "token.reorder",
        tokenId: review.object.id,
        expectedVersion: review.object.version,
        expectedOrder: [...review.order],
        expectedLayers: [...review.layers],
        direction,
      }
    : {
        type: "drawing.reorder",
        drawingId: review.object.id,
        expectedVersion: review.object.version,
        expectedOrder: [...review.order],
        expectedLayers: [...review.layers],
        direction,
      };
}
export function sceneLayerCommand(
  review: SceneOrderReview,
  state: TableView,
  member: Member | null,
  layer: DrawingLayer | TokenLayer,
): CommandInput | null {
  if (!sceneOrderCurrent(review, state, member)) return null;
  if (review.kind === "token") {
    if (
      (layer !== "between-drawings" && layer !== "above-drawings") ||
      tokenLayerOf(review.object) === layer
    )
      return null;
    return {
      type: "token.layer.update",
      tokenId: review.object.id,
      expectedVersion: review.object.version,
      expectedOrder: [...review.order],
      expectedLayers: [...review.layers],
      layer,
    };
  }
  if (
    (layer !== "below-tokens" && layer !== "above-tokens") ||
    drawingLayerOf(review.object) === layer
  )
    return null;
  return {
    type: "drawing.layer.update",
    drawingId: review.object.id,
    expectedVersion: review.object.version,
    expectedOrder: [...review.order],
    expectedLayers: [...review.layers],
    layer,
  };
}
export function sceneObjectLayerName(object: SceneObject): string {
  return "position" in object
    ? tokenLayerOf(object) === "above-drawings"
      ? "Above drawings"
      : "Between drawing layers"
    : drawingLayerOf(object) === "above-tokens"
      ? "Above tokens"
      : "Below tokens";
}
export function sceneOrderName(object: SceneObject): string {
  if ("position" in object) return object.name;
  return object.kind === "text"
    ? `Text: ${object.text!.split("\n")[0]!.slice(0, 40)}`
    : object.kind === "rectangle"
      ? "Room drawing"
      : "Freehand stroke";
}
