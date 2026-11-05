import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  documentCreateSchema,
  documentUpdateSchema,
  documentVersionSchema,
  documentActionSchema,
} from "@tableloom/core/documents";
import { AccessError, AccessStore } from "./access.js";
import { StoreError } from "./store.js";
import { DocumentStore } from "./documents.js";
import { sessionToken } from "./access-http.js";

export function registerDocumentRoutes(
  app: FastifyInstance,
  access: AccessStore,
  documents: DocumentStore,
) {
  const actor = (request: FastifyRequest) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member) throw new AccessError("sign_in_required");
    const params = z
      .object({ campaignId: z.uuid(), id: z.uuid().optional() })
      .strict()
      .parse(request.params);
    if (params.campaignId !== member.tableId)
      throw new StoreError(
        "Your active campaign changed. Open it before accessing documents.",
        409,
      );
    return member;
  };
  const id = (request: FastifyRequest) =>
    z
      .object({ campaignId: z.uuid(), id: z.uuid() })
      .strict()
      .parse(request.params).id;
  const root = "/api/campaigns/:campaignId/documents";
  app.get(root, async (request) => {
    const member = actor(request);
    const query = z
      .object({
        after: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .strict()
      .parse(request.query);
    return documents.list(member, {
      ...(query.after ? { after: query.after } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });
  app.post(root, async (request, reply) => {
    const member = actor(request);
    return reply
      .code(201)
      .send(documents.create(member, documentCreateSchema.parse(request.body)));
  });
  app.get(`${root}/:id`, async (request) =>
    documents.get(actor(request), id(request)),
  );
  app.post(`${root}/:id`, async (request) => {
    const member = actor(request);
    return documents.update(
      member,
      id(request),
      documentUpdateSchema.parse(request.body),
    );
  });
  app.post(`${root}/:id/delete`, async (request) => {
    const member = actor(request),
      body = documentVersionSchema.parse(request.body);
    documents.delete(member, id(request), body.expectedVersion);
    return { ok: true };
  });
  app.post(`${root}/:id/migrate`, async (request) => {
    const member = actor(request),
      body = documentVersionSchema.parse(request.body);
    return documents.migrate(member, id(request), body.expectedVersion);
  });
  app.post(`${root}/:id/actions`, async (request) =>
    documents.act(
      actor(request),
      id(request),
      documentActionSchema.parse(request.body),
    ),
  );
}
