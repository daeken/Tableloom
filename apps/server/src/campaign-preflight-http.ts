import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ServerSystemDefinition } from "@tableloom/module-sdk/server";
import type { InstalledCatalog } from "./store.js";
import { StoreError } from "./store.js";
import type { ContentCatalog } from "./content-catalog.js";
import type { AccessStore } from "./access.js";
import { sessionToken } from "./access-http.js";
import { MAX_CAMPAIGN_EXPORT_BYTES } from "./campaign-export.js";
import { inspectCampaignTransferWithImages } from "./campaign-preflight.js";
import { CampaignImageInspector } from "./campaign-image-inspection.js";

export async function registerCampaignPreflightRoutes(
  app: FastifyInstance,
  options: {
    database: DatabaseSync;
    access: AccessStore;
    catalog: InstalledCatalog;
    contentCatalog: ContentCatalog;
    systems: readonly ServerSystemDefinition<unknown>[];
    imageInspector?: CampaignImageInspector;
  },
) {
  await app.register(async (api) => {
    const imageInspector =
      options.imageInspector ?? new CampaignImageInspector();
    api.addHook("preClose", async () => imageInspector.close());
    api.addHook("onClose", async () => imageInspector.close());
    // Keep the original UTF-8 file bytes for a stable inspection fingerprint and
    // bound the raw body before parsing. This parser is private to this route scope.
    api.removeContentTypeParser("application/json");
    api.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: MAX_CAMPAIGN_EXPORT_BYTES },
      (_request, body, done) => done(null, body),
    );
    const host = (request: FastifyRequest) =>
      options.access.requireServerHost(sessionToken(request.headers.cookie));
    api.post(
      "/api/campaign-imports/preflight",
      {
        bodyLimit: MAX_CAMPAIGN_EXPORT_BYTES,
        onRequest: async (request) => {
          host(request);
          imageInspector.assertAvailable();
        },
      },
      async (request, reply) => {
        host(request);
        z.object({}).strict().parse(request.query);
        if (!Buffer.isBuffer(request.body))
          throw new StoreError("Send a campaign JSON file.", 400);
        const serialized = request.body.toString("utf8");
        if (!Buffer.from(serialized).equals(request.body))
          throw new StoreError("Campaign files must use valid UTF-8.", 400);
        const abort = new AbortController(),
          cancel = () => abort.abort();
        reply.raw.once("close", cancel);
        try {
          const report = await inspectCampaignTransferWithImages(
            serialized,
            options.catalog,
            options.contentCatalog,
            options.systems,
            options.database,
            imageInspector,
            abort.signal,
          );
          host(request); // A session/membership can be revoked during worker execution.
          return report;
        } finally {
          reply.raw.removeListener("close", cancel);
        }
      },
    );
  });
}
