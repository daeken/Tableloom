import { z } from "zod";
import { documentData } from "./document-data.js";
import { contentReferenceSchema } from "./content.js";

const referenceSchema = z
  .object({
    kind: z.enum([
      "campaign",
      "scene",
      "token",
      "drawing",
      "note",
      "document",
      "instance",
      "asset",
      "roll",
      "member",
      "content",
    ]),
    path: z
      .array(z.union([z.string().max(1024), z.number().int().min(0).max(9999)]))
      .max(20),
  })
  .strict();
export type CampaignDataReference = z.infer<typeof referenceSchema>;
export interface CampaignDataTransfer {
  /** Enumerate every campaign-resource/identity reference. An empty list explicitly declares self-contained data. */
  inspect(data: unknown): readonly CampaignDataReference[];
}
type PathNode = { terminal: boolean; children: Map<string | number, PathNode> };
const pathNode = (): PathNode => ({ terminal: false, children: new Map() });

/** Server-only: keep schema inference within the trusted module. */
export function defineCampaignDataTransfer<T>(
  schema: z.ZodType<T>,
  references: (data: T) => readonly CampaignDataReference[],
): CampaignDataTransfer {
  return { inspect: (raw) => references(schema.parse(documentData(raw))) };
}

/** Inspect a detached copy; resolve declared own-property paths against unchanged source JSON. */
export function inspectCampaignDataReferences(
  policy: CampaignDataTransfer,
  raw: unknown,
) {
  const source = documentData(raw),
    references = z
      .array(referenceSchema)
      .max(1000)
      .parse(documentData(policy.inspect(documentData(source)))),
    paths = pathNode();
  return references.map((reference) => {
    let node = paths;
    for (const part of reference.path) {
      if (node.terminal)
        throw new Error("Overlapping transfer reference paths.");
      if (!node.children.has(part)) node.children.set(part, pathNode());
      node = node.children.get(part)!;
    }
    if (node.terminal || node.children.size)
      throw new Error("Overlapping transfer reference paths.");
    node.terminal = true;
    let value: unknown = source;
    for (const part of reference.path) {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) !== (typeof part === "number") ||
        !Object.hasOwn(value, part)
      )
        throw new Error("Invalid transfer reference path.");
      value = (value as Record<string | number, unknown>)[part];
    }
    return reference.kind === "content"
      ? {
          ...reference,
          kind: "content" as const,
          value: contentReferenceSchema.parse(value),
        }
      : { ...reference, kind: reference.kind, value: z.uuid().parse(value) };
  });
}
