import { z } from "zod";
import { commandContextSchema } from "./campaigns.js";
const cursorPoint = z
  .object({
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
  })
  .strict();
export const cursorUpdateSchema = z
  .object({
    type: z.literal("cursor.update"),
    context: commandContextSchema,
    position: cursorPoint.nullable(),
    renewOnly: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) => !value.renewOnly || value.position !== null,
    "Only a visible owned cursor can be renewed.",
  );
export const cursorSchema = z
  .object({ memberId: z.uuid(), position: cursorPoint })
  .strict();
export const cursorsMessageSchema = z
  .object({
    type: z.literal("cursors"),
    context: commandContextSchema,
    cursors: z.array(cursorSchema).max(1000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.cursors.map((c) => c.memberId)).size !==
      value.cursors.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Cursor identities must be unique.",
      });
  });
export type ParticipantCursor = z.infer<typeof cursorSchema>;
export type CursorPosition = z.infer<typeof cursorPoint> | null;
export const CURSOR_INTERVAL_MS = 100;
export const CURSOR_TTL_MS = 3000;
