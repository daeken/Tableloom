import { pointSchema, translationSchema } from "@tableloom/core";
import type { CommandInput, Point, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
  objectBounds,
  selectionDelta,
  type SceneObject,
} from "./scene-selection.js";

/** Movement uses token centers and drawing points, consistently with server bounds. */
export function selectionPosition(
  objects: readonly SceneObject[],
): Point | null {
  if (!objects.length) return null;
  const boxes = objects.map(objectBounds);
  return {
    x: Math.min(...boxes.map((box) => box.left)),
    y: Math.min(...boxes.map((box) => box.top)),
  };
}

/** Frozen versions prevent a remote edit from retargeting an open coordinate draft. */
export function selectionPositionCommand(
  objects: readonly SceneObject[],
  x: string,
  y: string,
  state: Pick<TableView, "tokens" | "drawings">,
  member: Member | null,
  enabled: boolean,
  pending: boolean,
): CommandInput | null {
  if (
    !enabled ||
    pending ||
    !x.trim() ||
    !y.trim() ||
    !deletionReviewCurrent(captureDeletionReview(objects), state, member)
  )
    return null;
  const anchor = selectionPosition(objects),
    target = pointSchema.safeParse({ x: Number(x), y: Number(y) });
  if (!anchor || !target.success) return null;
  const delta = { x: target.data.x - anchor.x, y: target.data.y - anchor.y };
  if (!translationSchema.safeParse(delta).success) return null;
  const bounded = selectionDelta(objects, delta);
  // Reject overflow; explicit coordinates must never silently become a different position.
  if (bounded.x !== delta.x || bounded.y !== delta.y) return null;
  return {
    type: "objects.move",
    objects: objects.map((object) => ({
      objectId: object.id,
      expectedVersion: object.version,
    })),
    delta,
  };
}
