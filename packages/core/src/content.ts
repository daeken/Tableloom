import { z } from "zod";
import { campaignMembershipSchema, installedPackSchema } from "./campaigns.js";
import {
  contentIdSchema,
  contentVersionSchema,
  contentReferenceSchema,
  contentDataSchema,
  contentSourcesSchema,
} from "@tableloom/module-sdk/content";
export { contentReferenceSchema };
export type { ContentReference } from "@tableloom/module-sdk/content";
export const MAX_CAMPAIGN_CONTENT_OVERRIDES = 1000;
export const contentKey = (ref: z.infer<typeof contentReferenceSchema>) =>
  `${ref.packId}@${ref.packVersion}:${ref.definitionId}`;
export const contentCursorSchema = z
  .string()
  .max(300)
  .regex(
    /^[a-z][a-z0-9.-]{0,95}@[0-9]+\.[0-9]+\.[0-9]+:[a-z][a-z0-9.-]{0,95}$/,
  );
export const contentMetadataSchema = z
  .object({
    reference: contentReferenceSchema,
    campaignId: z.uuid(),
    name: z.string().min(1).max(120),
    kind: contentIdSchema,
    visibility: z.enum(["public", "gm"]),
    revision: z.number().int().nonnegative(),
    overridden: z.boolean(),
    system: z
      .object({ id: contentIdSchema, version: contentVersionSchema })
      .strict(),
  })
  .strict();
export const contentViewSchema = contentMetadataSchema
  .extend({
    data: contentDataSchema,
    sources: contentSourcesSchema,
    originSources: contentSourcesSchema,
  })
  .strict();
export const contentPageSchema = z
  .object({
    definitions: z.array(contentMetadataSchema).max(50),
    next: contentCursorSchema.nullable(),
  })
  .strict();
export const contentOverrideSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(120),
    visibility: z.enum(["public", "gm"]),
    data: contentDataSchema,
    sources: contentSourcesSchema,
  })
  .strict();
export const contentResetSchema = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();
export type ContentView = z.infer<typeof contentViewSchema>;
export const contentPacksViewSchema = z
  .object({
    campaign: campaignMembershipSchema,
    packs: z.array(installedPackSchema).max(100),
  })
  .strict();
