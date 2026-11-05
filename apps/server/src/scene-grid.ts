import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { memberSchema, type Member } from "@tableloom/core/access";
import { contextKey, type CommandContext } from "@tableloom/core/campaigns";
import {
  DEFAULT_GRID,
  gridSettingsSchema,
  sceneGridSchema,
  gridStateSchema,
  gridUpdateSchema,
  sameGrid,
} from "@tableloom/core/scene-grid";
import { transaction } from "./database.js";
import { TableStore, StoreError } from "./store.js";

export class SceneGridStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tables: TableStore,
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
      if (exists("scene_grid_version")) {
        z.literal(1).parse(
          db.prepare("SELECT version FROM scene_grid_version WHERE id=1").get()
            ?.version,
        );
        if (!exists("scene_grids"))
          throw new Error("Scene grid storage is incomplete.");
        // Validate even offstage overrides at startup; do not silently repair corruption.
        for (const row of db
          .prepare(
            "SELECT campaign_id,scene_id,version,settings_json FROM scene_grids",
          )
          .all()) {
          const campaignId = z.uuid().parse(row.campaign_id),
            sceneId = z.uuid().parse(row.scene_id);
          tables.getScene(campaignId, sceneId);
          this.parse(row);
        }
        return;
      }
      if (exists("scene_grids"))
        throw new Error("Scene grid storage is missing its version.");
      db.exec(`CREATE TABLE scene_grid_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        INSERT INTO scene_grid_version VALUES(1,1);
        CREATE TABLE scene_grids(campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),settings_json TEXT NOT NULL,PRIMARY KEY(campaign_id,scene_id),FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_records(campaign_id,id) ON DELETE CASCADE);`);
    });
  }
  private parse(row: Record<string, unknown>) {
    return sceneGridSchema.parse({
      version: z.number().int().positive().parse(row.version),
      settings: gridSettingsSchema.parse(
        JSON.parse(z.string().parse(row.settings_json)),
      ),
    });
  }
  private current(actor: Member, expected?: CommandContext) {
    const parsed = memberSchema.parse(actor),
      row = this.db
        .prepare(
          "SELECT u.id,u.name,m.table_id AS tableId,m.role FROM access_users u JOIN access_memberships m ON m.user_id=u.id WHERE u.id=? AND m.table_id=?",
        )
        .get(parsed.id, parsed.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    const member = memberSchema.parse(row),
      campaign = this.tables.getCampaign(member.tableId),
      context = {
        campaignId: campaign.id,
        sceneId: campaign.activeSceneId,
        generation: campaign.version,
      };
    if (expected && contextKey(expected) !== contextKey(context))
      throw new StoreError(
        "The active scene changed. Reopen grid settings.",
        409,
      );
    return { member, context };
  }
  private read(campaignId: string, sceneId: string) {
    const row = this.db
      .prepare(
        "SELECT version,settings_json FROM scene_grids WHERE campaign_id=? AND scene_id=?",
      )
      .get(campaignId, sceneId);
    return row
      ? this.parse(row)
      : sceneGridSchema.parse({ version: 0, settings: DEFAULT_GRID });
  }
  controls(actor: Member) {
    return transaction(this.db, () => {
      const { member, context } = this.current(actor);
      return gridStateSchema.parse({
        ...this.read(member.tableId, context.sceneId),
        context,
      });
    });
  }
  project(actor: Member) {
    const { context: _, ...grid } = this.controls(actor);
    return grid;
  }
  update(actor: Member, input: unknown) {
    const command = gridUpdateSchema.parse(input);
    return transaction(this.db, () => {
      const { member, context } = this.current(actor, command.context);
      if (member.role !== "gm")
        throw new StoreError("Only the GM can change the shared grid.", 403);
      const state = this.read(member.tableId, context.sceneId);
      if (state.version !== command.expectedVersion)
        throw new StoreError(
          "This grid changed. Reopen grid settings before saving.",
          409,
        );
      if (sameGrid(state.settings, command.settings))
        throw new StoreError("Change the grid before saving.", 409);
      const version = sceneGridSchema.shape.version.parse(state.version + 1);
      this.db
        .prepare(
          "INSERT INTO scene_grids(campaign_id,scene_id,version,settings_json) VALUES(?,?,?,?) ON CONFLICT(campaign_id,scene_id) DO UPDATE SET version=excluded.version,settings_json=excluded.settings_json",
        )
        .run(
          member.tableId,
          context.sceneId,
          version,
          JSON.stringify(command.settings),
        );
      return gridStateSchema.parse({
        context,
        version,
        settings: command.settings,
      });
    });
  }
}
