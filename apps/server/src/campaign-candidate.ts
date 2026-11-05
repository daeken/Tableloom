import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { campaignSchema, sceneSchema } from "@tableloom/core/campaigns";
import { backgroundMapSchema } from "@tableloom/core/scene-map";
import { rollSchema } from "@tableloom/core";
import { chatMessageSchema } from "@tableloom/core/chat";
import { instanceSourceSchema } from "@tableloom/core/instances";
import { contentOverrideSchema } from "@tableloom/core/content";
import {
  remapCampaignDataReferences,
  type CampaignDataTransfer,
  type ServerSystemDefinition,
} from "@tableloom/module-sdk/server";
import type { ContentCatalog } from "./content-catalog.js";
import { StoreError } from "./store.js";
import { parseCampaignTransfer } from "./campaign-transfer-format.js";
import { campaignDataSchema, sceneDataSchema } from "./campaign-preflight.js";
import { entryOf, type Payload } from "./scene-history-model.js";
import { backgroundHistoryEntrySchema } from "./scene-map-history-model.js";
import {
  allocateCampaignResourceIds,
  inspectCandidateIdentifiers,
  mapHistoryKey,
  type OwnershipReview,
  type ResourceIds,
} from "./campaign-resource-ids.js";

function remapPayload(payload: Payload, ids: ResourceIds): Payload {
  const object = (id: string) => ids.get("object", id),
    owner = (id: string | null) => (id === null ? null : ids.get("member", id));
  if ("tokenOrder" in payload && payload.tokenOrder)
    payload.tokenOrder = payload.tokenOrder.map(object);
  if ("drawingOrder" in payload && payload.drawingOrder)
    payload.drawingOrder = payload.drawingOrder.map(object);
  switch (payload.kind) {
    case "create":
    case "delete":
      payload.object.id = object(payload.object.id);
      payload.object.ownerId = owner(payload.object.ownerId);
      break;
    case "delete-many":
      for (const saved of payload.objects) {
        saved.object.id = object(saved.object.id);
        saved.object.ownerId = owner(saved.object.ownerId);
      }
      break;
    case "translate":
      for (const original of payload.originals)
        original.objectId = object(original.objectId);
      break;
    case "resize-many":
      for (const change of payload.changes)
        change.objectId = object(change.objectId);
      break;
    case "move-many":
      for (const move of payload.moves) move.objectId = object(move.objectId);
      break;
    case "reorder":
      payload.before = payload.before.map(object);
      payload.after = payload.after.map(object);
      break;
    case "layer":
      payload.order = payload.order.map(object);
      break;
    case "move":
    case "resize":
    case "token-resize":
    case "text-update":
    case "shape-update":
      break;
    default: {
      const unsupported: never = payload;
      throw new Error(`Unsupported neutral history payload: ${unsupported}`);
    }
  }
  return payload;
}

