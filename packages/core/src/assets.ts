import { z } from "zod";
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const MAX_ASSET_PIXELS = 16 * 1024 * 1024;
export const MAX_ASSET_DIMENSION = 8192;
export const MAX_CAMPAIGN_ASSETS = 200;
export const MAX_CAMPAIGN_ASSET_BYTES = 100 * 1024 * 1024;
export const assetNameSchema = z.string().trim().min(1).max(120);
export const assetSchema = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    name: assetNameSchema,
    mimeType: z.literal("image/png"),
    byteLength: z.number().int().min(1).max(MAX_ASSET_BYTES),
    width: z.number().int().min(1).max(MAX_ASSET_DIMENSION),
    height: z.number().int().min(1).max(MAX_ASSET_DIMENSION),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .refine((asset) => asset.width * asset.height <= MAX_ASSET_PIXELS);
export type Asset = z.infer<typeof assetSchema>;
export const assetPageSchema = z
  .object({
    assets: z.array(assetSchema).max(50),
    nextCursor: z.uuid().nullable(),
    totalCount: z.number().int().min(0).max(MAX_CAMPAIGN_ASSETS),
    usedBytes: z.number().int().min(0).max(MAX_CAMPAIGN_ASSET_BYTES),
  })
  .strict();
