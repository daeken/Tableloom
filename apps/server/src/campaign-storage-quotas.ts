import { MAX_SCENES } from "@tableloom/core/campaigns";
import { MAX_CAMPAIGN_DOCUMENTS } from "@tableloom/core/documents";
import { MAX_CAMPAIGN_INSTANCES } from "@tableloom/core/instances";
import { MAX_CAMPAIGN_CONTENT_OVERRIDES } from "@tableloom/core/content";
import { MAX_ARCHIVED_ROLLS } from "@tableloom/core/roll-history";
import {
  MAX_CAMPAIGN_ASSETS,
  MAX_CAMPAIGN_ASSET_BYTES,
} from "@tableloom/core/assets";
import { MAX_CAMPAIGN_OBJECT_IDS } from "./object-identities.js";
import type { CampaignTransfer } from "./campaign-transfer-format.js";
import { StoreError } from "./store.js";
import {
  MAX_AUDIENCE_CHAT_MESSAGES,
  MAX_CAMPAIGN_CHAT_MESSAGES,
  MAX_MEMBER_SCENE_HISTORY,
  MAX_CAMPAIGN_SCENE_HISTORY,
  MAX_CAMPAIGN_HISTORY_BYTES,
  MAX_SCENE_MAP_HISTORY,
  MAX_CAMPAIGN_MAP_HISTORY,
  MAX_MAP_HISTORY_ENTRY_BYTES,
  MAX_CAMPAIGN_MAP_HISTORY_BYTES,
} from "./storage-limits.js";

const exceeded = () => {
  throw new StoreError("Campaign exceeds live storage limits.", 400);
};
function groups<T>(rows: readonly T[], key: (row: T) => string, limit: number) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = key(row),
      count = (counts.get(id) ?? 0) + 1;
    if (count > limit) exceeded();
    counts.set(id, count);
  }
}

/** Expects format-validated envelopes. Quotas do not certify payload semantics or import readiness. */
export function validateCampaignStorageQuotas(
  records: CampaignTransfer["records"],
): void {
  const counts: readonly [number, number][] = [
    [records.scene_records.length, MAX_SCENES],
    [records.module_documents.length, MAX_CAMPAIGN_DOCUMENTS],
    [records.content_instances.length, MAX_CAMPAIGN_INSTANCES],
    [records.content_overrides.length, MAX_CAMPAIGN_CONTENT_OVERRIDES],
    [records.campaign_assets.length, MAX_CAMPAIGN_ASSETS],
    [records.object_id_reservations.length, MAX_CAMPAIGN_OBJECT_IDS],
    [records.roll_archive.length, MAX_ARCHIVED_ROLLS],
    [records.scene_history_entries.length, MAX_CAMPAIGN_SCENE_HISTORY],
    [records.scene_background_history.length, MAX_CAMPAIGN_MAP_HISTORY],
    [records.chat_messages.length, MAX_CAMPAIGN_CHAT_MESSAGES],
  ];
  if (counts.some(([used, limit]) => used > limit)) exceeded();
  if (
    records.campaign_assets.reduce(
      (bytes, asset) => bytes + asset.byte_length,
      0,
    ) > MAX_CAMPAIGN_ASSET_BYTES
  )
    exceeded();
  groups(
    records.chat_messages,
    (row) => row.bucket,
    MAX_AUDIENCE_CHAT_MESSAGES,
  );
  groups(
    records.scene_history_entries,
    (row) => JSON.stringify([row.scene_id, row.actor_id]),
    MAX_MEMBER_SCENE_HISTORY,
  );
  groups(
    records.scene_background_history,
    (row) => row.scene_id,
    MAX_SCENE_MAP_HISTORY,
  );
  let historyBytes = 0;
  for (const row of records.scene_history_entries) {
    historyBytes +=
      Buffer.byteLength(row.payload_json, "utf8") +
      Buffer.byteLength(row.targets_json, "utf8");
    if (historyBytes > MAX_CAMPAIGN_HISTORY_BYTES) exceeded();
  }
  let mapBytes = 0;
  for (const row of records.scene_background_history) {
    const bytes = Buffer.byteLength(row.entry_json, "utf8");
    mapBytes += bytes;
    if (
      bytes > MAX_MAP_HISTORY_ENTRY_BYTES ||
      mapBytes > MAX_CAMPAIGN_MAP_HISTORY_BYTES
    )
      exceeded();
  }
}
