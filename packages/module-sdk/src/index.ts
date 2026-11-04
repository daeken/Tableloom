import { z } from "zod";
import { documentData } from "./document-data.js";
export { documentData, MAX_DOCUMENT_BYTES } from "./document-data.js";
export type { DocumentData } from "./document-data.js";

export const systemIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export type SystemId = z.infer<typeof systemIdSchema>;
export const moduleVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export const sourceReferenceSchema = z.object({
  title: z.string().min(1),
  edition: z.string().min(1),
  page: z.string().min(1),
});

export const moduleManifestSchema = z.object({
  id: systemIdSchema,
  name: z.string().min(1),
  version: moduleVersionSchema,
  sdkVersion: z.literal(1),
  status: z.enum(["scaffold", "playtest", "ready"]),
  description: z.string(),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

// Module-specific fields stay in data; core never prescribes an attribute model.
export interface VersionedDocument<T> {
  id: string;
  systemId: SystemId;
  schemaVersion: number;
  data: T;
}

export interface ContentDefinition<T> {
  id: string;
  name: string;
  kind: string;
  data: T;
  sources: z.infer<typeof sourceReferenceSchema>[];
}

export interface ContentPack<T> {
  id: string;
  version: string;
  systemId: SystemId;
  definitions: ContentDefinition<T>[];
}

export interface OwnedInstance<T> {
  id: string;
  definition: { packId: string; packVersion: string; definitionId: string };
  data: T;
}

export interface SystemDefinition<T> {
  manifest: ModuleManifest;
  documentVersion: number;
  documentSchema: z.ZodType<T>;
  createDocument: () => T;
}

export function defineSystem<T>(
  definition: SystemDefinition<T>,
): SystemDefinition<T> {
  moduleManifestSchema.parse(definition.manifest);
  z.number().int().positive().parse(definition.documentVersion);
  documentData(
    definition.documentSchema.parse(documentData(definition.createDocument())),
  );
  return definition;
}
