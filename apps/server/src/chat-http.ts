import { chatSendSchema } from "@tableloom/core/chat";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AccessStore, AccessError } from "./access.js";
import { sessionToken } from "./access-http.js";
import { StoreError } from "./store.js";
import { ChatStore } from "./chat.js";
export function registerChatRoutes(
  app: FastifyInstance,
  access: AccessStore,
  chat: ChatStore,
) {
  const actor = (request: FastifyRequest) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member) throw new AccessError("sign_in_required");
    if (
      z.object({ campaignId: z.uuid() }).strict().parse(request.params)
        .campaignId !== member.tableId
    )
      throw new StoreError(
        "Open this campaign before accessing its chat.",
        409,
      );
    z.object({}).strict().parse(request.query);
    return member;
  };
  // Shared across a member's sessions/tabs; bounded map and automatic expiry.
  const rates = new Map<string, { start: number; count: number }>();
  const root = "/api/campaigns/:campaignId/chat";
  app.get(root, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return chat.list(actor(request));
  });
  app.post(root, { bodyLimit: 16 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const member = actor(request),
      now = Date.now();
    for (const [key, value] of rates)
      if (now - value.start >= 10000) rates.delete(key);
    const key = `${member.tableId}:${member.id}`,
      rate = rates.get(key) ?? { start: now, count: 0 };
    if (++rate.count > 20 || (!rates.has(key) && rates.size >= 10000))
      return reply.code(429).send({
        error: "Chat is busy. Wait a few seconds before sending again.",
      });
    rates.set(key, rate);
    const { expectedAuthorId, ...input } = chatSendSchema.parse(request.body);
    if (expectedAuthorId !== member.id)
      throw new StoreError(
        "Your identity changed. Reopen chat before sending.",
        409,
      );
    return chat.send(member, input);
  });
}
