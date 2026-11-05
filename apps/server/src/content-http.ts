import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  contentReferenceSchema,
  contentOverrideSchema,
  contentResetSchema,
  contentCursorSchema,
} from "@tableloom/core/content";
import { AccessStore, AccessError } from "./access.js";
import { sessionToken } from "./access-http.js";
import { StoreError } from "./store.js";
import { CampaignContentStore } from "./content.js";

export function registerContentRoutes(
  app: FastifyInstance,
  access: AccessStore,
  content: CampaignContentStore,
) {
  const params = z
    .object({
      campaignId: z.uuid(),
      packId: z.string().optional(),
      packVersion: z.string().optional(),
      definitionId: z.string().optional(),
    })
    .strict();
  const actor = (request: FastifyRequest) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member) throw new AccessError("sign_in_required");
    if (params.parse(request.params).campaignId !== member.tableId)
      throw new StoreError(
        "Your active campaign changed. Open it before accessing content.",
        409,
      );
    return member;
  };
  const ref = (request: FastifyRequest) => {
    const { packId, packVersion, definitionId } = params.parse(request.params);
    return contentReferenceSchema.parse({ packId, packVersion, definitionId });
  };
  const root = "/api/campaigns/:campaignId/content",
    item = `${root}/:packId/:packVersion/:definitionId`;
  app.get("/api/campaigns/:campaignId/content-packs", async (request) =>
    content.packs(actor(request)),
  );
  app.get(root, async (request) => {
    const member = actor(request),
      query = z
        .object({
          after: contentCursorSchema.optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .strict()
        .parse(request.query);
    return content.list(member, {
      ...(query.after ? { after: query.after } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });
  app.get(item, async (request) => content.get(actor(request), ref(request)));
  app.post(`${item}/override`, async (request) =>
    content.override(
      actor(request),
      ref(request),
      contentOverrideSchema.parse(request.body),
    ),
  );
  app.post(`${item}/reset`, async (request) =>
    content.reset(
      actor(request),
      ref(request),
      contentResetSchema.parse(request.body),
    ),
  );
}
