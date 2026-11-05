import { createHash } from "node:crypto";
import { z } from "zod";
import { contentPackSchema } from "@tableloom/module-sdk/content";
import type {
  ContentPackDefinition,
  ContentReference,
  ContentInstanceFactory,
} from "@tableloom/module-sdk/content";
import { contentKey } from "@tableloom/core/content";
import type { InstalledCatalog } from "./store.js";
import { StoreError } from "./store.js";
import { documentData } from "@tableloom/module-sdk";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Invalid catalog JSON");
  return text;
}
function freezeJson(value: unknown) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}
export function validatedContentData(
  schema: z.ZodType<unknown>,
  value: unknown,
  normalize = false,
) {
  const data = normalize
    ? documentData(schema.parse(documentData(value)))
    : documentData(value);
  const checked = schema.safeParse(data);
  if (
    !checked.success ||
    canonical(documentData(checked.data)) !== canonical(data)
  )
    throw new Error("Content data is not in its canonical schema form.");
  return data;
}
export class ContentCatalog {
  readonly packs: readonly {
    pack: ReturnType<typeof contentPackSchema.parse>;
    dataSchema: ContentPackDefinition<unknown>["dataSchema"];
    transfer?: ContentPackDefinition<unknown>["transfer"];
    digest: string;
    instances?: ContentInstanceFactory;
  }[];
  private byPack = new Map<string, ContentCatalog["packs"][number]>();
  private byDefinition = new Map<
    string,
    ContentCatalog["packs"][number] & {
      definition: z.infer<typeof contentPackSchema>["definitions"][number];
    }
  >();
  constructor(providers: readonly ContentPackDefinition<unknown>[]) {
    if (providers.length > 100)
      throw new Error("Install at most 100 content pack versions.");
    const seen = new Set<string>();
    this.packs = providers.map((provider) => {
      const { dataSchema, instances, transfer, ...raw } = provider;
      if (
        (transfer && typeof transfer.inspect !== "function") ||
        (instances?.transfer &&
          typeof instances.transfer.inspect !== "function")
      )
        throw new Error("Invalid content transfer registration.");
      const pack = contentPackSchema.parse(structuredClone(raw)),
        key = `${pack.id}@${pack.version}`;
      if (seen.has(key))
        throw new Error("Duplicate content pack registration.");
      seen.add(key);
      for (const definition of pack.definitions)
        validatedContentData(dataSchema, definition.data);
      pack.definitions.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (instances) {
        z.number().int().positive().parse(instances.schemaVersion);
        if (
          typeof instances.create !== "function" ||
          typeof instances.dataSchema?.parse !== "function"
        )
          throw new Error("Invalid content instance factory registration.");
      }
      const digest = createHash("sha256")
        .update(
          canonical(
            instances
              ? { ...pack, instanceSchemaVersion: instances.schemaVersion }
              : pack,
          ),
        )
        .digest("hex");
      freezeJson(pack);
      return Object.freeze({
        pack,
        dataSchema,
        ...(transfer ? { transfer: Object.freeze({ ...transfer }) } : {}),
        digest,
        ...(instances ? { instances: Object.freeze({ ...instances }) } : {}),
      });
    });
    for (const entry of this.packs) {
      this.byPack.set(`${entry.pack.id}@${entry.pack.version}`, entry);
      for (const definition of entry.pack.definitions)
        this.byDefinition.set(
          contentKey({
            packId: entry.pack.id,
            packVersion: entry.pack.version,
            definitionId: definition.id,
          }),
          Object.freeze({ ...entry, definition }),
        );
    }
    Object.freeze(this.packs);
  }
  metadata() {
    return this.packs.map(({ pack }) => ({
      id: pack.id,
      version: pack.version,
      systemId: pack.systemId,
      systemVersion: pack.systemVersion,
    }));
  }
  find(reference: ContentReference) {
    const entry = this.byDefinition.get(contentKey(reference));
    if (!entry)
      throw new StoreError("That content definition is unavailable.", 404);
    return entry;
  }
  references(pins: readonly { id: string; version: string }[]) {
    return pins
      .flatMap((pin) => {
        const entry = this.byPack.get(`${pin.id}@${pin.version}`);
        if (!entry)
          throw new StoreError("A selected content pack is not loaded.", 409);
        return entry.pack.definitions.map((d) => ({
          packId: pin.id,
          packVersion: pin.version,
          definitionId: d.id,
        }));
      })
      .sort((a, b) =>
        contentKey(a) < contentKey(b)
          ? -1
          : contentKey(a) > contentKey(b)
            ? 1
            : 0,
      );
  }
}
export function withContentMetadata(
  catalog: InstalledCatalog,
  content: ContentCatalog,
): InstalledCatalog {
  const packs = [...catalog.contentPacks];
  for (const pack of content.metadata()) {
    if (
      !catalog.systems.some(
        (system) =>
          system.id === pack.systemId && system.version === pack.systemVersion,
      )
    )
      throw new Error(
        "A content pack requires an uninstalled system package pin.",
      );
    const index = packs.findIndex(
        (p) => p.id === pack.id && p.version === pack.version,
      ),
      old = packs[index];
    if (
      old &&
      (old.systemId !== pack.systemId ||
        (old.systemVersion !== undefined &&
          old.systemVersion !== pack.systemVersion))
    )
      throw new Error(
        "Content pack metadata disagrees with its loaded provider.",
      );
    if (index < 0) packs.push(pack);
    else packs[index] = pack;
  }
  return { ...catalog, contentPacks: packs };
}
