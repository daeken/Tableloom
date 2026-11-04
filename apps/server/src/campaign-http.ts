import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  campaignListSchema,
  campaignMembershipSchema,
  campaignSettingsSchema,
  campaignUpdateSchema,
} from "@tableloom/core/campaigns";
import { AccessError, AccessStore } from "./access.js";
import type { SessionGrant } from "./access.js";
import { sessionToken } from "./access-http.js";
import { StoreError, TableStore } from "./store.js";
import { transaction } from "./database.js";

export function registerCampaignRoutes(
  app: FastifyInstance,
  store: TableStore,
  access: AccessStore,
  options: {
    database: DatabaseSync;
    setSession: (grant: SessionGrant) => string;
    disconnectInvalid: () => void;
    refreshCampaign: (campaignId: string) => void;
  },
) {
  const token = (request: FastifyRequest) =>
    sessionToken(request.headers.cookie);
  const id = (request: FastifyRequest) =>
    z.object({ id: z.uuid() }).strict().parse(request.params).id;
  app.get("/api/campaigns", async (request) =>
    campaignListSchema.parse(
      access
        .listMemberships(token(request))
        .map((member) => ({
          ...store.getCampaign(member.tableId),
          role: member.role,
        })),
    ),
  );
  app.get("/api/campaigns/:id", async (request) => {
    const member = access.resolveMembership(token(request), id(request));
    return campaignMembershipSchema.parse({
      ...store.getCampaign(member.tableId),
      role: member.role,
    });
  });
  app.post("/api/campaigns", async (request, reply) => {
    access.requireServerHost(token(request));
    const settings = campaignSettingsSchema.parse(request.body);
    const created = transaction(options.database, () => {
      const campaign = store.createCampaign(settings);
      const member = access.registerCampaign(token(request), campaign.id);
      return campaignMembershipSchema.parse({ ...campaign, role: member.role });
    });
    return reply.code(201).send(created);
  });
  app.post("/api/campaigns/:id/settings", async (request) => {
    const current = access.authenticate(token(request));
    if (!current) throw new AccessError("sign_in_required");
    const campaignId = id(request);
    if (current.tableId !== campaignId)
      throw new StoreError(
        "Your active campaign changed. Open this campaign before editing it.",
        409,
      );
    if (current.role !== "gm") throw new AccessError("host_required");
    const body = campaignUpdateSchema.parse(request.body);
    const updated = store.updateCampaign(
      campaignId,
      body.expectedVersion,
      body.settings,
    );
    options.refreshCampaign(campaignId);
    return campaignMembershipSchema.parse({ ...updated, role: current.role });
  });
  app.post("/api/campaigns/:id/select", async (request, reply) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    const campaignId = id(request);
    const grant = transaction(options.database, () => {
      access.resolveMembership(token(request), campaignId);
      store.load(campaignId); // Validate availability before replacing a working session.
      return access.selectCampaign(token(request), campaignId);
    });
    options.disconnectInvalid();
    reply.header("Set-Cookie", options.setSession(grant));
    return { setupRequired: false, member: grant.member };
  });
}
