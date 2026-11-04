import { z } from "zod";
export const sceneHistoryEntrySchema = z
  .object({
    id: z.uuid(),
    version: z.number().int().positive(),
    objectId: z.uuid(),
    action: z.enum(["move", "create", "delete"]),
    objectType: z.enum(["token", "drawing"]),
    name: z.string().min(1).max(32),
    available: z.boolean(),
  })
  .strict();
export const sceneHistorySchema = z
  .object({
    undo: sceneHistoryEntrySchema.nullable(),
    redo: sceneHistoryEntrySchema.nullable(),
  })
  .strict();
export type SceneHistory = z.infer<typeof sceneHistorySchema>;
