import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CampaignOwnershipReview } from "./campaign-ownership-plan.js";
import type { CampaignTransfer } from "./campaign-transfer-format.js";
import { MAX_CAMPAIGN_EXPORT_ROWS } from "./campaign-export.js";
import { campaignDataSchema } from "./campaign-preflight.js";
import { targetsSchema } from "./scene-history-model.js";
import { backgroundHistoryEntrySchema } from "./scene-map-history-model.js";
import { backgroundMapSchema } from "@tableloom/core/scene-map";
import { memberSchema } from "@tableloom/core/access";
import { StoreError } from "./store.js";
import { destinationSnapshot, type DestinationReadMode } from "./database.js";

export type OwnershipReview = CampaignOwnershipReview;
const kinds = [
  "campaign",
  "scene",
  "object",
  "document",
  "instance",
  "asset",
  "history",
  "map-history",
  "image",
  "roll",
  "chat",
  "member",
] as const;
export type ResourceKind = (typeof kinds)[number];
export const mapHistoryKey = (sceneId: string, id: string) =>
  `${sceneId}/${id}`;

/** Trusted callers supply an already checked source and complete ownership review. */
export function allocateCampaignResourceIds(
  source: CampaignTransfer,
  review: OwnershipReview,
  uuid: () => string = randomUUID,
) {
  const requested = new Map(kinds.map((kind) => [kind, new Set<string>()])),
    forbidden = new Set<string>(),
    freshIds = new Set<string>();
  let count = 0;
  const add = (kind: ResourceKind, key: string, sourceId = key) => {
    forbidden.add(sourceId);
    const ids = requested.get(kind)!;
    if (!ids.has(key)) {
      ids.add(key);
      if (++count > MAX_CAMPAIGN_EXPORT_ROWS * 4)
        throw new StoreError(
          "Campaign needs too many candidate identifiers.",
          409,
        );
    }
  };
  const records = source.records;
  add("campaign", source.campaign.id);
  for (const row of records.scene_records) add("scene", row.id);
  for (const row of records.object_id_reservations) add("object", row.id);
  for (const row of records.module_documents) add("document", row.id);
  for (const row of records.content_instances) add("instance", row.id);
  for (const row of records.campaign_assets) add("asset", row.id);
  for (const row of records.scene_history_entries) {
    add("history", row.id);
    for (const target of targetsSchema.parse(JSON.parse(row.targets_json)))
      if (target.previousId) add("history", target.previousId);
  }
  const image = (
    sceneId: string,
    map: z.infer<typeof backgroundMapSchema> | null,
  ) => {
    if (map) add("image", mapHistoryKey(sceneId, map.imageId), map.imageId);
  };
  for (const row of records.scene_backgrounds)
    image(
      row.scene_id,
      backgroundMapSchema.nullable().parse(JSON.parse(row.map_json)),
    );
  for (const row of records.scene_background_history) {
    add("map-history", mapHistoryKey(row.scene_id, row.id), row.id);
    const entry = backgroundHistoryEntrySchema.parse(
      JSON.parse(row.entry_json),
    );
    image(row.scene_id, entry.before);
    image(row.scene_id, entry.after);
  }
  const state = campaignDataSchema.parse(
    JSON.parse(records.campaign_records[0]!.state_json),
  );
  for (const roll of state.rolls) add("roll", roll.id);
  for (const row of records.roll_archive) add("roll", row.id);
  for (const row of records.chat_messages) add("chat", row.id);
  for (const row of [...records.campaign_receipts, ...records.command_bindings])
    forbidden.add(row.id);
  forbidden.add(review.ownershipReview.host.userId);
  const aliases = new Map<string, string>();
  for (const choice of review.ownershipReview.plan.assignments) {
    add("member", choice.sourceId);
    if (choice.target.kind === "existing") {
      aliases.set(choice.sourceId, choice.target.userId);
      forbidden.add(choice.target.userId);
    }
  }
  const mint = () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const id = z.uuid().parse(uuid());
      if (forbidden.has(id)) continue;
      forbidden.add(id);
      freshIds.add(id);
      return id;
    }
    throw new StoreError("Could not allocate fresh campaign identifiers.", 409);
  };
  const maps = new Map<ResourceKind, Map<string, string>>();
  for (const kind of kinds)
    maps.set(
      kind,
      new Map(
        [...requested.get(kind)!].map((id) => [
          id,
          kind === "member" && aliases.has(id) ? aliases.get(id)! : mint(),
        ]),
      ),
    );
  return {
    freshIds,
    counts: Object.fromEntries(
      [...maps].map(([kind, ids]) => [kind, ids.size]),
    ),
    get(kind: ResourceKind, id: string) {
      const result = maps.get(kind)?.get(id);
      if (!result)
        throw new StoreError("Candidate resource references are invalid.", 409);
      return result;
    },
  };
}
export type ResourceIds = ReturnType<typeof allocateCampaignResourceIds>;

/** Global primary keys must be free; scoped rows will live under a fresh campaign.
 * Batch indexed lookups rather than copying the destination's whole ID inventory. */
export function inspectCandidateIdentifiers(
  db: DatabaseSync,
  ids: ResourceIds,
  review: OwnershipReview,
  readMode: DestinationReadMode = "independent",
) {
  return destinationSnapshot(
    db,
    () => {
      const existing = new Set([
          review.ownershipReview.host.userId,
          ...review.ownershipReview.plan.assignments.flatMap((a) =>
            a.target.kind === "existing" ? [a.target.userId] : [],
          ),
        ]),
        person = db.prepare("SELECT id,name FROM access_users WHERE id=?"),
        people = new Map<string, string>();
      for (const id of existing) {
        const row = person.get(id);
        if (!row)
          throw new StoreError(
            "A reviewed local identity is unavailable.",
            409,
          );
        people.set(id, memberSchema.shape.name.parse(row.name));
      }
      const values = [...ids.freshIds],
        batchSize = 500;
      for (const table of [
        "campaign_records",
        "access_campaigns",
        "access_users",
        "module_documents",
        "content_instances",
        "campaign_assets",
        "scene_history_entries",
      ] as const) {
        const query = db.prepare(
          `SELECT 1 FROM ${table} WHERE id IN (${Array(batchSize).fill("?").join(",")}) LIMIT 1`,
        );
        for (let start = 0; start < values.length; start += batchSize) {
          const batch: (string | null)[] = values.slice(
            start,
            start + batchSize,
          );
          while (batch.length < batchSize) batch.push(null);
          if (query.get(...batch))
            throw new StoreError(
              "A candidate identifier is no longer available.",
              409,
            );
        }
      }
      // Active image capabilities have no ID index; their count is bounded by campaigns/scenes.
      for (const row of db
        .prepare(
          "SELECT image_id FROM scene_backgrounds WHERE image_id IS NOT NULL",
        )
        .iterate())
        if (typeof row.image_id === "string" && ids.freshIds.has(row.image_id))
          throw new StoreError(
            "A candidate image capability is no longer available.",
            409,
          );
      return people;
    },
    readMode,
  );
}
