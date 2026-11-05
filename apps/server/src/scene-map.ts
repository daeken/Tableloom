import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  backgroundMapSchema,
  backgroundViewSchema,
  backgroundStateSchema,
  backgroundSetSchema,
  backgroundVisibilitySchema,
  backgroundRemoveSchema,
} from "@tableloom/core/scene-map";
import type { Member } from "@tableloom/core/access";
import { memberSchema } from "@tableloom/core/access";
import type { CommandContext } from "@tableloom/core/campaigns";
import { contextKey } from "@tableloom/core/campaigns";
import { transaction } from "./database.js";
import { TableStore, StoreError } from "./store.js";
import { AssetStore } from "./assets.js";
export class SceneMapStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tables: TableStore,
    private readonly assets: AssetStore,
  ) {
    transaction(db, () => {
      const exists = (name: string) =>
        Boolean(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(name),
        );
      if (exists("scene_background_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM scene_background_version WHERE id=1")
            .get()?.version,
        );
        if (!exists("scene_backgrounds"))
          throw new Error("Background map storage is incomplete.");
        return;
      }
      if (exists("scene_backgrounds"))
        throw new Error("Background map storage is missing its version.");
      db.exec(`CREATE UNIQUE INDEX background_asset_scope ON campaign_assets(campaign_id,id);
        CREATE TABLE scene_background_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO scene_background_version VALUES(1,1);
        CREATE TABLE scene_backgrounds(campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),asset_id TEXT,image_id TEXT,map_json TEXT NOT NULL,PRIMARY KEY(campaign_id,scene_id),CHECK((asset_id IS NULL)=(image_id IS NULL)),FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_records(campaign_id,id) ON DELETE CASCADE,FOREIGN KEY(campaign_id,asset_id) REFERENCES campaign_assets(campaign_id,id));`);
    });
  }
  private member(actor: Member) {
    const parsed = memberSchema.parse(actor),
      row = this.db
        .prepare(
          "SELECT u.id,u.name,m.table_id AS tableId,m.role FROM access_users u JOIN access_memberships m ON m.user_id=u.id WHERE u.id=? AND m.table_id=?",
        )
        .get(parsed.id, parsed.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    return memberSchema.parse(row);
  }
  private current(actor: Member, context?: CommandContext) {
    const member = this.member(actor),
      campaign = this.tables.getCampaign(member.tableId),
      current = {
        campaignId: campaign.id,
        sceneId: campaign.activeSceneId,
        generation: campaign.version,
      };
    if (context && contextKey(current) !== contextKey(context))
      throw new StoreError(
        "The active scene changed. Reopen map settings.",
        409,
      );
    return { member, context: current };
  }
  private read(campaignId: string, sceneId: string) {
    const row = this.db
      .prepare(
        "SELECT version,asset_id,image_id,map_json FROM scene_backgrounds WHERE campaign_id=? AND scene_id=?",
      )
      .get(campaignId, sceneId);
    if (!row) return { version: 0, map: null };
    const version = z.number().int().positive().parse(row.version),
      map = backgroundMapSchema
        .nullable()
        .parse(JSON.parse(z.string().parse(row.map_json)));
    if (
      (map?.assetId ?? null) !== row.asset_id ||
      (map?.imageId ?? null) !== row.image_id
    )
      throw new Error("Stored background map references disagree.");
    if (
      map &&
      !this.db
        .prepare("SELECT id FROM campaign_assets WHERE campaign_id=? AND id=?")
        .get(campaignId, map.assetId)
    )
      throw new Error("Stored background asset is unavailable.");
    return { version, map };
  }
  controls(actor: Member) {
    return transaction(this.db, () => {
      const { member, context } = this.current(actor);
      if (member.role !== "gm")
        throw new StoreError("Only the GM can manage scene maps.", 403);
      return backgroundStateSchema.parse({
        context,
        ...this.read(member.tableId, context.sceneId),
      });
    });
  }
  project(actor: Member) {
    return transaction(this.db, () => {
      const { member, context } = this.current(actor),
        state = this.read(member.tableId, context.sceneId);
      return {
        background:
          state.map &&
          (member.role === "gm" || state.map.visibility === "public")
            ? backgroundViewSchema.parse({
                imageId: state.map.imageId,
                position: state.map.position,
                width: state.map.width,
                height: state.map.height,
                visibility: state.map.visibility,
              })
            : null,
        backgroundVersion: member.role === "gm" ? state.version : null,
      };
    });
  }
  private change(
    actor: Member,
    context: CommandContext,
    expectedVersion: number,
    update: (
      map: z.infer<typeof backgroundMapSchema> | null,
    ) => z.infer<typeof backgroundMapSchema> | null,
  ) {
    return transaction(this.db, () => {
      const current = this.current(actor, context);
      if (current.member.role !== "gm")
        throw new StoreError("Only the GM can manage scene maps.", 403);
      const state = this.read(current.member.tableId, context.sceneId);
      if (state.version !== expectedVersion)
        throw new StoreError(
          "This map changed. Reload map settings before trying again.",
          409,
        );
      const map = backgroundMapSchema.nullable().parse(update(state.map));
      this.db
        .prepare(
          "INSERT INTO scene_backgrounds(campaign_id,scene_id,version,asset_id,image_id,map_json) VALUES(?,?,?,?,?,?) ON CONFLICT(campaign_id,scene_id) DO UPDATE SET version=excluded.version,asset_id=excluded.asset_id,image_id=excluded.image_id,map_json=excluded.map_json",
        )
        .run(
          current.member.tableId,
          context.sceneId,
          state.version + 1,
          map?.assetId ?? null,
          map?.imageId ?? null,
          JSON.stringify(map),
        );
      return backgroundStateSchema.parse({
        context,
        version: state.version + 1,
        map,
      });
    });
  }
  set(actor: Member, input: unknown) {
    const command = backgroundSetSchema.parse(input);
    return this.change(
      actor,
      command.context,
      command.expectedVersion,
      (previous) => {
        const asset = this.assets.metadata(actor, command.assetId),
          height = (command.width * asset.height) / asset.width;
        if (
          previous?.assetId === asset.id &&
          previous.position.x === command.position.x &&
          previous.position.y === command.position.y &&
          previous.width === command.width
        )
          throw new StoreError("Change the map before saving.", 409);
        return {
          assetId: asset.id,
          imageId:
            previous?.assetId === asset.id ? previous.imageId : randomUUID(),
          position: command.position,
          width: command.width,
          height,
          visibility:
            previous?.assetId === asset.id ? previous.visibility : "gm",
        };
      },
    );
  }
  visibility(actor: Member, input: unknown) {
    const command = backgroundVisibilitySchema.parse(input);
    return this.change(
      actor,
      command.context,
      command.expectedVersion,
      (map) => {
        if (!map) throw new StoreError("There is no map to reveal.", 404);
        if (command.visibility === map.visibility)
          throw new StoreError("That visibility is already selected.", 409);
        if (
          command.visibility === "public" &&
          command.acknowledgeReveal !== true
        )
          throw new StoreError(
            "Confirm that this map will be revealed to every campaign member.",
            400,
          );
        return { ...map, visibility: command.visibility };
      },
    );
  }
  remove(actor: Member, input: unknown) {
    const command = backgroundRemoveSchema.parse(input);
    return this.change(
      actor,
      command.context,
      command.expectedVersion,
      (map) => {
        if (!map) throw new StoreError("There is no map to remove.", 404);
        return null;
      },
    );
  }
}
