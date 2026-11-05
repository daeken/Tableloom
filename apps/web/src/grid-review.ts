import {
  gridUpdateSchema,
  sameGrid,
  type SceneGrid,
} from "@tableloom/core/scene-grid";
import { contextKey, type CommandContext } from "@tableloom/core/campaigns";
import type { Member } from "@tableloom/core/access";
export interface GridReview {
  context: CommandContext;
  grid: SceneGrid;
}
export function gridReviewCurrent(
  review: GridReview,
  current: CommandContext,
  grid: SceneGrid,
  member: Member | null,
) {
  return (
    member?.role === "gm" &&
    member.tableId === current.campaignId &&
    contextKey(review.context) === contextKey(current) &&
    review.grid.version === grid.version &&
    sameGrid(review.grid.settings, grid.settings)
  );
}
export function gridDraft(
  review: GridReview,
  spacing: string,
  x: string,
  y: string,
  visible: boolean,
) {
  if ([spacing, x, y].some((value) => !value.trim())) return null;
  const result = gridUpdateSchema.safeParse({
    context: review.context,
    expectedVersion: review.grid.version,
    settings: {
      spacing: Number(spacing),
      origin: { x: Number(x), y: Number(y) },
      visible,
    },
  });
  return result.success && !sameGrid(result.data.settings, review.grid.settings)
    ? result.data
    : null;
}
