import { z } from "zod";

export const systemIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export type SystemId = z.infer<typeof systemIdSchema>;

export const sourceReferenceSchema = z.object({
  title: z.string().min(1),
  edition: z.string().min(1),
  page: z.string().min(1),
});

export const moduleManifestSchema = z.object({
  id: systemIdSchema,
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
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
  documentSchema: z.ZodType<T>;
  createDocument: () => T;
}

export function defineSystem<T>(
  definition: SystemDefinition<T>,
): SystemDefinition<T> {
  moduleManifestSchema.parse(definition.manifest);
  definition.documentSchema.parse(definition.createDocument());
  return definition;
}
