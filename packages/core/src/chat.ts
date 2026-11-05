import { z } from "zod";

export const chatAudienceSchema = z.enum(["public", "gm"]);
export const chatInputSchema = z
  .object({
    id: z.uuid(),
    audience: chatAudienceSchema,
    body: z.string().trim().min(1).max(2000),
  })
  .strict();
export const chatSendSchema = chatInputSchema
  .extend({ expectedAuthorId: z.uuid() })
  .strict();
export const chatMessageSchema = chatInputSchema
  .extend({
    authorId: z.uuid(),
    authorName: z.string().trim().min(1).max(32),
    createdAt: z.number().int().nonnegative().max(8640000000000000),
  })
  .strict();
export const chatPageSchema = z
  .object({
    campaignId: z.uuid(),
    viewerId: z.uuid(),
    messages: z.array(chatMessageSchema).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.messages.map((m) => m.id)).size !== value.messages.length)
      ctx.addIssue({
        code: "custom",
        message: "Chat message IDs must be unique.",
      });
  });
export type ChatInput = z.infer<typeof chatInputSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatPage = z.infer<typeof chatPageSchema>;
