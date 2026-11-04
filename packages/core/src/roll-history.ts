import { z } from "zod";
import { rollSchema } from "./index.js";

export const MAX_ARCHIVED_ROLLS = 10000;
export const rollSelectionSchema = z
  .object({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each roll once.",
      ),
  })
  .strict();
export const archivedRollSchema = z
  .object({ roll: rollSchema, archivedAt: z.iso.datetime() })
  .strict();
export const rollArchivePageSchema = z
  .object({
    entries: z.array(archivedRollSchema).max(50),
    next: z.uuid().nullable(),
  })
  .strict();
export const rollHistoryResultSchema = z
  .object({ affected: z.number().int().min(1).max(100) })
  .strict();
