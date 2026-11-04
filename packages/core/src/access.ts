import { z } from "zod";

export const memberSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(32),
  tableId: z.literal("main"),
  role: z.enum(["gm", "player"]),
});
export type Member = z.infer<typeof memberSchema>;
export const accessStatusSchema = z.object({
  setupRequired: z.boolean(),
  member: memberSchema.nullable(),
});
export type AccessStatus = z.infer<typeof accessStatusSchema>;
export const invitationSchema = z.object({
  id: z.uuid(),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(),
  tableId: z.literal("main"),
});
// Management responses contain identifiers, never reusable bearer credentials.
export const invitationSummarySchema = invitationSchema
  .omit({ token: true })
  .extend({
    memberId: z.uuid().nullable(),
  });
export const membersSchema = z.array(memberSchema).max(1000);
export const invitationsSchema = z.array(invitationSummarySchema).max(100);
