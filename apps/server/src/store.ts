import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createTable, restoreTable, tableSchema } from "@tableloom/core";
import type { TableState } from "@tableloom/core";
import {
  campaignSchema,
  campaignSettingsSchema,
  sceneSchema,
  sceneSettingsSchema,
  installedPackSchema,
  DEFAULT_CAMPAIGN_ID,
  DEFAULT_SCENE_ID,
  MAX_CAMPAIGNS,
  MAX_SCENES,
} from "@tableloom/core/campaigns";
import type {
  Campaign,
  CampaignSettings,
  Scene,
} from "@tableloom/core/campaigns";
import { moduleManifestSchema } from "@tableloom/module-sdk";
import type { ModuleManifest } from "@tableloom/module-sdk";
import { installedModules } from "./modules.js";
import { transaction } from "./database.js";

const campaignDataSchema = z
  .object({
    schemaVersion: z.literal(4),
    revision: tableSchema.shape.revision,
    rolls: tableSchema.shape.rolls,
    notes: tableSchema.shape.notes,
  })
  .strict();
const sceneDataSchema = z
  .object({
    drawings: tableSchema.shape.drawings,
    tokens: tableSchema.shape.tokens,
  })
  .strict();
type CampaignData = z.infer<typeof campaignDataSchema>;
type Pack = z.infer<typeof installedPackSchema>;
export interface InstalledCatalog {
  systems: readonly ModuleManifest[];
  contentPacks: readonly Pack[];
}
const json = (value: unknown): unknown => JSON.parse(z.string().parse(value));
const version = z.number().int().positive();

export class StoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

/** Trusted persistence boundary. Public campaign routes must authorize membership
 * and bind commands to a campaign/scene before calling these methods. */
