import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  instanceCreateSchema,
  instanceUpdateSchema,
  instanceVersionSchema,
} from "@tableloom/core/instances";
import { AccessError, AccessStore } from "./access.js";
import { StoreError } from "./store.js";
import { ContentInstanceStore } from "./instances.js";
import { sessionToken } from "./access-http.js";

export function registerInstanceRoutes(
  app: FastifyInstance,
  access: AccessStore,
  instances: ContentInstanceStore,
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
        "Your active campaign changed. Open it before accessing instances.",
        409,
      );
    return member;
  };
  const id = (request: FastifyRequest) =>
    z
      .object({ campaignId: z.uuid(), id: z.uuid() })
      .strict()
      .parse(request.params).id;
  const root = "/api/campaigns/:campaignId/instances";
  app.get(root, async (request) => {
    const member = actor(request);
    const query = z
      .object({
        after: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .strict()
      .parse(request.query);
    return instances.list(member, {
      ...(query.after ? { after: query.after } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });
  app.post(root, async (request, reply) => {
    const member = actor(request);
    return reply
      .code(201)
      .send(instances.create(member, instanceCreateSchema.parse(request.body)));
  });
  app.get(`${root}/:id`, async (request) =>
    instances.get(actor(request), id(request)),
  );
  app.post(`${root}/:id`, async (request) => {
    const member = actor(request);
    return instances.update(
      member,
      id(request),
      instanceUpdateSchema.parse(request.body),
    );
  });
  app.post(`${root}/:id/delete`, async (request) => {
    const member = actor(request),
      body = instanceVersionSchema.parse(request.body);
    instances.delete(member, id(request), body.expectedVersion);
    return { ok: true };
  });
}
