import { sceneTextContentSchema, sameTextStyle } from "@tableloom/core";
import type {
  CommandInput,
  Drawing,
  TableView,
  SceneTextStyle,
} from "@tableloom/core";
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
  textStyle?: SceneTextStyle,
): CommandInput | null {
  const changes = sceneTextContentSchema.safeParse({
    text,
    color,
    ...(textStyle ? { textStyle } : {}),
  });
  if (
    captured.kind !== "text" ||
    !changes.success ||
    !deletionReviewCurrent(captureDeletionReview([captured]), state, member) ||
    (text === captured.text &&
      color === captured.color &&
      (!textStyle || sameTextStyle(textStyle, captured.textStyle!)))
  )
    return null;
  return {
    type: "drawing.text.update",
    drawingId: captured.id,
    expectedVersion: captured.version,
    changes: changes.data,
  };
}
