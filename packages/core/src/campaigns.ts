import { z } from "zod";
import { moduleVersionSchema, systemIdSchema } from "@tableloom/module-sdk";

export const DEFAULT_CAMPAIGN_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_SCENE_ID = "00000000-0000-4000-8000-000000000002";
export const MAX_CAMPAIGNS = 100;
export const MAX_SCENES = 100;
export const versionPinSchema = z
  .object({ id: systemIdSchema, version: moduleVersionSchema })
  .strict();
export const campaignSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000),
    system: versionPinSchema,
    contentPacks: z
      .array(versionPinSchema)
      .max(100)
      .refine(
        (pins) => new Set(pins.map((pin) => pin.id)).size === pins.length,
        "Pin each content pack once.",
      ),
  })
  .strict();
export const campaignSchema = campaignSettingsSchema
  .extend({
    id: z.uuid(),
    activeSceneId: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();
export const sceneSettingsSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict();
export const sceneSchema = sceneSettingsSchema
  .extend({
    id: z.uuid(),
    campaignId: z.uuid(),
    version: z.number().int().positive(),
  })
  .strict();
export const installedPackSchema = versionPinSchema
  .extend({ systemId: systemIdSchema })
  .strict();
export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignSettings = z.infer<typeof campaignSettingsSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export const campaignMembershipSchema = campaignSchema
  .extend({ role: z.enum(["gm", "player"]) })
  .strict();
export const campaignListSchema = z
  .array(campaignMembershipSchema)
  .max(MAX_CAMPAIGNS);
export const campaignUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    settings: campaignSettingsSchema,
  })
  .strict();
export const sceneListSchema = z.array(sceneSchema).max(MAX_SCENES);
export const sceneActivationSchema = z
  .object({ sceneId: z.uuid(), expectedVersion: z.number().int().positive() })
  .strict();
export const commandContextSchema = z
  .object({
    campaignId: z.uuid(),
    sceneId: z.uuid(),
    generation: z.number().int().positive(),
  })
  .strict();
export type CommandContext = z.infer<typeof commandContextSchema>;
export const contextKey = (context: CommandContext) =>
  `${context.campaignId}:${context.sceneId}:${context.generation}`;
