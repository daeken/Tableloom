import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sessionToken } from "./access-http.js";
import { AccessStore, AccessError } from "./access.js";
import { StoreError } from "./store.js";
import { RollHistoryStore } from "./roll-history.js";

export function registerRollHistoryRoutes(
  app: FastifyInstance,
  access: AccessStore,
  history: RollHistoryStore,
  refresh: (campaignId: string) => void,
) {
  const actor = (request: FastifyRequest) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member) throw new AccessError("sign_in_required");
    const { campaignId } = z
      .object({ campaignId: z.uuid() })
      .strict()
      .parse(request.params);
    if (campaignId !== member.tableId)
      throw new StoreError(
        "Your active campaign changed. Open it before managing history.",
        409,
      );
    return member;
  };
  const root = "/api/campaigns/:campaignId/rolls";
  app.get(`${root}/archive`, async (request) => {
    const member = actor(request);
    const query = z
      .object({
        after: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .strict()
      .parse(request.query);
    return history.list(member, {
      ...(query.after ? { after: query.after } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });
  for (const [path, action, source] of [
    ["archive", "archive", "live"],
    ["delete", "delete", "live"],
    ["archive/delete", "delete", "archive"],
  ] as const) {
    app.post(`${root}/${path}`, async (request) => {
      const member = actor(request),
        result = history.change(member, request.body, action, source);
      if (source === "live") refresh(member.tableId); // Only committed, recipient-filtered snapshots.
      return result;
    });
  }
}
