import { z } from "zod";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DIMENSION,
  MAX_ASSET_PIXELS,
  MAX_CAMPAIGN_ASSETS,
} from "@tableloom/core/assets";
export const MAX_PREFLIGHT_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_PREFLIGHT_IMAGE_INPUT_BYTES = 32 * 1024 * 1024;
export const IMAGE_INSPECTION_TIMEOUT_MS = 10_000;
export const imageInspectionMetadataSchema = z
  .object({
    id: z.uuid(),
    width: z.number().int().positive().max(MAX_ASSET_DIMENSION),
    height: z.number().int().positive().max(MAX_ASSET_DIMENSION),
    byteLength: z.number().int().positive().max(MAX_ASSET_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .refine((image) => image.width * image.height <= MAX_ASSET_PIXELS);
export const imageInspectionJobSchema = z
  .object({
    images: z
      .array(
        z
          .object({
            metadata: imageInspectionMetadataSchema,
            bytes: z.instanceof(Uint8Array),
          })
          .strict(),
      )
      .max(MAX_CAMPAIGN_ASSETS),
  })
  .strict()
  .refine(
    ({ images }) =>
      images.reduce(
        (n, image) => n + image.metadata.width * image.metadata.height,
        0,
      ) <= MAX_PREFLIGHT_IMAGE_PIXELS &&
      images.reduce((n, image) => n + image.bytes.byteLength, 0) <=
        MAX_PREFLIGHT_IMAGE_INPUT_BYTES,
  );
export const imageInspectionReplySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      count: z.number().int().nonnegative().max(MAX_CAMPAIGN_ASSETS),
      pixels: z.number().int().nonnegative().max(MAX_PREFLIGHT_IMAGE_PIXELS),
    })
    .strict(),
  z.object({ status: z.literal("invalid") }).strict(),
]);
