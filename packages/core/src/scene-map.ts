import { z } from "zod";
import { commandContextSchema } from "./campaigns.js";
const position = z
  .object({
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
  })
  .strict();
const backgroundBase = z
  .object({
    assetId: z.uuid(),
    imageId: z.uuid(),
    position,
    width: z.number().finite().min(1).max(20000),
    height: z.number().finite().min(1).max(20000),
    visibility: z.enum(["gm", "public"]),
  })
  .strict();
const withinWorld = (map: {
  position: { x: number; y: number };
  width: number;
  height: number;
}) =>
  map.position.x + map.width <= 10000 && map.position.y + map.height <= 10000;
export const backgroundMapSchema = backgroundBase.refine(
  withinWorld,
  "The whole map must fit within the world bounds.",
);
export const backgroundViewSchema = backgroundBase
  .omit({ assetId: true })
  .refine(withinWorld);
export type BackgroundView = z.infer<typeof backgroundViewSchema>;
export const backgroundHistoryActionSchema = z.enum([
  "set",
  "visibility",
  "remove",
]);
export const backgroundHistoryEdgeSchema = z
  .object({
    id: z.uuid(),
    action: backgroundHistoryActionSchema,
    restores: z.enum(["none", "gm", "public"]),
  })
  .strict();
export const backgroundHistorySchema = z
  .object({
    undo: backgroundHistoryEdgeSchema.nullable(),
    redo: backgroundHistoryEdgeSchema.nullable(),
    count: z.number().int().min(0).max(100),
  })
  .strict();
export const backgroundStateSchema = z
  .object({
    context: commandContextSchema,
    version: z.number().int().nonnegative(),
    map: backgroundMapSchema.nullable(),
    history: backgroundHistorySchema,
  })
  .strict();
export type BackgroundState = z.infer<typeof backgroundStateSchema>;
const version = {
  context: commandContextSchema,
  expectedVersion: z.number().int().nonnegative(),
};
export const backgroundSetSchema = z
  .object({
    ...version,
    assetId: z.uuid(),
    position,
    width: z.number().finite().min(1).max(20000),
  })
  .strict();
export const backgroundVisibilitySchema = z
  .object({
    ...version,
    visibility: z.enum(["gm", "public"]),
    acknowledgeReveal: z.literal(true).optional(),
  })
  .strict();
export const backgroundRemoveSchema = z.object(version).strict();

export const backgroundTravelSchema = z
  .object({
    ...version,
    entryId: z.uuid(),
    acknowledgeReveal: z.literal(true).optional(),
  })
  .strict();
export const backgroundClearHistorySchema = z
  .object({
    ...version,
    acknowledgeClear: z.literal(true),
  })
  .strict();
