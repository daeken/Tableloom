import {
  translationSchema,
  type CommandInput,
  type TableView,
} from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";
import {
  captureDeletionReview,
  deletionReviewCurrent,
  selectionDelta,
  type SceneObject,
} from "./scene-selection.js";

export function sceneObjectLabel(object: SceneObject): string {
  return "position" in object
    ? `Token: ${object.name}`
    : object.kind === "text"
      ? `Text: ${(object.text ?? "").slice(0, 60)}`
      : object.kind === "rectangle"
        ? "Room drawing"
        : "Freehand drawing";
}
export function keyboardObjectChoices(
  state: Pick<TableView, "tokens" | "drawings">,
  member: Member | null,
  search: string,
) {
  const query = search.trim().toLowerCase();
  return [...state.tokens, ...state.drawings].filter(
    (object) =>
      canEditObject(member, object) &&
      `${sceneObjectLabel(object)} ${"points" in object ? (object.text ?? "") : ""} ${object.id}`
        .toLowerCase()
        .includes(query),
  );
}
/** Resolve the whole local selection; never silently omit missing or unauthorized IDs. */
export function keyboardSelection(
  ids: readonly string[],
  state: Pick<TableView, "tokens" | "drawings">,
  member: Member | null,
): SceneObject[] | null {
  if (ids.length > 100 || new Set(ids).size !== ids.length) return null;
  const objects = new Map(
    [...state.tokens, ...state.drawings].map((object) => [object.id, object]),
  );
  const result: SceneObject[] = [];
  for (const id of ids) {
    const object = objects.get(id);
    if (!object || !canEditObject(member, object)) return null;
    result.push(object);
  }
  return result;
}
export type NudgeDirection = "left" | "right" | "up" | "down";
export function keyboardMoveCommand(
  objects: SceneObject[],
  state: Pick<TableView, "tokens" | "drawings">,
  member: Member | null,
  direction: NudgeDirection,
  distance: number,
  enabled: boolean,
  pending: boolean,
): CommandInput | null {
  if (
    !enabled ||
    pending ||
    !Number.isFinite(distance) ||
    distance <= 0 ||
    distance > 5000 ||
    !deletionReviewCurrent(captureDeletionReview(objects), state, member)
  )
    return null;
  const deltas = {
    left: { x: -distance, y: 0 },
    right: { x: distance, y: 0 },
    up: { x: 0, y: -distance },
    down: { x: 0, y: distance },
  };
  const delta = selectionDelta(objects, deltas[direction]);
  if (!translationSchema.safeParse(delta).success) return null;
  return {
    type: "objects.move",
    objects: objects.map((object) => ({
      objectId: object.id,
      expectedVersion: object.version,
    })),
    delta,
  };
}
