import { z } from "zod";
import { commandContextSchema } from "./campaigns.js";

export const gridSettingsSchema = z
  .object({
    spacing: z.number().finite().min(10).max(500),
    origin: z
      .object({
        x: z.number().finite().min(-10000).max(10000),
        y: z.number().finite().min(-10000).max(10000),
      })
      .strict(),
    visible: z.boolean(),
  })
  .strict();
export type GridSettings = z.infer<typeof gridSettingsSchema>;
/** Historical rendering/snapping defaults, also used by scenes with no override. */
export const DEFAULT_GRID: Readonly<GridSettings> = Object.freeze({
  spacing: 60,
  origin: Object.freeze({ x: 0, y: 0 }),
  visible: true,
});
export const sceneGridSchema = z
  .object({
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    settings: gridSettingsSchema,
  })
  .strict();
export type SceneGrid = z.infer<typeof sceneGridSchema>;
export const gridStateSchema = sceneGridSchema
  .extend({ context: commandContextSchema })
  .strict();
export const gridUpdateSchema = z
  .object({
    context: commandContextSchema,
    expectedVersion: sceneGridSchema.shape.version,
    settings: gridSettingsSchema,
  })
  .strict();
export function sameGrid(a: GridSettings, b: GridSettings): boolean {
  return (
    a.spacing === b.spacing &&
    a.origin.x === b.origin.x &&
    a.origin.y === b.origin.y &&
    a.visible === b.visible
  );
}
