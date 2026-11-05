import { z } from "zod";
/** Public connected identity only. No credential, session, scene or activity fields. */
export const onlineMemberSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(32),
    role: z.enum(["gm", "player"]),
  })
  .strict();
export type OnlineMember = z.infer<typeof onlineMemberSchema>;
export const presenceDataSchema = z
  .object({
    participants: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    onlineMembers: z.array(onlineMemberSchema).max(1000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.onlineMembers.map((member) => member.id)).size !==
      value.onlineMembers.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["onlineMembers"],
        message: "Connected identities must be unique.",
      });
    if (
      value.participants < value.onlineMembers.length ||
      (value.participants > 0 && value.onlineMembers.length === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Connection and member counts disagree.",
      });
  });
export type PresenceData = z.infer<typeof presenceDataSchema>;
