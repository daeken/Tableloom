import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_ASSET_BYTES, assetNameSchema } from "@tableloom/core/assets";
import { AccessStore, AccessError } from "./access.js";
import { sessionToken } from "./access-http.js";
import { AssetStore } from "./assets.js";
import { StoreError } from "./store.js";
export async function registerAssetRoutes(
  app: FastifyInstance,
  access: AccessStore,
  assets: AssetStore,
) {
  await app.register(async (api) => {
    const paramsSchema = z
      .object({ campaignId: z.uuid(), id: z.uuid().optional() })
      .strict();
    const actor = (request: FastifyRequest) => {
      const member = access.authenticate(sessionToken(request.headers.cookie));
      if (!member) throw new AccessError("sign_in_required");
      const params = paramsSchema.parse(request.params);
      if (member.tableId !== params.campaignId)
        throw new StoreError(
          "Open this campaign before accessing its assets.",
          409,
        );
      return member;
    };
    const id = (request: FastifyRequest) =>
      z.uuid().parse(paramsSchema.parse(request.params).id);
    const root = "/api/campaigns/:campaignId/assets";
    api.addContentTypeParser(
      "image/png",
      { parseAs: "buffer", bodyLimit: MAX_ASSET_BYTES },
      (_request, body, done) => done(null, body),
    );
    api.get(root, async (request) => {
      const query = z
        .object({
          after: z.uuid().optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .strict()
        .parse(request.query);
      return assets.list(actor(request), query.after, query.limit);
    });
    api.post(
      root,
      {
        bodyLimit: MAX_ASSET_BYTES,
        onRequest: async (request) => {
          const member = actor(request);
          if (member.role !== "gm")
            throw new StoreError(
              "Only campaign GMs can upload private assets.",
              403,
            );
        },
      },
      async (request, reply) => {
        const member = actor(request),
          query = z
            .object({ name: assetNameSchema })
            .strict()
            .parse(request.query);
        if (
          request.headers["content-type"] !== "image/png" ||
          !Buffer.isBuffer(request.body)
        )
          throw new StoreError("Upload a PNG image.", 400);
        return reply
          .code(201)
          .send(assets.upload(member, query.name, request.body));
      },
    );
    api.get(`${root}/:id/content`, async (request, reply) => {
      const result = assets.content(actor(request), id(request));
      return reply
        .type("image/png")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Disposition",
          `inline; filename="${result.asset.id}.png"`,
        )
        .header("Content-Security-Policy", "default-src 'none'; sandbox")
        .send(result.bytes);
    });
    api.post(`${root}/:id/delete`, async (request) => {
      z.object({}).strict().parse(request.body);
      assets.delete(actor(request), id(request));
      return { ok: true };
    });
  });
}
