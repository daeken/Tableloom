import { z } from "zod";
import { documentData, documentActionIdSchema } from "@tableloom/module-sdk";
import { versionPinSchema } from "./campaigns.js";

export const MAX_CAMPAIGN_DOCUMENTS = 500;
export const documentMetadataSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    title: z.string().trim().min(1).max(120),
    ownerId: z.uuid(),
    visibility: z.enum(["public", "gm"]),
    system: versionPinSchema,
    schemaVersion: z.number().int().positive(),
    version: z.number().int().positive(),
  })
  .strict();
export const documentSchema = documentMetadataSchema
  .extend({
    data: z.unknown().transform((value, context) => {
      try {
        return documentData(value);
      } catch {
        context.addIssue({
          code: "custom",
          message: "Invalid or oversized JSON document data.",
        });
        return z.NEVER;
      }
    }),
  })
  .strict();
export const documentCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    visibility: z.enum(["public", "gm"]).default("gm"),
    system: versionPinSchema,
    data: z.unknown().optional(),
  })
  .strict();
export const documentUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(120),
    visibility: z.enum(["public", "gm"]),
    data: z.unknown(),
  })
  .strict();
export const documentVersionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const documentActionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: documentActionIdSchema,
    input: documentSchema.shape.data,
  })
  .strict();
export const documentPageSchema = z
  .object({
    documents: z.array(documentMetadataSchema).max(50),
    next: z.uuid().nullable(),
  })
  .strict();
export type SystemDocument = z.infer<typeof documentSchema>;
export type DocumentMetadata = z.infer<typeof documentMetadataSchema>;
