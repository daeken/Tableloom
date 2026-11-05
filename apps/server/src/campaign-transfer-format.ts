import { z } from "zod";
import {
  campaignSchema,
  versionPinSchema,
  MAX_SCENES,
} from "@tableloom/core/campaigns";
import { MAX_CAMPAIGN_DOCUMENTS } from "@tableloom/core/documents";
import { MAX_CAMPAIGN_INSTANCES } from "@tableloom/core/instances";
import { MAX_CAMPAIGN_ASSETS } from "@tableloom/core/assets";
import { MAX_CAMPAIGN_CONTENT_OVERRIDES } from "@tableloom/core/content";
import { MAX_ARCHIVED_ROLLS } from "@tableloom/core/roll-history";
import {
  MAX_CAMPAIGN_CHAT_MESSAGES,
  MAX_CAMPAIGN_SCENE_HISTORY,
  MAX_CAMPAIGN_MAP_HISTORY,
} from "./storage-limits.js";
import { StoreError } from "./store.js";
import {
  campaignExportTables as tables,
  storageVersions,
  memberDescriptor,
  MAX_CAMPAIGN_EXPORT_BYTES,
  MAX_CAMPAIGN_EXPORT_ROWS,
} from "./campaign-export.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const versionsSchema = z
  .object({
    campaign_storage_version: z.literal(
      storageVersions.campaign_storage_version,
    ),
    command_binding_version: z.literal(storageVersions.command_binding_version),
    object_identity_version: z.literal(storageVersions.object_identity_version),
    document_storage_version: z.literal(
      storageVersions.document_storage_version,
    ),
    content_storage_version: z.literal(storageVersions.content_storage_version),
    instance_storage_version: z.literal(
      storageVersions.instance_storage_version,
    ),
    asset_storage_version: z.literal(storageVersions.asset_storage_version),
    scene_background_version: z.literal(
      storageVersions.scene_background_version,
    ),
    scene_grid_version: z.literal(storageVersions.scene_grid_version),
    scene_history_version: z.literal(storageVersions.scene_history_version),
    roll_archive_version: z.literal(storageVersions.roll_archive_version),
    chat_storage_version: z.literal(storageVersions.chat_storage_version),
  })
  .strict();
const recordsSchema = z
  .object({
    campaign_records: z.array(tables.campaign_records).length(1),
    scene_records: z.array(tables.scene_records).min(1).max(MAX_SCENES),
    campaign_receipts: z
      .array(tables.campaign_receipts)
      .max(MAX_CAMPAIGN_EXPORT_ROWS),
    command_bindings: z
      .array(tables.command_bindings)
      .max(MAX_CAMPAIGN_EXPORT_ROWS),
    object_id_reservations: z
      .array(tables.object_id_reservations)
      .max(MAX_CAMPAIGN_EXPORT_ROWS),
    module_documents: z
      .array(tables.module_documents)
      .max(MAX_CAMPAIGN_DOCUMENTS),
    content_overrides: z
      .array(tables.content_overrides)
      .max(MAX_CAMPAIGN_CONTENT_OVERRIDES),
    content_instances: z
      .array(tables.content_instances)
      .max(MAX_CAMPAIGN_INSTANCES),
    campaign_assets: z.array(tables.campaign_assets).max(MAX_CAMPAIGN_ASSETS),
    scene_backgrounds: z.array(tables.scene_backgrounds).max(MAX_SCENES),
    scene_background_history: z
      .array(tables.scene_background_history)
      .max(MAX_CAMPAIGN_MAP_HISTORY),
    scene_background_history_refs: z
      .array(tables.scene_background_history_refs)
      .max(2 * MAX_CAMPAIGN_MAP_HISTORY),
    scene_grids: z.array(tables.scene_grids).max(MAX_SCENES),
    scene_history_entries: z
      .array(tables.scene_history_entries)
      .max(MAX_CAMPAIGN_SCENE_HISTORY),
    roll_archive: z.array(tables.roll_archive).max(MAX_ARCHIVED_ROLLS),
    chat_messages: z
      .array(tables.chat_messages)
      .max(MAX_CAMPAIGN_CHAT_MESSAGES),
  })
  .strict();
export const campaignTransferSchema = z
  .object({
    format: z.literal("tableloom-campaign-export"),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    privacy: z.literal("all-campaign-content-including-private"),
    identityPolicy: z.literal("source-identifiers-without-access-grants"),
    assetEncoding: z.literal("base64"),
    campaign: campaignSchema,
    packages: z
      .object({
        system: versionPinSchema,
        contentPacks: z
          .array(
            versionPinSchema
              .extend({ selected: z.boolean(), sha256: hash })
              .strict(),
          )
          .max(1100),
      })
      .strict(),
    members: z.array(memberDescriptor).max(1000),
    storageVersions: versionsSchema,
    records: recordsSchema,
  })
  .strict();
export type CampaignTransfer = z.infer<typeof campaignTransferSchema>;

/** Parse a bounded JSON file, never executable SQL or a JavaScript object supplied by a module. */
export function parseCampaignTransfer(serialized: string): CampaignTransfer {
  if (Buffer.byteLength(serialized) > MAX_CAMPAIGN_EXPORT_BYTES)
    throw new StoreError("Campaign file exceeds 32 MiB.", 400);
  try {
    const raw: unknown = JSON.parse(serialized);
    // Charge the total before per-row schemas clone/parse individual records.
    const head = z
      .object({ records: z.record(z.string(), z.unknown()) })
      .parse(raw);
    let count = 0;
    for (const rows of Object.values(head.records)) {
      if (
        !Array.isArray(rows) ||
        (count += rows.length) > MAX_CAMPAIGN_EXPORT_ROWS
      )
        throw new Error("Invalid row count");
    }
    return campaignTransferSchema.parse(raw);
  } catch {
    throw new StoreError(
      "Campaign file has an invalid or unsupported format.",
      400,
    );
  }
}
