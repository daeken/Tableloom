import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { documentData } from "@tableloom/module-sdk";
import type { DocumentData } from "@tableloom/module-sdk";
import { defineServerSystem } from "@tableloom/module-sdk/server";
import type { ServerSystemDefinition } from "@tableloom/module-sdk/server";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import {
  documentMetadataSchema,
  documentSchema,
  documentCreateSchema,
  documentUpdateSchema,
  documentPageSchema,
  MAX_CAMPAIGN_DOCUMENTS,
} from "@tableloom/core/documents";
import type {
  DocumentMetadata,
  SystemDocument,
} from "@tableloom/core/documents";
import { StoreError, TableStore } from "./store.js";
import { transaction } from "./database.js";
import { documentSystems } from "./document-modules.js";

type Row = Record<string, unknown>;
const columns = `id, campaign_id AS campaignId, title, owner_id AS ownerId, visibility,
  system_id AS systemId, system_version AS systemVersion, schema_version AS schemaVersion, version`;
const uuid = z.uuid(),
  version = z.number().int().positive();

/** Borrowed connection; all writes and permission checks share one transaction. */
export class DocumentStore {
  private readonly systems: Map<string, ServerSystemDefinition<unknown>>;
  constructor(
    private readonly db: DatabaseSync,
    private readonly campaigns: TableStore,
    systems: readonly ServerSystemDefinition<unknown>[] = documentSystems,
  ) {
    this.systems = new Map();
    for (const system of systems) {
      defineServerSystem(system);
      const key = `${system.manifest.id}@${system.manifest.version}`;
      if (this.systems.has(key))
        throw new Error("Duplicate document system registration.");
      this.systems.set(key, system);
    }
    transaction(db, () => {
      const exists = (table: string) =>
        Boolean(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(table),
        );
      if (exists("document_storage_version")) {
        z.literal(1).parse(
          db
            .prepare(
              "SELECT version FROM document_storage_version WHERE id = 1",
            )
            .get()?.version,
        );
        if (!exists("module_documents"))
          throw new Error("Document storage is incomplete.");
        return;
      }
      if (exists("module_documents"))
        throw new Error("Document storage is missing its schema version.");
      db.exec(`CREATE TABLE module_documents (
        id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaign_records(id),
        title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES access_users(id),
        visibility TEXT NOT NULL CHECK(visibility IN ('public', 'gm')),
        system_id TEXT NOT NULL, system_version TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version > 0), version INTEGER NOT NULL CHECK(version > 0),
        data_json TEXT NOT NULL
      );
      CREATE INDEX document_campaign_page ON module_documents(campaign_id, id);
      CREATE INDEX document_campaign_owner ON module_documents(campaign_id, owner_id, id);
      CREATE TABLE document_storage_version(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
      INSERT INTO document_storage_version(id, version) VALUES (1, 1);`);
    });
  }

