import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import {
  MAX_CAMPAIGN_CONTENT_OVERRIDES,
  contentKey,
  contentCursorSchema,
  contentMetadataSchema,
  contentViewSchema,
  contentPageSchema,
  contentOverrideSchema,
  contentResetSchema,
  contentReferenceSchema,
} from "@tableloom/core/content";
import type { ContentReference } from "@tableloom/core/content";
import { StoreError, TableStore } from "./store.js";
import { transaction } from "./database.js";
import { ContentCatalog, validatedContentData } from "./content-catalog.js";

type Row = Record<string, unknown>;
const metadataColumns =
  "revision, name, visibility, data_json IS NOT NULL AS overridden";
export class CampaignContentStore {
  constructor(
    private db: DatabaseSync,
    private campaigns: TableStore,
    private catalog: ContentCatalog,
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
      if (exists("content_storage_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM content_storage_version WHERE id=1")
            .get()?.version,
        );
        if (!exists("content_pack_bindings") || !exists("content_overrides"))
          throw new Error("Content storage is incomplete.");
      } else {
        if (exists("content_pack_bindings") || exists("content_overrides"))
          throw new Error("Content storage is missing its schema version.");
        db.exec(`CREATE TABLE content_storage_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
          INSERT INTO content_storage_version VALUES(1,1);
          CREATE TABLE content_pack_bindings(pack_id TEXT NOT NULL,pack_version TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(pack_id,pack_version));
          CREATE TABLE content_overrides(campaign_id TEXT NOT NULL REFERENCES campaign_records(id),pack_id TEXT NOT NULL,pack_version TEXT NOT NULL,definition_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision>0),name TEXT,visibility TEXT CHECK(visibility IN ('public','gm')),data_json TEXT,
            PRIMARY KEY(campaign_id,pack_id,pack_version,definition_id),
            CHECK((data_json IS NULL AND name IS NULL AND visibility IS NULL) OR (data_json IS NOT NULL AND name IS NOT NULL AND visibility IS NOT NULL)));`);
      }
      for (const { pack, digest } of catalog.packs) {
        const old = db
          .prepare(
            "SELECT digest FROM content_pack_bindings WHERE pack_id=? AND pack_version=?",
          )
          .get(pack.id, pack.version);
        if (
          old &&
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(old.digest) !== digest
        )
          throw new Error(
            "Installed content changed without a pack version bump.",
          );
        if (!old)
          db.prepare("INSERT INTO content_pack_bindings VALUES(?,?,?)").run(
            pack.id,
            pack.version,
            digest,
          );
      }
    });
  }
  private member(actor: Member) {
    z.uuid().parse(actor.id);
    z.uuid().parse(actor.tableId);
    const row = this.db
      .prepare(
        `SELECT u.id,u.name,m.table_id AS tableId,m.role FROM access_memberships m JOIN access_users u ON u.id=m.user_id WHERE m.user_id=? AND m.table_id=?`,
      )
      .get(actor.id, actor.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    return memberSchema.parse(row);
  }
  private base(member: Member, reference: ContentReference) {
    const ref = contentReferenceSchema.parse(reference),
      campaign = this.campaigns.getCampaign(member.tableId);
    if (
      !campaign.contentPacks.some(
        (p) => p.id === ref.packId && p.version === ref.packVersion,
      )
    )
      throw new StoreError("That content definition is unavailable.", 404);
    const entry = this.catalog.find(ref);
    if (
      entry.pack.systemId !== campaign.system.id ||
      entry.pack.systemVersion !== campaign.system.version
    )
      throw new StoreError("That content definition is unavailable.", 404);
    return entry;
  }
  private row(
    member: Member,
    ref: ContentReference,
    body = false,
  ): Row | undefined {
    return this.db
      .prepare(
        `SELECT ${metadataColumns}${body ? ", data_json" : ""} FROM content_overrides WHERE campaign_id=? AND pack_id=? AND pack_version=? AND definition_id=?`,
      )
      .get(member.tableId, ref.packId, ref.packVersion, ref.definitionId);
  }
  private metadata(member: Member, ref: ContentReference, row?: Row) {
    const { definition, pack } = this.base(member, ref),
      overridden = Boolean(row?.overridden);
    const visibility = overridden ? row?.visibility : definition.visibility;
    if (member.role !== "gm" && visibility !== "public")
      throw new StoreError("That content definition is unavailable.", 404);
    return contentMetadataSchema.parse({
      reference: ref,
      campaignId: member.tableId,
      name: overridden ? row?.name : definition.name,
      kind: definition.kind,
      visibility,
      revision: row?.revision ?? 0,
      overridden,
      system: { id: pack.systemId, version: pack.systemVersion },
    });
  }
  private view(member: Member, ref: ContentReference) {
    const row = this.row(member, ref),
      metadata = this.metadata(member, ref, row),
      { definition, dataSchema } = this.base(member, ref);
    let effective = { data: definition.data, sources: definition.sources };
    if (metadata.overridden) {
      const body = this.row(member, ref, true);
      const saved = contentOverrideSchema
        .omit({ expectedRevision: true })
        .parse(JSON.parse(z.string().parse(body?.data_json)));
      if (
        saved.name !== metadata.name ||
        saved.visibility !== metadata.visibility
      )
        throw new Error("Stored content override is invalid.");
      validatedContentData(dataSchema, saved.data);
      effective = saved;
    }
    return structuredClone(
      contentViewSchema.parse({
        ...metadata,
        ...effective,
        originSources:
          member.role === "gm" || definition.visibility === "public"
            ? definition.sources
            : [],
      }),
    );
  }
  get(actor: Member, reference: ContentReference) {
    return transaction(this.db, () =>
      this.view(this.member(actor), contentReferenceSchema.parse(reference)),
    );
  }
  list(actor: Member, input: { after?: string; limit?: number } = {}) {
    const query = z
      .object({
        after: contentCursorSchema.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .strict()
      .parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.campaigns.getCampaign(member.tableId),
        visible = [];
      const rows = this.db
        .prepare(
          `SELECT pack_id,pack_version,definition_id,${metadataColumns} FROM content_overrides WHERE campaign_id=? LIMIT ${MAX_CAMPAIGN_CONTENT_OVERRIDES + 1}`,
        )
        .all(member.tableId);
      if (rows.length > MAX_CAMPAIGN_CONTENT_OVERRIDES)
        throw new Error("Stored content exceeds its campaign override limit.");
      const byKey = new Map(
        rows.map((row) => [
          `${row.pack_id}@${row.pack_version}:${row.definition_id}`,
          row,
        ]),
      );
      for (const ref of this.catalog.references(campaign.contentPacks)) {
        if (query.after && contentKey(ref) <= query.after) continue;
        const row = byKey.get(contentKey(ref)),
          { definition, pack } = this.catalog.find(ref);
        if (
          pack.systemId !== campaign.system.id ||
          pack.systemVersion !== campaign.system.version
        )
          throw new StoreError(
            "A selected content pack has an incompatible system pin.",
            409,
          );
        if (
          member.role !== "gm" &&
          (row?.overridden ? row.visibility : definition.visibility) !==
            "public"
        )
          continue;
        visible.push(this.metadata(member, ref, row));
        if (visible.length > query.limit) break;
      }
      const definitions = visible.slice(0, query.limit);
      return contentPageSchema.parse({
        definitions,
        next:
          visible.length > query.limit
            ? contentKey(definitions.at(-1)!.reference)
            : null,
      });
    });
  }
  override(
    actor: Member,
    reference: ContentReference,
    input: z.input<typeof contentOverrideSchema>,
  ) {
    const ref = contentReferenceSchema.parse(reference),
      body = contentOverrideSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor);
      if (member.role !== "gm")
        throw new StoreError(
          "Only the GM can change catalog definitions.",
          403,
        );
      const { dataSchema } = this.base(member, ref),
        row = this.row(member, ref);
      if (
        !row &&
        Number(
          this.db
            .prepare(
              "SELECT count(*) n FROM content_overrides WHERE campaign_id=?",
            )
            .get(member.tableId)?.n,
        ) >= MAX_CAMPAIGN_CONTENT_OVERRIDES
      )
        throw new StoreError(
          "This campaign has reached its homebrew override limit.",
          409,
        );
      if ((row?.revision ?? 0) !== body.expectedRevision)
        throw new StoreError(
          "This definition changed. Refresh before editing.",
          409,
        );
      let data;
      try {
        data = validatedContentData(dataSchema, body.data, true);
      } catch {
        throw new StoreError("Content data is invalid for this pack.", 400);
      }
      const saved = {
          name: body.name,
          visibility: body.visibility,
          data,
          sources: body.sources,
        },
        revision = body.expectedRevision + 1;
      z.number().int().positive().parse(revision);
      this.db
        .prepare(
          `INSERT INTO content_overrides(campaign_id,pack_id,pack_version,definition_id,revision,name,visibility,data_json) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(campaign_id,pack_id,pack_version,definition_id) DO UPDATE SET revision=excluded.revision,name=excluded.name,visibility=excluded.visibility,data_json=excluded.data_json`,
        )
        .run(
          member.tableId,
          ref.packId,
          ref.packVersion,
          ref.definitionId,
          revision,
          saved.name,
          saved.visibility,
          JSON.stringify(saved),
        );
      return this.view(member, ref);
    });
  }
  reset(
    actor: Member,
    reference: ContentReference,
    input: z.input<typeof contentResetSchema>,
  ) {
    const ref = contentReferenceSchema.parse(reference),
      body = contentResetSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor);
      if (member.role !== "gm")
        throw new StoreError(
          "Only the GM can change catalog definitions.",
          403,
        );
      this.base(member, ref);
      const row = this.row(member, ref);
      if ((row?.revision ?? 0) !== body.expectedRevision)
        throw new StoreError(
          "This definition changed. Refresh before resetting.",
          409,
        );
      if (!row?.overridden)
        throw new StoreError("This definition has no override to reset.", 400);
      z.number()
        .int()
        .positive()
        .parse(body.expectedRevision + 1);
      this.db
        .prepare(
          "UPDATE content_overrides SET revision=revision+1,name=NULL,visibility=NULL,data_json=NULL WHERE campaign_id=? AND pack_id=? AND pack_version=? AND definition_id=?",
        )
        .run(member.tableId, ref.packId, ref.packVersion, ref.definitionId);
      return this.view(member, ref);
    });
  }
}
