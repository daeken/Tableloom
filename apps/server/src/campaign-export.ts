import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Member } from "@tableloom/core/access";
import { campaignSchema, versionPinSchema } from "@tableloom/core/campaigns";
import { StoreError, type TableStore } from "./store.js";
import type { ContentCatalog } from "./content-catalog.js";

export const MAX_CAMPAIGN_EXPORT_BYTES = 32 * 1024 * 1024;
export const MAX_CAMPAIGN_EXPORT_ROWS = 100_000;
const uuid = z.uuid(),
  positive = z.number().int().positive(),
  nonnegative = z.number().int().nonnegative(),
  text = z.string().max(MAX_CAMPAIGN_EXPORT_BYTES),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  visibility = z.enum(["public", "gm"]),
  json = text.refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid stored JSON.");

// Explicit columns: never export arbitrary tables, credentials or executable SQL.
// These are storage envelopes, not permission to accept their contents on import.
export const campaignExportTables = {
  campaign_records: z
    .object({ id: uuid, active_scene_id: uuid, json, state_json: json })
    .strict(),
  scene_records: z
    .object({ campaign_id: uuid, id: uuid, json, state_json: json })
    .strict(),
  campaign_receipts: z
    .object({ campaign_id: uuid, id: uuid, revision: nonnegative })
    .strict(),
  command_bindings: z
    .object({ campaign_id: uuid, id: uuid, actor_id: uuid, digest: hash })
    .strict(),
  object_id_reservations: z.object({ campaign_id: uuid, id: uuid }).strict(),
  module_documents: z
    .object({
      id: uuid,
      campaign_id: uuid,
      title: text,
      owner_id: uuid,
      visibility,
      system_id: text,
      system_version: text,
      schema_version: positive,
      version: positive,
      data_json: json,
    })
    .strict(),
  content_overrides: z
    .object({
      campaign_id: uuid,
      pack_id: text,
      pack_version: text,
      definition_id: text,
      revision: positive,
      name: text.nullable(),
      visibility: visibility.nullable(),
      data_json: json.nullable(),
    })
    .strict(),
  content_instances: z
    .object({
      id: uuid,
      campaign_id: uuid,
      owner_id: uuid,
      name: text,
      kind: text,
      visibility,
      system_id: text,
      system_version: text,
      pack_id: text,
      pack_version: text,
      definition_id: text,
      definition_revision: nonnegative,
      schema_version: positive,
      version: positive,
      source_json: json,
      data_json: json,
    })
    .strict(),
  campaign_assets: z
    .object({
      id: uuid,
      campaign_id: uuid,
      name: text,
      byte_length: positive.max(5 * 1024 * 1024),
      width: positive,
      height: positive,
      created_at: z.iso.datetime(),
      sha256: hash,
      bytes: text,
    })
    .strict(),
  scene_backgrounds: z
    .object({
      campaign_id: uuid,
      scene_id: uuid,
      version: positive,
      asset_id: uuid.nullable(),
      image_id: uuid.nullable(),
      map_json: json,
      history_cursor: nonnegative,
    })
    .strict(),
  scene_background_history: z
    .object({
      campaign_id: uuid,
      scene_id: uuid,
      id: uuid,
      seq: positive,
      entry_json: json,
    })
    .strict(),
  scene_background_history_refs: z
    .object({
      campaign_id: uuid,
      scene_id: uuid,
      entry_id: uuid,
      asset_id: uuid,
    })
    .strict(),
  scene_grids: z
    .object({
      campaign_id: uuid,
      scene_id: uuid,
      version: positive,
      settings_json: json,
    })
    .strict(),
  scene_history_entries: z
    .object({
      sequence: positive,
      id: uuid,
      campaign_id: uuid,
      scene_id: uuid,
      actor_id: uuid,
      state: z.enum(["done", "undone"]),
      version: positive,
      targets_json: json,
      payload_json: json,
    })
    .strict(),
  roll_archive: z
    .object({
      campaign_id: uuid,
      id: uuid,
      visibility,
      owner_id: uuid.nullable(),
      archived_at: z.iso.datetime(),
      roll_json: json,
    })
    .strict(),
  chat_messages: z
    .object({
      sequence: positive,
      campaign_id: uuid,
      id: uuid,
      bucket: text,
      message_json: json,
    })
    .strict(),
};
export const storageVersions = {
  campaign_storage_version: 8,
  command_binding_version: 1,
  object_identity_version: 1,
  document_storage_version: 1,
  content_storage_version: 1,
  instance_storage_version: 1,
  asset_storage_version: 1,
  scene_background_version: 2,
  scene_grid_version: 1,
  scene_history_version: 17,
  roll_archive_version: 1,
  chat_storage_version: 1,
} as const;
export const campaignExportRequestSchema = z
  .object({
    expectedVersion: positive,
    include: z.literal("all-campaign-content-including-private"),
  })
  .strict();
