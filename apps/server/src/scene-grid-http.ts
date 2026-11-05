import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AccessStore, AccessError } from "./access.js";
import { sessionToken } from "./access-http.js";
import { StoreError } from "./store.js";
import { SceneGridStore } from "./scene-grid.js";
export function registerSceneGridRoutes(
  app: FastifyInstance,
  access: AccessStore,
  grids: SceneGridStore,
  refresh: (id: string) => void,
) {
  const actor = (request: FastifyRequest) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member) throw new AccessError("sign_in_required");
    if (
      z.object({ campaignId: z.uuid() }).strict().parse(request.params)
        .campaignId !== member.tableId
    )
      throw new StoreError(
        "Open this campaign before accessing its grid.",
        409,
      );
    return member;
  };
  const root = "/api/campaigns/:campaignId/scene-grid";
  app.get(root, async (request) => grids.controls(actor(request)));
  app.post(root, async (request) => {
    const member = actor(request),
      result = grids.update(member, request.body);
    refresh(member.tableId);
    return result;
  });
}
