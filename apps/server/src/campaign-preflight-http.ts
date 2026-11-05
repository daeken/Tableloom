import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  importPeopleQuerySchema,
  importPeoplePageSchema,
} from "@tableloom/core/campaign-transfer";
import { destinationSnapshot } from "./database.js";
import type { ServerSystemDefinition } from "@tableloom/module-sdk/server";
import type { InstalledCatalog } from "./store.js";
import { StoreError } from "./store.js";
import type { ContentCatalog } from "./content-catalog.js";
import type { AccessStore } from "./access.js";
import { sessionToken } from "./access-http.js";
import { MAX_CAMPAIGN_EXPORT_BYTES } from "./campaign-export.js";
import { inspectCampaignTransferWithImages } from "./campaign-preflight.js";
import { CampaignImageInspector } from "./campaign-image-inspection.js";
import {
  MAX_OWNERSHIP_REVIEW_BYTES,
  parseOwnershipReviewEnvelope,
  parsePreparationEnvelope,
  parseImportEnvelope,
  reviewCampaignOwnership,
} from "./campaign-ownership-plan.js";
import { prepareCampaignCandidate } from "./campaign-prepare.js";
import type { CampaignImportStore } from "./campaign-import.js";

export async function registerCampaignPreflightRoutes(
  app: FastifyInstance,
  options: {
    database: DatabaseSync;
    access: AccessStore;
    catalog: InstalledCatalog;
    contentCatalog: ContentCatalog;
    systems: readonly ServerSystemDefinition<unknown>[];
    imports: CampaignImportStore;
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
      { parseAs: "buffer", bodyLimit: MAX_OWNERSHIP_REVIEW_BYTES },
      (_request, body, done) => done(null, body),
    );
    const host = (request: FastifyRequest) =>
      options.access.requireServerHost(sessionToken(request.headers.cookie));
    const guard = async (request: FastifyRequest) => {
      host(request);
      imageInspector.assertAvailable();
    };
    const body = (request: FastifyRequest) => {
      z.object({}).strict().parse(request.query);
      if (!Buffer.isBuffer(request.body))
        throw new StoreError("Send campaign JSON.", 400);
      const serialized = request.body.toString("utf8");
      if (!Buffer.from(serialized).equals(request.body))
        throw new StoreError("Campaign requests must use valid UTF-8.", 400);
      return serialized;
    };
    const inspect = async (
      request: FastifyRequest,
      reply: FastifyReply,
      serialized: string,
    ) => {
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
        host(request); // Sessions/memberships can be revoked during worker execution.
        return report;
      } finally {
        reply.raw.removeListener("close", cancel);
      }
    };
    api.get(
      "/api/campaign-imports/people",
      {
        onRequest: async (request) => {
          host(request);
        },
      },
      async (request) => {
        const query = importPeopleQuerySchema.parse(request.query);
        return destinationSnapshot(options.database, () => {
          const current = host(request),
            q = query.q ?? "";
          const people = options.database
            .prepare(
              `SELECT u.id,u.name FROM access_users u
          WHERE u.id > ? AND (u.id=? OR EXISTS(SELECT 1 FROM access_memberships m WHERE m.user_id=u.id))
          AND (?='' OR instr(lower(u.name),lower(?))>0) ORDER BY u.id LIMIT 101`,
            )
            .all(query.after ?? "", current.id, q, q);
          return importPeoplePageSchema.parse({
            host: { id: current.id, name: current.name },
            people: people.slice(0, 100),
            nextCursor: people.length > 100 ? people[99]!.id : null,
          });
        });
      },
    );
    api.post(
      "/api/campaign-imports/status",
      {
        bodyLimit: MAX_CAMPAIGN_EXPORT_BYTES,
        onRequest: async (request) => {
          host(request);
        },
      },
      async (request) => {
        const serialized = body(request),
          archiveSha256 = createHash("sha256").update(serialized).digest("hex");
        return options.imports.status(
          archiveSha256,
          sessionToken(request.headers.cookie),
        );
      },
    );
    api.post(
      "/api/campaign-imports/preflight",
      {
        bodyLimit: MAX_CAMPAIGN_EXPORT_BYTES,
        onRequest: guard,
      },
      async (request, reply) => {
        host(request);
        return inspect(request, reply, body(request));
      },
    );
    api.post(
      "/api/campaign-imports/ownership-review",
      {
        bodyLimit: MAX_OWNERSHIP_REVIEW_BYTES,
        onRequest: guard,
      },
      async (request, reply) => {
        host(request);
        const input = parseOwnershipReviewEnvelope(body(request)),
          report = await inspect(request, reply, input.file);
        return reviewCampaignOwnership(
          report,
          input.plan,
          options.database,
          host(request).id,
        );
      },
    );
    api.post(
      "/api/campaign-imports/prepare",
      {
        bodyLimit: MAX_OWNERSHIP_REVIEW_BYTES,
        onRequest: guard,
      },
      async (request, reply) => {
        host(request);
        const input = parsePreparationEnvelope(body(request)),
          source = await inspect(request, reply, input.file),
          reviewed = reviewCampaignOwnership(
            source,
            input.plan,
            options.database,
            host(request).id,
          ),
          candidate = prepareCampaignCandidate(
            input.file,
            reviewed,
            options.catalog,
            options.contentCatalog,
            options.systems,
            options.database,
          );
        host(request);
        return candidate.report;
      },
    );
    api.post(
      "/api/campaign-imports/import",
      {
        bodyLimit: MAX_OWNERSHIP_REVIEW_BYTES,
        onRequest: guard,
      },
      async (request, reply) => {
        host(request);
        const input = parseImportEnvelope(body(request)),
          token = sessionToken(request.headers.cookie),
          replay = options.imports.replay(input, token);
        if (replay) return replay;
        const checked = await inspect(request, reply, input.file),
          result = options.imports.commit(input, token, checked);
        return reply.code(result.replayed ? 200 : 201).send(result);
      },
    );
  });
}
