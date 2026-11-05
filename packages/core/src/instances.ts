import { z } from "zod";
import { versionPinSchema } from "./campaigns.js";
import {
  contentIdSchema,
  contentReferenceSchema,
  contentDataSchema,
  contentSourcesSchema,
} from "@tableloom/module-sdk/content";

export const MAX_CAMPAIGN_INSTANCES = 1000;
const version = z.number().int().positive();
export const instanceSourceSchema = z
  .object({
    name: z.string().min(1).max(120),
    kind: contentIdSchema,
    data: contentDataSchema,
    sources: contentSourcesSchema,
  })
  .strict();
export const instanceMetadataSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    ownerId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    kind: contentIdSchema,
    visibility: z.enum(["gm", "public"]),
    system: versionPinSchema,
    reference: contentReferenceSchema,
    definitionRevision: z.number().int().nonnegative(),
    schemaVersion: version,
    version,
  })
  .strict();
export const instanceSchema = instanceMetadataSchema
  .extend({
    source: instanceSourceSchema,
    data: contentDataSchema,
  })
  .strict();
export const instanceCreateSchema = z
  .object({
    reference: contentReferenceSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export const instanceUpdateSchema = z
  .object({
    expectedVersion: version,
    name: z.string().trim().min(1).max(120),
    visibility: z.enum(["gm", "public"]),
    data: contentDataSchema,
  })
  .strict();
export const instanceVersionSchema = z
  .object({ expectedVersion: version })
  .strict();
export const instancePageSchema = z
  .object({
    instances: z.array(instanceMetadataSchema).max(50),
    next: z.uuid().nullable(),
  })
  .strict();
export type OwnedContentInstance = z.infer<typeof instanceSchema>;
export type InstanceMetadata = z.infer<typeof instanceMetadataSchema>;