  create(
    actor: Member,
    input: z.input<typeof documentCreateSchema>,
  ): SystemDocument {
    const body = documentCreateSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor);
      const campaign = this.campaigns.getCampaign(member.tableId);
      if (
        campaign.system.id !== body.system.id ||
        campaign.system.version !== body.system.version
      )
        throw new StoreError(
          "The campaign system changed. Reload before creating a document.",
          409,
        );
      const definition = this.definition(body.system.id, body.system.version);
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM module_documents WHERE campaign_id = ?",
        )
        .get(member.tableId);
      if (Number(count?.count) >= MAX_CAMPAIGN_DOCUMENTS)
        throw new StoreError(
          "This campaign has reached its document limit.",
          409,
        );
      const data = this.inputData(
        definition,
        body.data === undefined ? definition.createDocument() : body.data,
      );
      const document = documentSchema.parse({
        id: randomUUID(),
        campaignId: member.tableId,
        title: body.title,
        ownerId: member.id,
        visibility: body.visibility,
        system: body.system,
        schemaVersion: definition.documentVersion,
        version: 1,
        data,
      });
      this.db
        .prepare(
          `INSERT INTO module_documents(id, campaign_id, title, owner_id, visibility, system_id, system_version, schema_version, version, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          document.id,
          document.campaignId,
          document.title,
          document.ownerId,
          document.visibility,
          document.system.id,
          document.system.version,
          document.schemaVersion,
          document.version,
          JSON.stringify(document.data),
        );
      return document;
    });
  }

  list(actor: Member, options: { after?: string; limit?: number } = {}) {
    const { after, limit } = z
      .object({
        after: uuid.optional(),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .strict()
      .parse(options);
    return transaction(this.db, () => {
      const member = this.member(actor);
      const rows = this.db
        .prepare(
          `SELECT ${columns} FROM module_documents
        WHERE campaign_id = ? AND (? = 'gm' OR visibility = 'public' OR owner_id = ?)
        AND id > ? ORDER BY id LIMIT ?`,
        )
        .all(member.tableId, member.role, member.id, after ?? "", limit + 1);
      const documents = rows.slice(0, limit).map((row) => this.metadata(row));
      return documentPageSchema.parse({
        documents,
        next: rows.length > limit ? documents.at(-1)!.id : null,
      });
    });
  }

  get(actor: Member, id: string): SystemDocument {
    return transaction(this.db, () => {
      const member = this.member(actor),
        row = this.visible(member, id);
      const metadata = this.metadata(row),
        definition = this.forDocument(metadata);
      if (metadata.schemaVersion !== definition.documentVersion)
        throw new StoreError(
          "This document needs an explicit GM schema migration before it can be opened or edited.",
          409,
        );
      return documentSchema.parse({
        ...metadata,
        data: this.storedData(definition, this.decode(row)),
      });
    });
  }

  update(
    actor: Member,
    id: string,
    input: z.infer<typeof documentUpdateSchema>,
  ): SystemDocument {
    const body = documentUpdateSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor),
        row = this.visible(member, id),
        metadata = this.metadata(row);
      this.editable(member, metadata);
      this.expected(metadata, body.expectedVersion);
      const definition = this.forDocument(metadata);
      if (metadata.schemaVersion !== definition.documentVersion)
        throw new StoreError("Migrate this document before editing it.", 409);
      const data = this.inputData(definition, body.data);
      this.db
        .prepare(
          "UPDATE module_documents SET title = ?, visibility = ?, data_json = ?, version = version + 1 WHERE id = ? AND campaign_id = ?",
        )
        .run(
          body.title,
          body.visibility,
          JSON.stringify(data),
          id,
          member.tableId,
        );
      return documentSchema.parse({
        ...metadata,
        title: body.title,
        visibility: body.visibility,
        version: metadata.version + 1,
        data,
      });
    });
  }

  delete(actor: Member, id: string, expectedVersion: number): void {
    version.parse(expectedVersion);
    transaction(this.db, () => {
      const member = this.member(actor),
        metadata = this.metadata(this.visible(member, id));
      this.editable(member, metadata);
      this.expected(metadata, expectedVersion);
      this.db
        .prepare(
          "DELETE FROM module_documents WHERE id = ? AND campaign_id = ?",
        )
        .run(id, member.tableId);
    });
  }

  migrate(actor: Member, id: string, expectedVersion: number): SystemDocument {
    version.parse(expectedVersion);
    return transaction(this.db, () => {
      const member = this.member(actor),
        row = this.visible(member, id),
        metadata = this.metadata(row);
      if (member.role !== "gm")
        throw new StoreError("Only the GM can migrate document schemas.", 403);
      this.expected(metadata, expectedVersion);
      const definition = this.forDocument(metadata);
      if (metadata.schemaVersion >= definition.documentVersion)
        throw new StoreError(
          "This document has no supported pending schema migration.",
          409,
        );
      let data: DocumentData = this.decode(row),
        schemaVersion = metadata.schemaVersion;
      try {
        while (schemaVersion < definition.documentVersion) {
          const step = definition.documentMigrations?.find(
            (step) => step.from === schemaVersion,
          );
          if (!step) throw new Error("Missing schema migration step.");
          data = documentData(step.outputSchema.parse(step.migrate(data)));
          schemaVersion = step.to;
        }
        data = this.storedData(definition, data);
      } catch {
        throw new StoreError(
          "Document migration failed. No changes were saved; check the installed module and migration path.",
          409,
        );
      }
      this.db
        .prepare(
          "UPDATE module_documents SET data_json = ?, schema_version = ?, version = version + 1 WHERE id = ? AND campaign_id = ?",
        )
        .run(JSON.stringify(data), schemaVersion, id, member.tableId);
      return documentSchema.parse({
        ...metadata,
        schemaVersion,
        version: metadata.version + 1,
        data,
      });
    });
  }

  private member(actor: Member): Member {
    uuid.parse(actor.id);
    uuid.parse(actor.tableId);
    const row = this.db
      .prepare(
        `SELECT u.id, u.name, m.table_id AS tableId, m.role FROM access_memberships m JOIN access_users u ON m.user_id = u.id WHERE m.user_id = ? AND m.table_id = ?`,
      )
      .get(actor.id, actor.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    return memberSchema.parse(row);
  }
  private visible(member: Member, id: string): Row {
    uuid.parse(id);
    const row = this.db
      .prepare(
        `SELECT ${columns}, data_json FROM module_documents WHERE id = ? AND campaign_id = ? AND (? = 'gm' OR visibility = 'public' OR owner_id = ?)`,
      )
      .get(id, member.tableId, member.role, member.id);
    if (!row) throw new StoreError("That document is unavailable.", 404);
    return row;
  }
  private metadata(row: Row): DocumentMetadata {
    return documentMetadataSchema.parse({
      id: row.id,
      campaignId: row.campaignId,
      title: row.title,
      ownerId: row.ownerId,
      visibility: row.visibility,
      system: { id: row.systemId, version: row.systemVersion },
      schemaVersion: row.schemaVersion,
      version: row.version,
    });
  }
  private editable(member: Member, document: DocumentMetadata) {
    if (member.role !== "gm" && member.id !== document.ownerId)
      throw new StoreError(
        "Only the owner or GM can change this document.",
        403,
      );
  }
  private expected(document: DocumentMetadata, expectedVersion: number) {
    if (document.version !== expectedVersion)
      throw new StoreError(
        "This document changed. Reload before saving, deleting, or migrating.",
        409,
      );
  }
  private definition(
    id: string,
    version: string,
  ): ServerSystemDefinition<unknown> {
    const definition = this.systems.get(`${id}@${version}`);
    if (!definition)
      throw new StoreError(
        "The exact document system package is not installed.",
        409,
      );
    return definition;
  }
  private forDocument(document: DocumentMetadata) {
    const campaign = this.campaigns.getCampaign(document.campaignId);
    if (
      campaign.system.id !== document.system.id ||
      campaign.system.version !== document.system.version
    )
      throw new StoreError("Document and campaign system pins disagree.", 409);
    return this.definition(document.system.id, document.system.version);
  }
  private inputData(
    definition: ServerSystemDefinition<unknown>,
    value: unknown,
  ): DocumentData {
    try {
      return documentData(definition.documentSchema.parse(documentData(value)));
    } catch {
      throw new StoreError(
        "Document data is invalid for this system or exceeds its JSON limits.",
        400,
      );
    }
  }
  private decode(row: Row): DocumentData {
    try {
      return documentData(JSON.parse(z.string().parse(row.data_json)));
    } catch {
      throw new Error("Stored document JSON is invalid.");
    }
  }
  private storedData(
    definition: ServerSystemDefinition<unknown>,
    data: DocumentData,
  ): DocumentData {
    if (!definition.documentSchema.safeParse(data).success)
      throw new Error("Stored document data does not match its schema.");
    return documentData(data); // Validate without repeatedly applying schema transforms on reads.
  }
}
