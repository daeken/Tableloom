import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import {
  MAX_CAMPAIGN_INSTANCES,
  instanceMetadataSchema,
  instanceSourceSchema,
  instanceSchema,
  instanceCreateSchema,
  instanceUpdateSchema,
  instancePageSchema,
} from "@tableloom/core/instances";
import type {
  InstanceMetadata,
  OwnedContentInstance,
} from "@tableloom/core/instances";
import { TableStore, StoreError } from "./store.js";
import { transaction } from "./database.js";
import { ContentCatalog, validatedContentData } from "./content-catalog.js";
import { CampaignContentStore } from "./content.js";

type Row = Record<string, unknown>;
const columns = `id, campaign_id AS campaignId, owner_id AS ownerId, name, kind, visibility,
  system_id AS systemId, system_version AS systemVersion, pack_id AS packId,
  pack_version AS packVersion, definition_id AS definitionId, definition_revision AS definitionRevision,
  schema_version AS schemaVersion, version`;
const version = z.number().int().positive();

/** Borrowed connection: permission, source resolution and writes share one transaction. */
export class ContentInstanceStore {
  constructor(
    private db: DatabaseSync,
    private campaigns: TableStore,
    private catalog: ContentCatalog,
    private content: CampaignContentStore,
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
      if (exists("instance_storage_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM instance_storage_version WHERE id=1")
            .get()?.version,
        );
        if (!exists("content_instances"))
          throw new Error("Instance storage is incomplete.");
      } else {
        if (exists("content_instances"))
          throw new Error("Instance storage is missing its schema version.");
        db.exec(`CREATE TABLE instance_storage_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
          INSERT INTO instance_storage_version VALUES(1,1);
          CREATE TABLE content_instances(
            id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign_records(id),
            owner_id TEXT NOT NULL REFERENCES access_users(id), name TEXT NOT NULL, kind TEXT NOT NULL,
            visibility TEXT NOT NULL CHECK(visibility IN ('gm','public')),
            system_id TEXT NOT NULL,system_version TEXT NOT NULL,
            pack_id TEXT NOT NULL,pack_version TEXT NOT NULL,definition_id TEXT NOT NULL,
            definition_revision INTEGER NOT NULL CHECK(definition_revision>=0),
            schema_version INTEGER NOT NULL CHECK(schema_version>0),version INTEGER NOT NULL CHECK(version>0),
            source_json TEXT NOT NULL,data_json TEXT NOT NULL);
          CREATE INDEX instance_campaign_page ON content_instances(campaign_id,id);
          CREATE INDEX instance_campaign_owner ON content_instances(campaign_id,owner_id,id);`);
      }
    });
  }
  private member(actor: Member) {
    z.uuid().parse(actor.id);
    z.uuid().parse(actor.tableId);
    const row = this.db
      .prepare(
        `SELECT u.id,u.name,m.table_id AS tableId,m.role
      FROM access_memberships m JOIN access_users u ON u.id=m.user_id WHERE m.user_id=? AND m.table_id=?`,
      )
      .get(actor.id, actor.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    return memberSchema.parse(row);
  }
  private metadata(row: Row): InstanceMetadata {
    return instanceMetadataSchema.parse({
      id: row.id,
      campaignId: row.campaignId,
      ownerId: row.ownerId,
      name: row.name,
      kind: row.kind,
      visibility: row.visibility,
      system: { id: row.systemId, version: row.systemVersion },
      reference: {
        packId: row.packId,
        packVersion: row.packVersion,
        definitionId: row.definitionId,
      },
      definitionRevision: row.definitionRevision,
      schemaVersion: row.schemaVersion,
      version: row.version,
    });
  }
  private visible(member: Member, id: string) {
    z.uuid().parse(id);
    const row = this.db
      .prepare(
        `SELECT ${columns},source_json,data_json FROM content_instances
      WHERE id=? AND campaign_id=? AND (?='gm' OR visibility='public' OR owner_id=?)`,
      )
      .get(id, member.tableId, member.role, member.id);
    if (!row)
      throw new StoreError("That content instance is unavailable.", 404);
    return row;
  }
  private editable(
    member: Member,
    metadata: InstanceMetadata,
    expectedVersion: number,
  ) {
    if (member.role !== "gm" && member.id !== metadata.ownerId)
      throw new StoreError(
        "Only the owner or GM can change this instance.",
        403,
      );
    if (metadata.version !== expectedVersion)
      throw new StoreError(
        "This instance changed. Refresh before editing or deleting.",
        409,
      );
  }
  private binding(metadata: InstanceMetadata) {
    const campaign = this.campaigns.getCampaign(metadata.campaignId);
    if (
      campaign.system.id !== metadata.system.id ||
      campaign.system.version !== metadata.system.version ||
      !campaign.contentPacks.some(
        (p) =>
          p.id === metadata.reference.packId &&
          p.version === metadata.reference.packVersion,
      )
    )
      throw new StoreError("Instance and campaign package pins disagree.", 409);
    let entry;
    try {
      entry = this.catalog.find(metadata.reference);
    } catch {
      throw new StoreError(
        "The exact instance content pack is not installed.",
        409,
      );
    }
    if (
      entry.pack.systemId !== metadata.system.id ||
      entry.pack.systemVersion !== metadata.system.version ||
      !entry.instances ||
      entry.instances.schemaVersion !== metadata.schemaVersion
    )
      throw new StoreError(
        "The exact instance schema is not installed. Explicit migration is required.",
        409,
      );
    return { ...entry, instances: entry.instances };
  }
  private view(row: Row): OwnedContentInstance {
    const metadata = this.metadata(row),
      binding = this.binding(metadata);
    const source = instanceSourceSchema.parse(
        JSON.parse(z.string().parse(row.source_json)),
      ),
      data = JSON.parse(z.string().parse(row.data_json));
    if (source.kind !== metadata.kind)
      throw new Error("Stored instance source is invalid.");
    validatedContentData(binding.dataSchema, source.data);
    validatedContentData(binding.instances.dataSchema, data);
    return instanceSchema.parse({ ...metadata, source, data });
  }
  create(
    actor: Member,
    input: z.input<typeof instanceCreateSchema>,
  ): OwnedContentInstance {
    const body = instanceCreateSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor),
        definition = this.content.get(member, body.reference);
      if (definition.revision !== body.expectedRevision)
        throw new StoreError(
          "This definition changed. Refresh before creating an instance.",
          409,
        );
      const entry = this.catalog.find(body.reference);
      if (!entry.instances)
        throw new StoreError(
          "This pack does not support owned instances.",
          400,
        );
      const count = this.db
        .prepare("SELECT count(*) n FROM content_instances WHERE campaign_id=?")
        .get(member.tableId);
      if (Number(count?.n) >= MAX_CAMPAIGN_INSTANCES)
        throw new StoreError(
          "This campaign has reached its instance limit.",
          409,
        );
      let data;
      try {
        data = validatedContentData(
          entry.instances.dataSchema,
          entry.instances.create(structuredClone(definition.data)),
          true,
        );
      } catch {
        throw new StoreError(
          "The instance factory failed or returned invalid data. No changes were saved.",
          400,
        );
      }
      const instance = instanceSchema.parse({
        id: randomUUID(),
        campaignId: member.tableId,
        ownerId: member.id,
        name: definition.name,
        kind: definition.kind,
        visibility: "gm",
        system: definition.system,
        reference: body.reference,
        definitionRevision: definition.revision,
        schemaVersion: entry.instances.schemaVersion,
        version: 1,
        source: {
          name: definition.name,
          kind: definition.kind,
          data: definition.data,
          sources: definition.sources,
        },
        data,
      });
      this.db
        .prepare(
          `INSERT INTO content_instances(id,campaign_id,owner_id,name,kind,visibility,system_id,system_version,
        pack_id,pack_version,definition_id,definition_revision,schema_version,version,source_json,data_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          instance.id,
          instance.campaignId,
          instance.ownerId,
          instance.name,
          instance.kind,
          instance.visibility,
          instance.system.id,
          instance.system.version,
          instance.reference.packId,
          instance.reference.packVersion,
          instance.reference.definitionId,
          instance.definitionRevision,
          instance.schemaVersion,
          instance.version,
          JSON.stringify(instance.source),
          JSON.stringify(instance.data),
        );
      return instance;
    });
  }
  list(actor: Member, input: { after?: string; limit?: number } = {}) {
    const query = z
      .object({
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .strict()
      .parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor);
      const rows = this.db
        .prepare(
          `SELECT ${columns} FROM content_instances WHERE campaign_id=?
        AND (?='gm' OR visibility='public' OR owner_id=?) AND id>? ORDER BY id LIMIT ?`,
        )
        .all(
          member.tableId,
          member.role,
          member.id,
          query.after ?? "",
          query.limit + 1,
        );
      const instances = rows
        .slice(0, query.limit)
        .map((row) => this.metadata(row));
      return instancePageSchema.parse({
        instances,
        next: rows.length > query.limit ? instances.at(-1)!.id : null,
      });
    });
  }
  get(actor: Member, id: string): OwnedContentInstance {
    return transaction(this.db, () =>
      this.view(this.visible(this.member(actor), id)),
    );
  }
  update(
    actor: Member,
    id: string,
    input: z.input<typeof instanceUpdateSchema>,
  ): OwnedContentInstance {
    const body = instanceUpdateSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor),
        row = this.visible(member, id),
        metadata = this.metadata(row);
      this.editable(member, metadata, body.expectedVersion);
      // Validate the immutable saved source and old state before accepting a transition.
      const current = this.view(row);
      const binding = this.binding(metadata);
      let data;
      try {
        data = validatedContentData(
          binding.instances.dataSchema,
          body.data,
          true,
        );
      } catch {
        throw new StoreError("Instance data is invalid for this pack.", 400);
      }
      const next = instanceSchema.parse({
        ...current,
        name: body.name,
        visibility: body.visibility,
        data,
        version: metadata.version + 1,
      });
      this.db
        .prepare(
          "UPDATE content_instances SET name=?,visibility=?,data_json=?,version=? WHERE id=? AND campaign_id=?",
        )
        .run(
          next.name,
          next.visibility,
          JSON.stringify(next.data),
          next.version,
          id,
          member.tableId,
        );
      return next;
    });
  }
  delete(actor: Member, id: string, expectedVersion: number) {
    version.parse(expectedVersion);
    transaction(this.db, () => {
      const member = this.member(actor),
        metadata = this.metadata(this.visible(member, id));
      this.editable(member, metadata, expectedVersion);
      // Deletion stays available to recover an instance with unavailable/corrupt module data.
      this.db
        .prepare("DELETE FROM content_instances WHERE id=? AND campaign_id=?")
        .run(id, member.tableId);
    });
  }
}