export class TableStore {
  private readonly db: DatabaseSync;
  private readonly catalog: InstalledCatalog;
  private readonly ownsConnection: boolean;
  constructor(
    path: string | DatabaseSync,
    catalog: InstalledCatalog = { systems: installedModules, contentPacks: [] },
  ) {
    this.catalog = {
      systems: z.array(moduleManifestSchema).min(1).parse(catalog.systems),
      contentPacks: z.array(installedPackSchema).parse(catalog.contentPacks),
    };
    if (
      new Set(this.catalog.systems.map((system) => system.id)).size !==
      this.catalog.systems.length
    )
      throw new Error("Install one exact version of each system package.");
    if (
      new Set(
        this.catalog.contentPacks.map((pack) => `${pack.id}@${pack.version}`),
      ).size !== this.catalog.contentPacks.length
    )
      throw new Error("Installed content pack versions must be unique.");
    this.ownsConnection = typeof path === "string";
    this.db = typeof path === "string" ? new DatabaseSync(path) : path;
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      this.transaction(() => this.initialize());
    } catch (error) {
      if (this.ownsConnection) this.db.close();
      throw error;
    }
  }

  private initialize() {
    if (this.hasTable("campaign_storage_version")) {
      const stored = this.db
        .prepare("SELECT version FROM campaign_storage_version WHERE id = 1")
        .get();
      z.literal(1).parse(stored?.version);
      if (
        ["campaign_records", "scene_records", "campaign_receipts"].some(
          (name) => !this.hasTable(name),
        )
      )
        throw new Error("Campaign storage is incomplete.");
      if (this.hasTable("table_state") || this.hasTable("command_receipts"))
        throw new Error(
          "Legacy and campaign storage coexist. Restore a consistent backup before starting.",
        );
      return;
    }
    if (
      ["campaign_records", "scene_records", "campaign_receipts"].some((name) =>
        this.hasTable(name),
      )
    )
      throw new Error("Campaign storage is missing its schema version.");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS campaign_storage_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS campaign_records (
        id TEXT PRIMARY KEY, active_scene_id TEXT NOT NULL, json TEXT NOT NULL, state_json TEXT NOT NULL,
        FOREIGN KEY(id, active_scene_id) REFERENCES scene_records(campaign_id, id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE IF NOT EXISTS scene_records (
        campaign_id TEXT NOT NULL REFERENCES campaign_records(id), id TEXT NOT NULL,
        json TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(campaign_id, id)
      );
      CREATE TABLE IF NOT EXISTS campaign_receipts (
        campaign_id TEXT NOT NULL REFERENCES campaign_records(id), id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(campaign_id, id)
      );
      CREATE INDEX IF NOT EXISTS campaign_receipt_revision ON campaign_receipts(campaign_id, revision);`);
    const legacyTable = this.hasTable("table_state"),
      legacyReceipts = this.hasTable("command_receipts");
    if (legacyTable !== legacyReceipts)
      throw new Error("Legacy table storage is incomplete.");
    const row = legacyTable
      ? this.db.prepare("SELECT json FROM table_state WHERE id = 1").get()
      : undefined;
    const state = row ? restoreTable(json(row.json)).state : createTable();
    const system = this.pinFor(state.systemId);
    this.insertCampaign(
      campaignSettingsSchema.parse({
        name: "The gathering place",
        description: "",
        system,
        contentPacks: [],
      }),
      state,
      DEFAULT_CAMPAIGN_ID,
      DEFAULT_SCENE_ID,
    );
    if (legacyReceipts) {
      for (const receipt of this.db
        .prepare("SELECT id, revision FROM command_receipts")
        .all()) {
        const parsed = z
          .object({
            id: z.uuid(),
            revision: z.number().int().nonnegative().max(state.revision),
          })
          .parse(receipt);
        this.db
          .prepare(
            "INSERT INTO campaign_receipts(campaign_id, id, revision) VALUES (?, ?, ?)",
          )
          .run(DEFAULT_CAMPAIGN_ID, parsed.id, parsed.revision);
      }
      this.db.exec("DROP TABLE command_receipts; DROP TABLE table_state;");
    }
    this.db
      .prepare(
        "INSERT INTO campaign_storage_version(id, version) VALUES (1, 1)",
      )
      .run();
  }

  listCampaigns(): Campaign[] {
    return this.db
      .prepare("SELECT id FROM campaign_records ORDER BY id")
      .all()
      .map((row) => this.getCampaign(z.uuid().parse(row.id)));
  }
  getCampaign(id = DEFAULT_CAMPAIGN_ID): Campaign {
    z.uuid().parse(id);
    const row = this.db
      .prepare(
        "SELECT id, active_scene_id, json FROM campaign_records WHERE id = ?",
      )
      .get(id);
    if (!row) throw new StoreError("That campaign is unavailable.", 404);
    const campaign = campaignSchema.parse(json(row.json));
    if (
      campaign.id !== row.id ||
      campaign.activeSceneId !== row.active_scene_id
    )
      throw new Error("Campaign storage identifiers disagree.");
    this.validatePins(campaign);
    return campaign;
  }
  createCampaign(input: CampaignSettings): Campaign {
    const settings = campaignSettingsSchema.parse(input);
    this.validatePins(settings);
    return this.transaction(() => {
      if (
        Number(
          this.db
            .prepare("SELECT COUNT(*) AS count FROM campaign_records")
            .get()?.count,
        ) >= MAX_CAMPAIGNS
      )
        throw new StoreError(
          "This server has reached its campaign limit.",
          409,
        );
      return this.insertCampaign(
        settings,
        { ...createTable(), systemId: settings.system.id },
        randomUUID(),
        randomUUID(),
      );
    });
  }
  updateCampaign(
    id: string,
    expectedVersion: number,
    input: CampaignSettings,
  ): Campaign {
    const settings = campaignSettingsSchema.parse(input);
    this.validatePins(settings);
    version.parse(expectedVersion);
    return this.transaction(() => {
      const current = this.getCampaign(id);
      if (current.version !== expectedVersion)
        throw new StoreError(
          "Campaign settings changed. Reload before saving.",
          409,
        );
      this.assertDocumentPinCompatible(id, settings.system);
      const next = campaignSchema.parse({
        ...current,
        ...settings,
        version: current.version + 1,
      });
      const data = this.campaignData(id);
      data.revision += 1;
      this.writeCampaign(next, data);
      return next;
    });
  }
  listScenes(campaignId = DEFAULT_CAMPAIGN_ID): Scene[] {
    this.getCampaign(campaignId);
    return this.db
      .prepare("SELECT id FROM scene_records WHERE campaign_id = ? ORDER BY id")
      .all(campaignId)
      .map((row) => this.scene(campaignId, z.uuid().parse(row.id)).metadata);
  }
  getScene(campaignId: string, sceneId: string): Scene {
    this.getCampaign(campaignId);
    return this.scene(campaignId, sceneId).metadata;
  }
  createScene(campaignId: string, input: { name: string }): Scene {
    const settings = sceneSettingsSchema.parse(input);
    return this.transaction(() => {
      this.getCampaign(campaignId);
      if (
        Number(
          this.db
            .prepare(
              "SELECT COUNT(*) AS count FROM scene_records WHERE campaign_id = ?",
            )
            .get(campaignId)?.count,
        ) >= MAX_SCENES
      )
        throw new StoreError("This campaign has reached its scene limit.", 409);
      const scene = sceneSchema.parse({
        ...settings,
        id: randomUUID(),
        campaignId,
        version: 1,
      });
      this.insertScene(scene, { drawings: [], tokens: [] });
      return scene;
    });
  }
  activateScene(
    campaignId: string,
    sceneId: string,
    expectedVersion: number,
  ): Campaign {
    version.parse(expectedVersion);
    return this.transaction(() => {
      const current = this.getCampaign(campaignId);
      if (current.version !== expectedVersion)
        throw new StoreError(
          "Campaign settings changed. Reload before switching scenes.",
          409,
        );
      this.scene(campaignId, sceneId);
      if (current.activeSceneId === sceneId)
        throw new StoreError("That scene is already active.", 409);
      const next = campaignSchema.parse({
        ...current,
        activeSceneId: sceneId,
        version: current.version + 1,
      });
      const data = this.campaignData(campaignId);
      data.revision += 1;
      this.writeCampaign(next, data);
      return next;
    });
  }

  load(campaignId = DEFAULT_CAMPAIGN_ID): TableState {
    return this.transaction(() => {
      const campaign = this.getCampaign(campaignId);
      return tableSchema.parse({
        ...this.campaignData(campaignId),
        ...this.scene(campaignId, campaign.activeSceneId).data,
        systemId: campaign.system.id,
      });
    });
  }
  hasCommand(id: string, campaignId = DEFAULT_CAMPAIGN_ID): boolean {
    z.uuid().parse(id);
    z.uuid().parse(campaignId);
    return Boolean(
      this.db
        .prepare(
          "SELECT id FROM campaign_receipts WHERE campaign_id = ? AND id = ?",
        )
        .get(campaignId, id),
    );
  }
  save(
    input: TableState,
    commandId: string,
    campaignId = DEFAULT_CAMPAIGN_ID,
  ): void {
    const state = tableSchema.parse(input);
    z.uuid().parse(commandId);
    this.transaction(() => {
      const campaign = this.getCampaign(campaignId);
      const current = this.campaignData(campaignId);
      if (state.revision !== current.revision + 1)
        throw new Error("The campaign changed. Reload before saving.");
      // New campaign-wide notes cannot collide with an object in an inactive scene.
      const previousNotes = new Set(current.notes.map((note) => note.id));
      const newNoteIds = new Set(
        state.notes
          .filter((note) => !previousNotes.has(note.id))
          .map((note) => note.id),
      );
      if (newNoteIds.size) {
        for (const row of this.db
          .prepare(
            "SELECT state_json FROM scene_records WHERE campaign_id = ? AND id != ?",
          )
          .all(campaignId, campaign.activeSceneId)) {
          const scene = sceneDataSchema.parse(json(row.state_json));
          if (
            [...scene.drawings, ...scene.tokens].some((object) =>
              newNoteIds.has(object.id),
            )
          )
            throw new Error(
              "An object with this ID already exists in the campaign.",
            );
        }
      }
      let metadata = campaign;
      if (state.systemId !== campaign.system.id) {
        metadata = campaignSchema.parse({
          ...campaign,
          system: this.pinFor(state.systemId),
          version: campaign.version + 1,
        });
        this.validatePins(metadata);
        this.assertDocumentPinCompatible(campaignId, metadata.system);
      }
      this.writeCampaign(
        metadata,
        campaignDataSchema.parse({
          schemaVersion: state.schemaVersion,
          revision: state.revision,
          rolls: state.rolls,
          notes: state.notes,
        }),
      );
      this.db
        .prepare(
          "UPDATE scene_records SET state_json = ? WHERE campaign_id = ? AND id = ?",
        )
        .run(
          JSON.stringify({ drawings: state.drawings, tokens: state.tokens }),
          campaignId,
          campaign.activeSceneId,
        );
      this.db
        .prepare(
          "INSERT INTO campaign_receipts(campaign_id, id, revision) VALUES (?, ?, ?)",
        )
        .run(campaignId, commandId, state.revision);
      this.db
        .prepare(
          "DELETE FROM campaign_receipts WHERE campaign_id = ? AND revision < ?",
        )
        .run(campaignId, Math.max(0, state.revision - 10000));
    });
  }
  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  private insertCampaign(
    settings: CampaignSettings,
    state: TableState,
    id: string,
    sceneId: string,
  ): Campaign {
    this.validatePins(settings);
    const metadata = campaignSchema.parse({
      ...settings,
      id,
      activeSceneId: sceneId,
      version: 1,
    });
    const data = campaignDataSchema.parse({
      schemaVersion: state.schemaVersion,
      revision: state.revision,
      rolls: state.rolls,
      notes: state.notes,
    });
    this.db
      .prepare(
        "INSERT INTO campaign_records(id, active_scene_id, json, state_json) VALUES (?, ?, ?, ?)",
      )
      .run(id, sceneId, JSON.stringify(metadata), JSON.stringify(data));
    this.insertScene(
      sceneSchema.parse({
        id: sceneId,
        campaignId: id,
        name: "The gathering place",
        version: 1,
      }),
      { drawings: state.drawings, tokens: state.tokens },
    );
    return metadata;
  }
  private insertScene(metadata: Scene, data: z.infer<typeof sceneDataSchema>) {
    this.db
      .prepare(
        "INSERT INTO scene_records(campaign_id, id, json, state_json) VALUES (?, ?, ?, ?)",
      )
      .run(
        metadata.campaignId,
        metadata.id,
        JSON.stringify(metadata),
        JSON.stringify(sceneDataSchema.parse(data)),
      );
  }
  private scene(campaignId: string, id: string) {
    z.uuid().parse(id);
    const row = this.db
      .prepare(
        "SELECT json, state_json FROM scene_records WHERE campaign_id = ? AND id = ?",
      )
      .get(campaignId, id);
    if (!row)
      throw new StoreError("That scene is unavailable in this campaign.", 404);
    const metadata = sceneSchema.parse(json(row.json));
    if (metadata.id !== id || metadata.campaignId !== campaignId)
      throw new Error("Scene storage identifiers disagree.");
    return { metadata, data: sceneDataSchema.parse(json(row.state_json)) };
  }
  private campaignData(id: string): CampaignData {
    const row = this.db
      .prepare("SELECT state_json FROM campaign_records WHERE id = ?")
      .get(id);
    if (!row) throw new StoreError("That campaign is unavailable.", 404);
    return campaignDataSchema.parse(json(row.state_json));
  }
  private writeCampaign(metadata: Campaign, data: CampaignData) {
    this.db
      .prepare(
        "UPDATE campaign_records SET active_scene_id = ?, json = ?, state_json = ? WHERE id = ?",
      )
      .run(
        metadata.activeSceneId,
        JSON.stringify(metadata),
        JSON.stringify(campaignDataSchema.parse(data)),
        metadata.id,
      );
  }
  private pinFor(id: string) {
    const installed = this.catalog.systems.find((system) => system.id === id);
    if (!installed)
      throw new StoreError(`Install the required system package: ${id}.`, 400);
    return { id: installed.id, version: installed.version };
  }
  private validatePins(
    settings: Pick<CampaignSettings, "system" | "contentPacks">,
  ) {
    const system = this.catalog.systems.find(
      (system) =>
        system.id === settings.system.id &&
        system.version === settings.system.version,
    );
    if (!system)
      throw new StoreError(
        `Install the required system package: ${settings.system.id}@${settings.system.version}.`,
        400,
      );
    for (const pin of settings.contentPacks) {
      if (
        !this.catalog.contentPacks.some(
          (pack) =>
            pack.id === pin.id &&
            pack.version === pin.version &&
            pack.systemId === system.id,
        )
      )
        throw new StoreError(
          `Install a compatible content pack: ${pin.id}@${pin.version}.`,
          400,
        );
    }
  }
  private assertDocumentPinCompatible(
    campaignId: string,
    system: { id: string; version: string },
  ) {
    if (
      this.hasTable("module_documents") &&
      this.db
        .prepare(
          "SELECT id FROM module_documents WHERE campaign_id = ? AND (system_id != ? OR system_version != ?) LIMIT 1",
        )
        .get(campaignId, system.id, system.version)
    )
      throw new StoreError(
        "This campaign has system documents. An explicit document/package migration or removal is required before changing its system version.",
        409,
      );
  }
  private hasTable(name: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name),
    );
  }
  private transaction<T>(action: () => T): T {
    return transaction(this.db, action);
  }
}