/** Private in-memory storage candidate, never a downloadable campaign or authorization grant. */
export function buildCampaignCandidate(
  file: string,
  review: OwnershipReview,
  content: ContentCatalog,
  systems: readonly ServerSystemDefinition<unknown>[],
  db: DatabaseSync,
  uuid: () => string = randomUUID,
) {
  if (!review.ownershipReview.complete || review.blockers.length)
    throw new StoreError(
      "Complete source and ownership review before preparing a candidate.",
      409,
    );
  if (createHash("sha256").update(file).digest("hex") !== review.archiveSha256)
    throw new StoreError(
      "Candidate preparation belongs to a different file.",
      409,
    );
  const candidate = parseCampaignTransfer(file),
    ids = allocateCampaignResourceIds(candidate, review, uuid),
    people = inspectCandidateIdentifiers(db, ids, review),
    records = candidate.records,
    campaignId = ids.get("campaign", candidate.campaign.id),
    owner = (id: string | null) => (id === null ? null : ids.get("member", id)),
    object = (id: string) => ids.get("object", id);
  const memberships = new Map<
      string,
      { id: string; name: string; role: "gm" | "player" }
    >([
      [
        review.ownershipReview.host.userId,
        {
          id: review.ownershipReview.host.userId,
          name: people.get(review.ownershipReview.host.userId)!,
          role: "gm",
        },
      ],
    ]),
    newUsers: { id: string; name: string }[] = [];
  for (const assignment of review.ownershipReview.plan.assignments) {
    const target = assignment.target,
      id = ids.get("member", assignment.sourceId);
    if (target.kind === "unclaimed") continue;
    const name = target.kind === "existing" ? people.get(id)! : target.name;
    memberships.set(id, { id, name, role: target.role });
    if (target.kind === "new") newUsers.push({ id, name });
  }
  candidate.members = [...memberships.values()];
  candidate.campaign = {
    ...candidate.campaign,
    id: campaignId,
    activeSceneId: ids.get("scene", candidate.campaign.activeSceneId),
  };
  for (const rows of Object.values(records))
    for (const row of rows)
      if ("campaign_id" in row) row.campaign_id = campaignId;
  const data = campaignDataSchema.parse(
    JSON.parse(records.campaign_records[0]!.state_json),
  );
  for (const note of data.notes) {
    note.id = object(note.id);
    note.ownerId = ids.get("member", note.ownerId);
  }
  for (const roll of data.rolls) {
    roll.id = ids.get("roll", roll.id);
    roll.ownerId = owner(roll.ownerId);
  }
  const saved = records.campaign_records[0]!;
  saved.id = campaignId;
  saved.active_scene_id = candidate.campaign.activeSceneId;
  saved.json = JSON.stringify(campaignSchema.parse(candidate.campaign));
  saved.state_json = JSON.stringify(data);
  for (const row of records.scene_records) {
    const scene = sceneDataSchema.parse(JSON.parse(row.state_json)),
      metadata = sceneSchema.parse(JSON.parse(row.json));
    row.id = ids.get("scene", row.id);
    metadata.id = row.id;
    metadata.campaignId = campaignId;
    for (const item of [...scene.tokens, ...scene.drawings]) {
      item.id = object(item.id);
      item.ownerId = owner(item.ownerId);
    }
    row.json = JSON.stringify(metadata);
    row.state_json = JSON.stringify(scene);
  }
  // Old retries were issued against the source context; digests cannot be rebound without the original commands.
  const droppedRetries = {
    receipts: records.campaign_receipts.length,
    bindings: records.command_bindings.length,
  };
  records.campaign_receipts = [];
  records.command_bindings = [];
  for (const row of records.object_id_reservations) row.id = object(row.id);
  const remap = (policy: CampaignDataTransfer | undefined, data: unknown) => {
    if (!policy)
      throw new StoreError(
        "A required module transfer declaration is unavailable.",
        409,
      );
    try {
      return remapCampaignDataReferences(policy, data, (reference) =>
        reference.kind === "content"
          ? reference.value
          : ids.get(
              reference.kind === "token" ||
                reference.kind === "drawing" ||
                reference.kind === "note"
                ? "object"
                : reference.kind,
              reference.value,
            ),
      );
    } catch {
      throw new StoreError("Mapped module data is invalid.", 409);
    }
  };
  for (const row of records.module_documents) {
    const system = systems.find(
      (s) =>
        s.manifest.id === row.system_id &&
        s.manifest.version === row.system_version,
    );
    row.id = ids.get("document", row.id);
    row.owner_id = ids.get("member", row.owner_id);
    row.data_json = JSON.stringify(
      remap(system?.documentTransfer, JSON.parse(row.data_json)),
    );
  }
  for (const row of records.content_overrides) {
    if (row.data_json === null) continue;
    const entry = content.find({
        packId: row.pack_id,
        packVersion: row.pack_version,
        definitionId: row.definition_id,
      }),
      saved = contentOverrideSchema
        .omit({ expectedRevision: true })
        .parse(JSON.parse(row.data_json));
    saved.data = remap(entry.transfer, saved.data);
    row.data_json = JSON.stringify(saved);
  }
  for (const row of records.content_instances) {
    const entry = content.find({
        packId: row.pack_id,
        packVersion: row.pack_version,
        definitionId: row.definition_id,
      }),
      snapshot = instanceSourceSchema.parse(JSON.parse(row.source_json));
    row.id = ids.get("instance", row.id);
    row.owner_id = ids.get("member", row.owner_id);
    row.data_json = JSON.stringify(
      remap(entry.instances?.transfer, JSON.parse(row.data_json)),
    );
    snapshot.data = remap(entry.transfer, snapshot.data);
    row.source_json = JSON.stringify(snapshot);
  }
  for (const row of records.campaign_assets) row.id = ids.get("asset", row.id);
  const map = (
    sceneId: string,
    m: ReturnType<typeof backgroundMapSchema.parse> | null,
  ) =>
    m && {
      ...m,
      assetId: ids.get("asset", m.assetId),
      imageId: ids.get("image", mapHistoryKey(sceneId, m.imageId)),
    };
  for (const row of records.scene_backgrounds) {
    const oldScene = row.scene_id;
    row.scene_id = ids.get("scene", row.scene_id);
    const background = map(
      oldScene,
      backgroundMapSchema.nullable().parse(JSON.parse(row.map_json)),
    );
    row.asset_id = background?.assetId ?? null;
    row.image_id = background?.imageId ?? null;
    row.map_json = JSON.stringify(background);
  }
  for (const row of records.scene_background_history) {
    const oldScene = row.scene_id;
    const entry = backgroundHistoryEntrySchema.parse(
      JSON.parse(row.entry_json),
    );
    row.id = ids.get("map-history", mapHistoryKey(row.scene_id, row.id));
    row.scene_id = ids.get("scene", row.scene_id);
    entry.id = row.id;
    entry.before = map(oldScene, entry.before);
    entry.after = map(oldScene, entry.after);
    row.entry_json = JSON.stringify(entry);
  }
  for (const row of records.scene_background_history_refs) {
    row.entry_id = ids.get(
      "map-history",
      mapHistoryKey(row.scene_id, row.entry_id),
    );
    row.scene_id = ids.get("scene", row.scene_id);
    row.asset_id = ids.get("asset", row.asset_id);
  }
  for (const row of records.scene_grids)
    row.scene_id = ids.get("scene", row.scene_id);
  for (const row of records.scene_history_entries) {
    const entry = entryOf(row);
    row.id = ids.get("history", row.id);
    row.scene_id = ids.get("scene", row.scene_id);
    row.actor_id = ids.get("member", row.actor_id);
    row.targets_json = JSON.stringify(
      entry.targets.map((target) => ({
        ...target,
        objectId: object(target.objectId),
        previousId:
          target.previousId === null
            ? null
            : ids.get("history", target.previousId),
      })),
    );
    row.payload_json = JSON.stringify(remapPayload(entry.payload, ids));
  }
  for (const row of records.roll_archive) {
    const roll = rollSchema.parse(JSON.parse(row.roll_json));
    row.id = ids.get("roll", row.id);
    row.owner_id = owner(row.owner_id);
    roll.id = row.id;
    roll.ownerId = row.owner_id;
    row.roll_json = JSON.stringify(roll);
  }
  for (const row of records.chat_messages) {
    const message = chatMessageSchema.parse(JSON.parse(row.message_json));
    row.id = ids.get("chat", row.id);
    message.id = row.id;
    message.authorId = ids.get("member", message.authorId);
    row.bucket = message.audience === "public" ? "public" : message.authorId;
    row.message_json = JSON.stringify(message);
  }
  return {
    candidate,
    ids,
    newUsers,
    memberships: [...memberships.values()],
    droppedRetries,
  };
}
