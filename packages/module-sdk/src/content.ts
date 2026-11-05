import { z } from "zod";
import {
  systemIdSchema,
  moduleVersionSchema,
  sourceReferenceSchema,
} from "./index.js";
import type { SystemDefinition, ContentDefinition } from "./index.js";
import { documentData } from "./document-data.js";

export const contentIdSchema = z.string().regex(/^[a-z][a-z0-9.-]{0,95}$/);
export const contentVersionSchema = moduleVersionSchema.max(64);
export const contentSourcesSchema = z
  .array(
    sourceReferenceSchema
      .extend({
        title: z.string().trim().min(1).max(200),
        edition: z.string().trim().min(1).max(100),
        page: z.string().trim().min(1).max(100),
      })
      .strict(),
  )
  .max(20);
export const contentDataSchema = z.unknown().transform((value, context) => {
  try {
    return documentData(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Invalid or oversized content JSON.",
    });
    return z.NEVER;
  }
});
export const contentDefinitionSchema = z
  .object({
    id: contentIdSchema,
    name: z.string().trim().min(1).max(120),
    kind: contentIdSchema,
    visibility: z.enum(["public", "gm"]).default("gm"),
    sources: contentSourcesSchema,
    data: contentDataSchema,
  })
  .strict();
export const contentReferenceSchema = z
  .object({
    packId: contentIdSchema,
    packVersion: contentVersionSchema,
    definitionId: contentIdSchema,
  })
  .strict();
export type ContentReference = z.infer<typeof contentReferenceSchema>;
export const contentPackSchema = z
  .object({
    id: contentIdSchema,
    version: contentVersionSchema,
    systemId: systemIdSchema,
    systemVersion: contentVersionSchema,
    definitions: z.array(contentDefinitionSchema).max(1000),
  })
  .strict()
  .superRefine((pack, context) => {
    if (
      new Set(pack.definitions.map((d) => d.id)).size !==
      pack.definitions.length
    )
      context.addIssue({
        code: "custom",
        message: "Definition IDs must be unique in a pack.",
      });
    if (
      new TextEncoder().encode(JSON.stringify(pack)).byteLength >
      8 * 1024 * 1024
    )
      context.addIssue({
        code: "custom",
        message: "Content pack exceeds 8 MiB.",
      });
  });
export interface ContentPackDefinition<T> {
  id: string;
  version: string;
  systemId: string;
  systemVersion: string;
  dataSchema: z.ZodType<T>;
  definitions: (ContentDefinition<T> & { visibility: "public" | "gm" })[];
}
/** Source data stays in trusted server entry points, never browser imports. */
export function defineContentPack<T>(
  system: SystemDefinition<unknown>,
  input: {
    id: string;
    version: string;
    dataSchema: z.ZodType<T>;
    definitions: (ContentDefinition<T> & { visibility?: "public" | "gm" })[];
  },
): ContentPackDefinition<T> {
  const pack = contentPackSchema.parse({
    id: input.id,
    version: input.version,
    systemId: system.manifest.id,
    systemVersion: system.manifest.version,
    definitions: input.definitions,
  });
  const definitions = pack.definitions.map((definition) => {
    const data = input.dataSchema.parse(definition.data);
    documentData(data);
    return { ...definition, data };
  });
  // Recheck size after schema normalization/transforms.
  contentPackSchema.parse({ ...pack, definitions });
  return { ...pack, definitions, dataSchema: input.dataSchema };
}
