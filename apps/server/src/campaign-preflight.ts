import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { tableSchema, rollSchema } from "@tableloom/core";
import {
  campaignSchema,
  sceneSchema,
  MAX_CAMPAIGNS,
} from "@tableloom/core/campaigns";
import { documentSchema } from "@tableloom/core/documents";
import { instanceSchema } from "@tableloom/core/instances";
import { assetSchema } from "@tableloom/core/assets";
import { backgroundMapSchema } from "@tableloom/core/scene-map";
import { gridSettingsSchema } from "@tableloom/core/scene-grid";
import { chatMessageSchema } from "@tableloom/core/chat";
import { contentOverrideSchema } from "@tableloom/core/content";
import type { ServerSystemDefinition } from "@tableloom/module-sdk/server";
import { StoreError, type InstalledCatalog } from "./store.js";
import { ContentCatalog, validatedContentData } from "./content-catalog.js";
import {
  parseCampaignTransfer,
  type CampaignTransfer,
} from "./campaign-transfer-format.js";
import { entryOf } from "./scene-history-model.js";
import {
  inspectSceneHistoryGraph,
  type HistoryObjectLocation,
} from "./scene-history-graph.js";
import {
  backgroundHistoryEntrySchema,
  inspectSceneMapHistory,
  type MapRecord,
  type MapHistoryEntry,
} from "./scene-map-history-model.js";
import { validateCampaignStorageQuotas } from "./campaign-storage-quotas.js";
import type { CampaignImageInspector } from "./campaign-image-inspection.js";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const pinKey = (pin: { id: string; version: string }) =>
  `${pin.id}@${pin.version}`;
const invalid = () => {
  throw new StoreError(
    "Campaign content or resource references are inconsistent.",
    400,
  );
};
const campaignDataSchema = z
  .object({
    schemaVersion: z.literal(11),
    revision: tableSchema.shape.revision,
    rolls: tableSchema.shape.rolls,
    notes: tableSchema.shape.notes,
  })
  .strict();
const sceneDataSchema = z
  .object({
    tokens: tableSchema.shape.tokens,
    drawings: tableSchema.shape.drawings,
  })
  .strict();
type PackageStatus =
  "available" | "unavailable" | "changed" | "incompatible" | "historical-only";

/** Structural/semantic inspection only: image decoding stays pending. HTTP uses the async wrapper below. */
export function inspectCampaignTransfer(
  serialized: string,
  catalog: InstalledCatalog,
  content: ContentCatalog,
  systems: readonly ServerSystemDefinition<unknown>[],
  db: DatabaseSync,
) {
  const archive = parseCampaignTransfer(serialized);
  return inspectParsedCampaignTransfer(
    archive,
    serialized,
    catalog,
    content,
    systems,
    db,
  );
}

/** HTTP preflight completes image decoding without running it on the request thread. */
export async function inspectCampaignTransferWithImages(
  serialized: string,
  catalog: InstalledCatalog,
  content: ContentCatalog,
  systems: readonly ServerSystemDefinition<unknown>[],
  db: DatabaseSync,
  imageInspector: CampaignImageInspector,
  signal?: AbortSignal,
) {
  imageInspector.assertAvailable();
  const archive = parseCampaignTransfer(serialized);
  const report = inspectParsedCampaignTransfer(
    archive,
    serialized,
    catalog,
    content,
    systems,
    db,
  );
  const imageValidation = await imageInspector.inspect(
    archive.records.campaign_assets,
    signal,
  );
  return {
    ...report,
    imageValidation,
    pendingValidation: report.pendingValidation.filter(
      (item) => item !== "image-decoding",
    ),
  };
}

