import { sceneTextContentSchema } from "@tableloom/core";
import type { CommandInput, Drawing, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
/** A draft always targets the captured version, even after unrelated snapshots. */
export function textEditCommand(
  captured: Drawing,
  state: TableView,
  member: Member | null,
  text: string,
  color: string,
): CommandInput | null {
  const changes = sceneTextContentSchema.safeParse({ text, color });
  if (
    captured.kind !== "text" ||
    !changes.success ||
    !deletionReviewCurrent(captureDeletionReview([captured]), state, member) ||
    (text === captured.text && color === captured.color)
  )
    return null;
  return {
    type: "drawing.text.update",
    drawingId: captured.id,
    expectedVersion: captured.version,
    changes: changes.data,
  };
}
