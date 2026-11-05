import { resizeBoundsSchema } from "@tableloom/core";
import type {
  CommandInput,
  Drawing,
  ResizeBounds,
  TableView,
} from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { drawingBounds, resizedDrawingPoints } from "@tableloom/core/geometry";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";

/** Keep the captured upper-left corner fixed; explicit sizes never snap or clamp. */
export function drawingSizeBounds(
  drawing: Drawing,
  width: string,
  height: string,
): ResizeBounds | null {
  if (!width.trim() || !height.trim()) return null;
  const before = drawingBounds(drawing),
    w = Number(width),
    h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const parsed = resizeBoundsSchema.safeParse({
    left: before.left,
    top: before.top,
    right: w === before.right - before.left ? before.right : before.left + w,
    bottom: h === before.bottom - before.top ? before.bottom : before.top + h,
  });
  if (!parsed.success) return null;
  try {
    // Shared authoritative transform rejects no-op/flat geometry and invalid resulting points.
    resizedDrawingPoints(drawing, parsed.data);
    return parsed.data;
  } catch {
    return null;
  }
}
export function drawingSizeCommand(
  drawing: Drawing,
  width: string,
  height: string,
  state: Pick<TableView, "tokens" | "drawings">,
  member: Member | null,
  enabled: boolean,
  pending: boolean,
): CommandInput | null {
  if (
    !enabled ||
    pending ||
    !deletionReviewCurrent(captureDeletionReview([drawing]), state, member)
  )
    return null;
  const bounds = drawingSizeBounds(drawing, width, height);
  return bounds
    ? {
        type: "drawing.resize",
        drawingId: drawing.id,
        expectedVersion: drawing.version,
        bounds,
      }
    : null;
}
