import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AccessStore, AccessError } from "./access.js";
import { sessionToken } from "./access-http.js";
import { StoreError } from "./store.js";
import { SceneMapStore } from "./scene-map.js";
import { AssetStore } from "./assets.js";
export function registerSceneMapRoutes(
  app: FastifyInstance,
  access: AccessStore,
  maps: SceneMapStore,
  assets: AssetStore,
  refresh: (id: string) => void,
) {
  const params = z
    .object({
      campaignId: z.uuid(),
      sceneId: z.uuid().optional(),
      imageId: z.uuid().optional(),
    })
    .strict();
  const actor = (request: FastifyRequest) => {
    const member = access.authenticate(sessionToken(request.headers.cookie));
    if (!member) throw new AccessError("sign_in_required");
    if (params.parse(request.params).campaignId !== member.tableId)
      throw new StoreError("Open this campaign before accessing its map.", 409);
    return member;
  };
  const root = "/api/campaigns/:campaignId/scene-map";
  app.get(root, async (request) => maps.controls(actor(request)));
  for (const action of ["set", "visibility", "remove"] as const)
    app.post(`${root}/${action}`, async (request) => {
      const member = actor(request),
        result = maps[action](member, request.body);
      refresh(member.tableId);
      return result;
    });
  app.get(`${root}/:sceneId/:imageId/content`, async (request, reply) => {
    const member = actor(request),
      p = params.parse(request.params),
      result = assets.contentForScene(
        member,
        z.uuid().parse(p.sceneId),
        z.uuid().parse(p.imageId),
      );
    return reply
      .type("image/png")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `inline; filename="${p.imageId}.png"`)
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .send(result.bytes);
  });
}