function inspectParsedCampaignTransfer(
  archive: CampaignTransfer,
  serialized: string,
  catalog: InstalledCatalog,
  content: ContentCatalog,
  systems: readonly ServerSystemDefinition<unknown>[],
  db: DatabaseSync,
) {
  validateCampaignStorageQuotas(archive.records);
  let report: ReturnType<typeof inspect>;
  try {
    report = inspect(archive, serialized, catalog, content, systems);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    // Do not echo module validation errors or private file values into logs/replies.
    throw new StoreError(
      "Campaign content or resource references are invalid.",
      400,
    );
  }
  if (db.isTransaction)
    throw new Error(
      "Campaign preflight needs its own destination read snapshot.",
    );
  db.exec("BEGIN");
  try {
    const destination = campaignTransferCollisions(db, archive);
    if (
      destination.campaignCapacity.used >= MAX_CAMPAIGNS ||
      destination.campaignCapacity.accessUsed >= MAX_CAMPAIGNS
    )
      report.blockers.push("campaign_capacity_reached");
    const stored = db.prepare(
      "SELECT digest FROM content_pack_bindings WHERE pack_id=? AND pack_version=?",
    );
    if (
      archive.packages.contentPacks.some((pin) => {
        const binding = stored.get(pin.id, pin.version);
        return binding && binding.digest !== pin.sha256;
      })
    )
      report.blockers.push("stored_pack_binding_changed");
    db.exec("COMMIT");
    report.blockers.sort();
    return { ...report, destination };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function inspect(
  archive: CampaignTransfer,
  serialized: string,
  catalog: InstalledCatalog,
  content: ContentCatalog,
  systems: readonly ServerSystemDefinition<unknown>[],
) {
  const { campaign, records } = archive,
    blockers = new Set<string>();
  const subjects = new Map<
    string,
    {
      sourceId: string;
      name: string | null;
      sourceRole: "gm" | "player" | null;
    }
  >();
  const subject = (id: string | null) => {
    if (id === null) return;
    z.uuid().parse(id);
    if (!subjects.has(id))
      subjects.set(id, { sourceId: id, name: null, sourceRole: null });
    if (subjects.size > 1000)
      throw new StoreError(
        "Campaign exceeds the 1,000 source identity preflight limit.",
        400,
      );
  };
  for (const member of archive.members) {
    if (subjects.has(member.id)) invalid();
    subject(member.id);
    subjects.set(member.id, {
      sourceId: member.id,
      name: member.name,
      sourceRole: member.role,
    });
  }
  // Only neutral historical payloads use this traversal; opaque module data is never scanned for identities.
  const historicalOwners = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "ownerId") subject(z.uuid().nullable().parse(child));
      else historicalOwners(child);
    }
  };
  const unique = <T>(rows: readonly T[], key: (row: T) => string) => {
    const keys = new Set<string>();
    for (const row of rows) {
      const id = key(row);
      if (keys.has(id)) invalid();
      keys.add(id);
    }
    return keys;
  };
  const primaryKeys = {
    campaign_records: ["id"],
    scene_records: ["id"],
    campaign_receipts: ["id"],
    command_bindings: ["id"],
    object_id_reservations: ["id"],
    module_documents: ["id"],
    content_overrides: ["pack_id", "pack_version", "definition_id"],
    content_instances: ["id"],
    campaign_assets: ["id"],
    scene_backgrounds: ["scene_id"],
    scene_background_history: ["scene_id", "id"],
    scene_background_history_refs: ["scene_id", "entry_id", "asset_id"],
    scene_grids: ["scene_id"],
    scene_history_entries: ["id"],
    roll_archive: ["id"],
    chat_messages: ["id"],
  } as const;
  for (const [name, rows] of Object.entries(records)) {
    const keys = primaryKeys[name as keyof typeof primaryKeys];
    unique<
      CampaignTransfer["records"][keyof CampaignTransfer["records"]][number]
    >(rows, (row) =>
      JSON.stringify(
        keys.map((key) => z.record(z.string(), z.unknown()).parse(row)[key]),
      ),
    );
    for (const row of rows) {
      if ("campaign_id" in row && row.campaign_id !== campaign.id) invalid();
      if ("owner_id" in row) subject(row.owner_id);
      if ("actor_id" in row) subject(row.actor_id);
    }
  }
  const saved = records.campaign_records[0]!;
  if (
    saved.id !== campaign.id ||
    saved.active_scene_id !== campaign.activeSceneId ||
    !same(campaignSchema.parse(JSON.parse(saved.json)), campaign)
  )
    invalid();
  if (!same(archive.packages.system, campaign.system)) invalid();
  const data = campaignDataSchema.parse(JSON.parse(saved.state_json));
  for (const note of data.notes) subject(note.ownerId);
  for (const roll of data.rolls) subject(roll.ownerId);
  const scenes = unique(records.scene_records, (row) => row.id),
    objects = unique(data.notes, (note) => note.id);
  const historyObjects = new Map<string, HistoryObjectLocation>(
    data.notes.map((note) => [note.id, { kind: "note", sceneId: null }]),
  );
  if (!scenes.has(campaign.activeSceneId)) invalid();
  const reservations = new Set(
    records.object_id_reservations.map((row) => row.id),
  );
  for (const row of records.scene_records) {
    const metadata = sceneSchema.parse(JSON.parse(row.json));
    if (metadata.id !== row.id || metadata.campaignId !== campaign.id)
      invalid();
    const scene = sceneDataSchema.parse(JSON.parse(row.state_json));
    tableSchema.parse({ ...data, ...scene, systemId: campaign.system.id });
    for (const object of [...scene.tokens, ...scene.drawings]) {
      if (objects.has(object.id) || !reservations.has(object.id)) invalid();
      objects.add(object.id);
      historyObjects.set(object.id, {
        kind: "position" in object ? "token" : "drawing",
        sceneId: row.id,
      });
      subject(object.ownerId);
    }
  }
  for (const id of objects) if (!reservations.has(id)) invalid();
  for (const row of records.campaign_receipts)
    if (row.revision > data.revision) invalid();
  const receipts = new Set(records.campaign_receipts.map((row) => row.id));
  for (const row of records.command_bindings)
    if (!receipts.has(row.id)) invalid();
  const assets = new Set(records.campaign_assets.map((row) => row.id));
  for (const row of records.campaign_assets) {
    assetSchema.parse({
      id: row.id,
      campaignId: campaign.id,
      name: row.name,
      mimeType: "image/png",
      byteLength: row.byte_length,
      width: row.width,
      height: row.height,
      createdAt: row.created_at,
    });
    const bytes = Buffer.from(row.bytes, "base64");
    if (
      bytes.toString("base64") !== row.bytes ||
      bytes.length !== row.byte_length ||
      createHash("sha256").update(bytes).digest("hex") !== row.sha256
    )
      invalid();
  }
  const backgrounds = new Map(
    records.scene_backgrounds.map((row) => [row.scene_id, row]),
  );
  const mapStates = new Map<string, MapRecord>();
  for (const row of records.scene_backgrounds) {
    const map = backgroundMapSchema.nullable().parse(JSON.parse(row.map_json));
    if (
      !scenes.has(row.scene_id) ||
      (map?.assetId ?? null) !== row.asset_id ||
      (map?.imageId ?? null) !== row.image_id ||
      (map && !assets.has(map.assetId))
    )
      invalid();
    mapStates.set(row.scene_id, {
      map,
      version: row.version,
      cursor: row.history_cursor,
    });
  }
  for (const row of records.scene_grids) {
    if (!scenes.has(row.scene_id)) invalid();
    gridSettingsSchema.parse(JSON.parse(row.settings_json));
  }
  unique(
    records.scene_background_history,
    (row) => `${row.scene_id}/${row.seq}`,
  );
  const mapEntries = new Map<string, Set<string>>();
  const histories = new Map<string, MapHistoryEntry[]>();
  for (const row of records.scene_background_history) {
    const entry = backgroundHistoryEntrySchema.parse(
        JSON.parse(row.entry_json),
      ),
      background = backgrounds.get(row.scene_id);
    if (
      !background ||
      row.id !== entry.id ||
      row.seq !== entry.seq ||
      entry.seq > background.version
    )
      invalid();
    const refs = new Set(
      [entry.before?.assetId, entry.after?.assetId].filter((id): id is string =>
        Boolean(id),
      ),
    );
    if ([...refs].some((id) => !assets.has(id))) invalid();
    mapEntries.set(`${row.scene_id}/${row.id}`, refs);
    const entries = histories.get(row.scene_id) ?? [];
    entries.push(entry);
    histories.set(row.scene_id, entries);
  }
  const actualMapRefs = new Map<string, Set<string>>();
  for (const row of records.scene_background_history_refs) {
    const key = `${row.scene_id}/${row.entry_id}`;
    if (!mapEntries.has(key) || !assets.has(row.asset_id)) invalid();
    const refs = actualMapRefs.get(key) ?? new Set<string>();
    refs.add(row.asset_id);
    actualMapRefs.set(key, refs);
  }
  for (const [key, refs] of mapEntries)
    if (!same([...refs].sort(), [...(actualMapRefs.get(key) ?? [])].sort()))
      invalid();
  for (const [sceneId, state] of mapStates)
    inspectSceneMapHistory(
      state,
      (histories.get(sceneId) ?? []).sort((a, b) => a.seq - b.seq),
    );
  unique(records.scene_history_entries, (row) => String(row.sequence));
  function* historyEntries() {
    for (const row of records.scene_history_entries) {
      if (!scenes.has(row.scene_id)) invalid();
      const entry = entryOf(row);
      historicalOwners(entry.payload);
      yield entry;
    }
  }
  const objectHistoryValidation = inspectSceneHistoryGraph(
    historyEntries(),
    reservations,
    historyObjects,
  );
  const rolls = new Set(data.rolls.map((roll) => roll.id));
  for (const row of records.roll_archive) {
    const roll = rollSchema.parse(JSON.parse(row.roll_json));
    if (
      roll.id !== row.id ||
      roll.ownerId !== row.owner_id ||
      roll.visibility !== row.visibility ||
      rolls.has(roll.id)
    )
      invalid();
    rolls.add(roll.id);
  }
  unique(records.chat_messages, (row) => String(row.sequence));
  for (const row of records.chat_messages) {
    const message = chatMessageSchema.parse(JSON.parse(row.message_json));
    subject(message.authorId);
    if (
      message.id !== row.id ||
      row.bucket !==
        (message.audience === "public" ? "public" : message.authorId)
    )
      invalid();
  }

  const system = systems.find(
    (item) => pinKey(item.manifest) === pinKey(campaign.system),
  );
  const systemStatus: PackageStatus =
    system &&
    catalog.systems.some((item) => pinKey(item) === pinKey(campaign.system))
      ? "available"
      : "unavailable";
  if (systemStatus !== "available") blockers.add("system_unavailable");
  const selected = new Set(campaign.contentPacks.map(pinKey));
  unique(archive.packages.contentPacks, pinKey);
  const packs = new Map(
    archive.packages.contentPacks.map((pin) => [pinKey(pin), pin]),
  );
  if (
    !same(
      [...selected].sort(),
      archive.packages.contentPacks
        .filter((pin) => pin.selected)
        .map(pinKey)
        .sort(),
    )
  )
    invalid();
  const referenced = new Set(selected);
  const packageChecks = archive.packages.contentPacks.map((pin) => {
    const installed = content.packs.find(
      ({ pack }) => pinKey(pack) === pinKey(pin),
    );
    const status: PackageStatus = !installed
      ? pin.selected
        ? "unavailable"
        : "historical-only"
      : installed.digest !== pin.sha256
        ? "changed"
        : !pin.selected
          ? "historical-only"
          : installed.pack.systemId !== campaign.system.id ||
              installed.pack.systemVersion !== campaign.system.version
            ? "incompatible"
            : "available";
    if (!["available", "historical-only"].includes(status))
      blockers.add(`content_pack_${status}`);
    return { ...pin, status };
  });
  const usablePack = (
    id: string,
    version: string,
    definitionId: string,
    active: boolean,
  ) => {
    const key = pinKey({ id, version }),
      pin = packs.get(key);
    referenced.add(key);
    if (!pin || (active && !selected.has(key))) invalid();
    const check = packageChecks.find((item) => pinKey(item) === key);
    if (check?.status !== "available") return null;
    try {
      return content.find({ packId: id, packVersion: version, definitionId });
    } catch {
      blockers.add("content_definition_unavailable");
      return null;
    }
  };
  for (const row of records.module_documents) {
    const document = documentSchema.parse({
      id: row.id,
      campaignId: campaign.id,
      title: row.title,
      ownerId: row.owner_id,
      visibility: row.visibility,
      system: { id: row.system_id, version: row.system_version },
      schemaVersion: row.schema_version,
      version: row.version,
      data: JSON.parse(row.data_json),
    });
    if (!same(document.system, campaign.system)) invalid();
    if (!system || row.schema_version !== system.documentVersion)
      blockers.add("document_schema_unavailable");
    else if (!system.documentSchema.safeParse(document.data).success) invalid();
  }
  for (const row of records.content_overrides) {
    const entry = usablePack(
      row.pack_id,
      row.pack_version,
      row.definition_id,
      row.data_json !== null,
    );
    if (row.data_json === null) {
      if (row.name !== null || row.visibility !== null) invalid();
      continue;
    }
    const saved = contentOverrideSchema
      .omit({ expectedRevision: true })
      .parse(JSON.parse(row.data_json));
    if (saved.name !== row.name || saved.visibility !== row.visibility)
      invalid();
    if (entry) validatedContentData(entry.dataSchema, saved.data);
  }
  for (const row of records.content_instances) {
    const instance = instanceSchema.parse({
      id: row.id,
      campaignId: campaign.id,
      ownerId: row.owner_id,
      name: row.name,
      kind: row.kind,
      visibility: row.visibility,
      system: { id: row.system_id, version: row.system_version },
      reference: {
        packId: row.pack_id,
        packVersion: row.pack_version,
        definitionId: row.definition_id,
      },
      definitionRevision: row.definition_revision,
      schemaVersion: row.schema_version,
      version: row.version,
      source: JSON.parse(row.source_json),
      data: JSON.parse(row.data_json),
    });
    if (
      !same(instance.system, campaign.system) ||
      instance.source.kind !== instance.kind
    )
      invalid();
    const entry = usablePack(
      row.pack_id,
      row.pack_version,
      row.definition_id,
      true,
    );
    if (entry) {
      if (
        !entry.instances ||
        entry.instances.schemaVersion !== row.schema_version
      )
        blockers.add("instance_schema_unavailable");
      else {
        validatedContentData(entry.instances.dataSchema, instance.data);
        validatedContentData(entry.dataSchema, instance.source.data);
      }
    }
  }
  if (
    referenced.size !== packs.size ||
    [...referenced].some((key) => !packs.has(key))
  )
    invalid();
  return {
    status: "preflight-only" as const,
    importReady: false as const,
    archiveSha256: createHash("sha256").update(serialized).digest("hex"),
    campaign: { id: campaign.id, name: campaign.name },
    resourceCounts: Object.fromEntries(
      Object.entries(records).map(([key, rows]) => [key, rows.length]),
    ),
    objectHistoryValidation,
    packages: {
      system: { ...campaign.system, status: systemStatus },
      contentPacks: packageChecks,
    },
    blockers: [...blockers].sort(),
    ownership: {
      policy: "explicit-mapping-required" as const,
      subjects: [...subjects.values()].sort((a, b) =>
        a.sourceId.localeCompare(b.sourceId),
      ),
    },
    pendingValidation: [
      "image-decoding",
      "module-external-references",
      "ownership-plan",
      "resource-id-plan",
      "mapped-storage-quotas",
      "mapped-history-graph",
      "atomic-import",
    ],
  };
}

/** Local identifiers are collisions to review, never automatic identity matches. */
function campaignTransferCollisions(
  db: DatabaseSync,
  archive: CampaignTransfer,
) {
  const tables = [
    "module_documents",
    "content_instances",
    "campaign_assets",
    "scene_history_entries",
  ] as const;
  const capacity = z
    .object({
      campaigns: z.number().int().nonnegative(),
      access: z.number().int().nonnegative(),
    })
    .parse(
      db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM campaign_records) AS campaigns,(SELECT COUNT(*) FROM access_campaigns) AS access",
        )
        .get(),
    );
  return {
    campaignCapacity: {
      used: capacity.campaigns,
      accessUsed: capacity.access,
      limit: MAX_CAMPAIGNS,
    },
    campaignIdExists: Boolean(
      db
        .prepare("SELECT 1 FROM campaign_records WHERE id=?")
        .get(archive.campaign.id),
    ),
    globalResourceIds: Object.fromEntries(
      tables.map((table) => {
        const statement = db.prepare(`SELECT 1 FROM ${table} WHERE id=?`);
        return [
          table,
          archive.records[table].filter((row) => statement.get(row.id)).length,
        ];
      }),
    ),
  };
}
