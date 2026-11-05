import { z } from "zod";
import {
  backgroundMapSchema,
  backgroundHistorySchema,
  backgroundHistoryActionSchema,
} from "@tableloom/core/scene-map";
import { MAX_SCENE_MAP_HISTORY } from "./storage-limits.js";

type Map = z.infer<typeof backgroundMapSchema> | null;
export type MapRecord = { version: number; map: Map; cursor: number };
export const backgroundHistoryEntrySchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().positive(),
    action: backgroundHistoryActionSchema,
    before: backgroundMapSchema.nullable(),
    after: backgroundMapSchema.nullable(),
  })
  .strict();
export type MapHistoryEntry = z.infer<typeof backgroundHistoryEntrySchema>;

// Image keys are access capabilities; undo/redo rotates them rather than restoring old keys.
function sameMap(a: Map, b: Map) {
  const value = (m: Map) =>
    m && {
      assetId: m.assetId,
      position: m.position,
      width: m.width,
      height: m.height,
      visibility: m.visibility,
    };
  return JSON.stringify(value(a)) === JSON.stringify(value(b));
}

/** Callers validate row schemas, metadata and asset references first. No writes or key restoration. */
export function inspectSceneMapHistory(
  state: MapRecord,
  entries: readonly MapHistoryEntry[],
) {
  z.number().int().nonnegative().parse(state.version);
  z.number().int().nonnegative().parse(state.cursor);
  const ids = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.seq > state.version || sameMap(entry.before, entry.after))
      throw new Error("Stored background history entry is inconsistent.");
    if (ids.has(entry.id) || (i > 0 && entries[i - 1]!.seq >= entry.seq))
      throw new Error(
        "Stored background history entry ordering is inconsistent.",
      );
    ids.add(entry.id);
  }
  if (
    entries.length > MAX_SCENE_MAP_HISTORY ||
    (state.cursor !== 0 && !entries.some((entry) => entry.seq === state.cursor))
  )
    throw new Error("Stored background history cursor is inconsistent.");
  for (let i = 1; i < entries.length; i++) {
    if (!sameMap(entries[i - 1]!.after, entries[i]!.before))
      throw new Error("Stored background history chain is inconsistent.");
  }
  const undo =
      entries.filter((entry) => entry.seq <= state.cursor).at(-1) ?? null,
    redo = entries.find((entry) => entry.seq > state.cursor) ?? null;
  if (
    (undo && !sameMap(state.map, undo.after)) ||
    (redo && !sameMap(state.map, redo.before))
  )
    throw new Error("Stored background history does not match the scene.");
  const summary = (edge: typeof undo, direction: "before" | "after") =>
    edge && {
      id: edge.id,
      action: edge.action,
      restores: edge[direction]?.visibility ?? "none",
    };
  return {
    entries,
    undo,
    redo,
    summary: backgroundHistorySchema.parse({
      undo: summary(undo, "before"),
      redo: summary(redo, "after"),
      count: entries.length,
    }),
  };
}