export const memberDescriptor = z
  .object({
    id: uuid,
    name: z.string().min(1).max(32),
    role: z.enum(["gm", "player"]),
  })
  .strict();
type Rows = {
  [K in keyof typeof campaignExportTables]: z.infer<
    (typeof campaignExportTables)[K]
  >[];
};

/** A bounded, private, single-campaign snapshot. Not an import validator or backup. */
export function exportCampaign(
  db: DatabaseSync,
  store: TableStore,
  catalog: ContentCatalog,
  actor: Member,
  input: z.input<typeof campaignExportRequestSchema>,
  now = Date.now(),
): string {
  const body = campaignExportRequestSchema.parse(input);
  uuid.parse(actor.id);
  uuid.parse(actor.tableId);
  if (db.isTransaction)
    throw new Error("Campaign export requires its own read snapshot.");
  db.exec("BEGIN");
  try {
    const membership = db
      .prepare(
        "SELECT role FROM access_memberships WHERE user_id=? AND table_id=?",
      )
      .get(actor.id, actor.tableId);
    if (membership?.role !== "gm")
      throw new StoreError("Campaign export requires GM access.", 403);
    const campaign = campaignSchema.parse(store.getCampaign(actor.tableId));
    if (campaign.version !== body.expectedVersion)
      throw new StoreError(
        "Campaign settings changed. Reload before exporting.",
        409,
      );
    const referencedPacks = new Map(
      campaign.contentPacks.map((pin) => [`${pin.id}@${pin.version}`, pin]),
    );
    // Reset tombstones can outlive selection of a pack. Retain their fingerprint
    // without pretending that historical code is selected or installed.
    for (const row of db
      .prepare(
        "SELECT pack_id AS id,pack_version AS version FROM content_overrides WHERE campaign_id=? UNION SELECT pack_id AS id,pack_version AS version FROM content_instances WHERE campaign_id=? LIMIT 1101",
      )
      .all(campaign.id, campaign.id)) {
      const pin = versionPinSchema.parse(row);
      referencedPacks.set(`${pin.id}@${pin.version}`, pin);
    }
    if (referencedPacks.size > 1100)
      throw new StoreError("Campaign exceeds the export package limit.", 409);
    const packages = {
      system: versionPinSchema.parse(campaign.system),
      contentPacks: [...referencedPacks.values()].map((pin) => {
        const selected = campaign.contentPacks.some(
          (current) => current.id === pin.id && current.version === pin.version,
        );
        const installed = catalog.packs.find(
          ({ pack }) => pack.id === pin.id && pack.version === pin.version,
        );
        const binding = db
          .prepare(
            "SELECT digest FROM content_pack_bindings WHERE pack_id=? AND pack_version=?",
          )
          .get(pin.id, pin.version);
        if (
          !binding ||
          (selected && !installed) ||
          (installed && binding.digest !== installed.digest)
        )
          throw new StoreError(
            "Required content pack is unavailable or changed.",
            409,
          );
        return {
          ...versionPinSchema.parse(pin),
          selected,
          sha256: hash.parse(binding.digest),
        };
      }),
    };
    // Fail closed on a newer feature instead of silently dropping its campaign data.
    for (const row of db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .iterate()) {
      const name = z.string().parse(row.name);
      const columns = db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(name)
        .map((column) => z.string().parse(column.name));
      if (
        columns.includes("campaign_id") &&
        !Object.hasOwn(campaignExportTables, name)
      )
        throw new StoreError(
          "Campaign storage needs a newer export implementation.",
          409,
        );
    }
    for (const [table, expected] of Object.entries(storageVersions)) {
      const marker = db
        .prepare(`SELECT version FROM ${table} WHERE id=1`)
        .get();
      if (marker?.version !== expected)
        throw new StoreError(
          "Campaign storage version is unsupported for export.",
          409,
        );
    }
    const members = z
      .array(memberDescriptor)
      .max(1000)
      .parse(
        db
          .prepare(
            "SELECT u.id,u.name,m.role FROM access_users u JOIN access_memberships m ON m.user_id=u.id WHERE m.table_id=? ORDER BY u.id LIMIT 1001",
          )
          .all(campaign.id),
      );
    const rows: Partial<Rows> = {};
    let bytes =
        Buffer.byteLength(
          JSON.stringify({ campaign, packages, members, storageVersions }),
        ) + 4096,
      count = 0;
    for (const [table, schema] of Object.entries(campaignExportTables)) {
      const columns = Object.keys(schema.shape);
      const actual = db
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((column) => z.string().parse(column.name));
      if (
        actual.length !== columns.length ||
        actual.some((name) => !columns.includes(name))
      )
        throw new StoreError(
          "Campaign storage columns are unsupported for export.",
          409,
        );
      const scoped = table === "campaign_records" ? "id" : "campaign_id";
      const sizing = db
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(${columns.map((name) => `COALESCE(length(CAST(${name} AS BLOB)),0)`).join("+")}),0) AS bytes FROM ${table} WHERE ${scoped}=?`,
        )
        .get(campaign.id);
      if (
        Number(sizing?.count) + count > MAX_CAMPAIGN_EXPORT_ROWS ||
        Number(sizing?.bytes) > MAX_CAMPAIGN_EXPORT_BYTES
      )
        throw new StoreError(
          "Campaign exceeds export limits. Use a whole-instance backup.",
          409,
        );
      const records: unknown[] = [];
      // Identifiers come only from the fixed schemas above, never from requests/archive data.
      for (const raw of db
        .prepare(
          `SELECT ${columns.join(",")} FROM ${table} WHERE ${scoped}=? ORDER BY rowid`,
        )
        .iterate(campaign.id)) {
        if (++count > MAX_CAMPAIGN_EXPORT_ROWS)
          throw new StoreError(
            "Campaign exceeds the export row limit. Use a whole-instance backup.",
            409,
          );
        if (table === "campaign_assets") {
          if (
            !(raw.bytes instanceof Uint8Array) ||
            raw.bytes.length !== raw.byte_length ||
            createHash("sha256").update(raw.bytes).digest("hex") !== raw.sha256
          )
            throw new StoreError(
              "Campaign image storage is inconsistent.",
              409,
            );
          raw.bytes = Buffer.from(raw.bytes).toString("base64");
        }
        const record = schema.parse(raw);
        if (
          "system_id" in record &&
          "system_version" in record &&
          (record.system_id !== campaign.system.id ||
            record.system_version !== campaign.system.version)
        )
          throw new StoreError(
            "Stored document system pins disagree with the campaign.",
            409,
          );
        if (
          (table === "content_instances" ||
            (table === "content_overrides" &&
              "data_json" in record &&
              record.data_json !== null)) &&
          "pack_id" in record &&
          !campaign.contentPacks.some(
            (pin) =>
              pin.id === record.pack_id && pin.version === record.pack_version,
          )
        )
          throw new StoreError(
            "Stored content requires an unselected pack.",
            409,
          );
        bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
        if (bytes > MAX_CAMPAIGN_EXPORT_BYTES)
          throw new StoreError(
            "Campaign exceeds the 32-MiB export limit. Use a whole-instance backup.",
            409,
          );
        records.push(record);
      }
      Object.assign(rows, { [table]: records });
    }
    const result = JSON.stringify({
      format: "tableloom-campaign-export",
      version: 1,
      createdAt: z.iso.datetime().parse(new Date(now).toISOString()),
      privacy: "all-campaign-content-including-private",
      identityPolicy: "source-identifiers-without-access-grants",
      assetEncoding: "base64",
      campaign,
      packages,
      members,
      storageVersions,
      records: rows,
    });
    if (Buffer.byteLength(result) > MAX_CAMPAIGN_EXPORT_BYTES)
      throw new StoreError("Campaign exceeds the export size limit.", 409);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
