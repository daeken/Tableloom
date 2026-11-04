import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  pointSchema,
  tokenSchema,
  drawingSchema,
  tableSchema,
} from "@tableloom/core";
import type { Command, TableState, Token } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";
import { sceneHistorySchema } from "@tableloom/core/scene-history";
import { ObjectIdentities } from "./object-identities.js";
import { transaction } from "./database.js";
import { TableStore, StoreError } from "./store.js";

export const MAX_MEMBER_SCENE_HISTORY = 100;
export const MAX_CAMPAIGN_SCENE_HISTORY = 10000;
export const MAX_CAMPAIGN_HISTORY_BYTES = 32 * 1024 * 1024;
const payloadSchema = z.union([
  z
    .object({
      kind: z.literal("move"),
      objectType: z.literal("token"),
      before: pointSchema,
      after: pointSchema,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["create", "delete"]),
      objectType: z.literal("token"),
      object: tokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["create", "delete"]),
      objectType: z.literal("drawing"),
      object: drawingSchema,
    })
    .strict(),
]);
type Payload = z.infer<typeof payloadSchema>;
const rowSchema = z.object({
  id: z.uuid(),
  campaign_id: z.uuid(),
  scene_id: z.uuid(),
  actor_id: z.uuid(),
  object_id: z.uuid(),
  previous_id: z.uuid().nullable(),
  state: z.enum(["done", "undone"]),
  version: z.number().int().positive(),
  expected_object_version: z.number().int().positive(),
  payload_json: z.string(),
});
type Entry = z.infer<typeof rowSchema> & { payload: Payload };
function entryOf(row: unknown): Entry {
  const entry = rowSchema.parse(row),
    payload = payloadSchema.parse(JSON.parse(entry.payload_json));
  if (payload.kind !== "move" && payload.object.id !== entry.object_id)
    throw new Error("Scene history target is inconsistent.");
  return { ...entry, payload };
}
const objectOf = (state: TableState, id: string) =>
  state.tokens.find((object) => object.id === id) ??
  state.drawings.find((object) => object.id === id);
const expectsPresent = (entry: Entry) =>
  entry.payload.kind === "move" ||
  (entry.payload.kind === "create"
    ? entry.state === "done"
    : entry.state === "undone");

/** Trusted inverses only. Mutations must share the enclosing scene/receipt transaction. */
export class SceneHistoryStore {
  private readonly identities: ObjectIdentities;
  constructor(
    private readonly db: DatabaseSync,
    private readonly tables: TableStore,
  ) {
    this.identities = transaction(db, () => {
      const identities = new ObjectIdentities(db);
      const exists = (name: string) =>
        Boolean(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(name),
        );
      const marked = exists("scene_history_version");
      if (marked) {
        const version = z
          .union([z.literal(1), z.literal(2)])
          .parse(
            db
              .prepare("SELECT version FROM scene_history_version WHERE id=1")
              .get()?.version,
          );
        if (version === 2) {
          if (!exists("scene_edit_history") || exists("scene_move_history"))
            throw new Error(
              "Scene history storage is incomplete or inconsistent.",
            );
          return identities;
        }
        if (!exists("scene_move_history") || exists("scene_edit_history"))
          throw new Error(
            "Scene history storage is incomplete or inconsistent.",
          );
      } else if (exists("scene_move_history") || exists("scene_edit_history"))
        throw new Error("Scene history storage is missing its version.");
      db.exec(`CREATE TABLE scene_edit_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES access_users(id),object_id TEXT NOT NULL,
        previous_id TEXT REFERENCES scene_edit_history(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK(state IN ('done','undone')),version INTEGER NOT NULL CHECK(version>0),expected_object_version INTEGER NOT NULL CHECK(expected_object_version>0),
        payload_json TEXT NOT NULL,FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_records(campaign_id,id)
      );
      CREATE INDEX scene_history_actor ON scene_edit_history(campaign_id,scene_id,actor_id,sequence);
      CREATE INDEX scene_history_target ON scene_edit_history(campaign_id,scene_id,object_id);
      CREATE INDEX scene_history_campaign ON scene_edit_history(campaign_id,sequence);`);
      if (marked) {
        const legacySchema = z.object({
          sequence: z.number().int().positive(),
          id: z.uuid(),
          campaign_id: z.uuid(),
          scene_id: z.uuid(),
          actor_id: z.uuid(),
          token_id: z.uuid(),
          previous_id: z.uuid().nullable(),
          state: z.enum(["done", "undone"]),
          version: z.number().int().positive(),
          expected_token_version: z.number().int().positive(),
          from_json: z.string(),
          to_json: z.string(),
        });
        const rows = db
          .prepare("SELECT * FROM scene_move_history ORDER BY sequence")
          .all()
          .map((row) => legacySchema.parse(row));
        const insert = db.prepare(
          "INSERT INTO scene_edit_history(sequence,id,campaign_id,scene_id,actor_id,object_id,previous_id,state,version,expected_object_version,payload_json) VALUES(?,?,?,?,?,?,NULL,?,?,?,?)",
        );
        identities.rememberMany(
          rows.map((row) => ({
            campaignId: row.campaign_id,
            id: row.token_id,
          })),
        );
        for (const row of rows) {
          const payload = payloadSchema.parse({
            kind: "move",
            objectType: "token",
            before: pointSchema.parse(JSON.parse(row.from_json)),
            after: pointSchema.parse(JSON.parse(row.to_json)),
          });
          insert.run(
            row.sequence,
            row.id,
            row.campaign_id,
            row.scene_id,
            row.actor_id,
            row.token_id,
            row.state,
            row.version,
            row.expected_token_version,
            JSON.stringify(payload),
          );
        }
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const row of rows)
          if (row.previous_id) {
            const previous = byId.get(row.previous_id);
            if (
              !previous ||
              previous.sequence >= row.sequence ||
              previous.campaign_id !== row.campaign_id ||
              previous.scene_id !== row.scene_id ||
              previous.actor_id !== row.actor_id ||
              previous.token_id !== row.token_id
            )
              throw new Error("Scene history causal link is invalid.");
            db.prepare(
              "UPDATE scene_edit_history SET previous_id=? WHERE id=?",
            ).run(row.previous_id, row.id);
          }
        if (
          db.prepare("PRAGMA foreign_key_check(scene_edit_history)").all()
            .length
        )
          throw new Error("Scene history references unavailable data.");
        db.exec(
          "DROP TABLE scene_move_history; UPDATE scene_history_version SET version=2 WHERE id=1;",
        );
        // Legacy moves are tiny; enforce every bound during the same upgrade transaction.
        for (const row of db
          .prepare(
            "SELECT DISTINCT campaign_id,scene_id,actor_id FROM scene_edit_history",
          )
          .all())
          this.trimMember(
            z.uuid().parse(row.campaign_id),
            z.uuid().parse(row.scene_id),
            z.uuid().parse(row.actor_id),
          );
        for (const row of db
          .prepare("SELECT DISTINCT campaign_id FROM scene_edit_history")
          .all())
          this.trimCampaign(z.uuid().parse(row.campaign_id));
      } else
        db.exec(
          "CREATE TABLE scene_history_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO scene_history_version VALUES(1,2);",
        );
      return identities;
    });
  }
  private member(actor: Member): Member {
    const identity = memberSchema.parse(actor);
    const row = this.db
      .prepare(
        "SELECT u.id,u.name,m.table_id AS tableId,m.role FROM access_memberships m JOIN access_users u ON u.id=m.user_id WHERE m.user_id=? AND m.table_id=?",
      )
      .get(identity.id, identity.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    return memberSchema.parse(row);
  }
  private edge(
    member: Member,
    sceneId: string,
    state: "done" | "undone",
  ): Entry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM scene_edit_history WHERE campaign_id=? AND scene_id=? AND actor_id=? AND state=? ORDER BY sequence ${state === "done" ? "DESC" : "ASC"} LIMIT 1`,
      )
      .get(member.tableId, sceneId, member.id, state);
    return row ? entryOf(row) : null;
  }
  private available(entry: Entry, state: TableState, member: Member): boolean {
    const object = objectOf(state, entry.object_id),
      payload = entry.payload;
    if (expectsPresent(entry))
      return Boolean(
        object &&
        (payload.objectType === "token"
          ? "name" in object
          : "points" in object) &&
        canEditObject(member, object) &&
        object.version === entry.expected_object_version,
      );
    if (payload.kind === "move") return false;
    // Durable ID reservations prevent ordinary creations from reusing this absent
    // target. Only its version-checked history chain can restore it.
    return (
      !object &&
      !state.notes.some((note) => note.id === entry.object_id) &&
      canEditObject(member, payload.object) &&
      (payload.objectType === "token"
        ? state.tokens.length < 200
        : state.drawings.length < 2000)
    );
  }
  status(actor: Member) {
    return transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId),
        state = this.tables.load(member.tableId);
      const item = (entry: Entry | null) =>
        entry
          ? {
              id: entry.id,
              version: entry.version,
              objectId: entry.object_id,
              action: entry.payload.kind,
              objectType: entry.payload.objectType,
              name:
                entry.payload.objectType === "token"
                  ? ((objectOf(state, entry.object_id) as Token | undefined)
                      ?.name ??
                    (entry.payload.kind !== "move" &&
                    entry.payload.objectType === "token"
                      ? entry.payload.object.name
                      : "Token"))
                  : "Drawing",
              available: this.available(entry, state, member),
            }
          : null;
      return sceneHistorySchema.parse({
        undo: item(this.edge(member, campaign.activeSceneId, "done")),
        redo: item(this.edge(member, campaign.activeSceneId, "undone")),
      });
    });
  }
  private trim(campaignId: string, sceneId: string, actorId: string) {
    this.trimMember(campaignId, sceneId, actorId);
    this.trimCampaign(campaignId);
  }
  private trimMember(campaignId: string, sceneId: string, actorId: string) {
    this.db
      .prepare(
        "DELETE FROM scene_edit_history WHERE id IN (SELECT id FROM scene_edit_history WHERE campaign_id=? AND scene_id=? AND actor_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
      )
      .run(campaignId, sceneId, actorId, MAX_MEMBER_SCENE_HISTORY);
  }
  private trimCampaign(campaignId: string) {
    this.db
      .prepare(
        "DELETE FROM scene_edit_history WHERE id IN (SELECT id FROM scene_edit_history WHERE campaign_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
      )
      .run(campaignId, MAX_CAMPAIGN_SCENE_HISTORY);
    // Keep a newest contiguous suffix. Geometry lives only here, never in history cursors.
    this.db
      .prepare(
        `DELETE FROM scene_edit_history WHERE id IN (
      SELECT id FROM (SELECT id,SUM(length(CAST(payload_json AS BLOB))) OVER (ORDER BY sequence DESC) AS bytes FROM scene_edit_history WHERE campaign_id=?) WHERE bytes>?
    )`,
      )
      .run(campaignId, MAX_CAMPAIGN_HISTORY_BYTES);
  }
  record(
    actor: Member,
    before: TableState,
    after: TableState,
    command: Command,
  ) {
    if (
      ![
        "token.add",
        "drawing.add",
        "token.move",
        "object.delete",
        "note.add",
      ].includes(command.type)
    )
      return;
    if (!this.db.isTransaction)
      throw new Error("Scene history must share the scene transaction.");
    transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId);
      if (command.type === "note.add") {
        this.identities.claim(member.tableId, command.note.id);
        return;
      }
      const objectId =
        command.type === "token.add"
          ? command.token.id
          : command.type === "drawing.add"
            ? command.drawing.id
            : command.type === "token.move"
              ? command.tokenId
              : command.type === "object.delete"
                ? command.objectId
                : null;
      if (!objectId) return;
      const original = objectOf(before, objectId),
        next = objectOf(after, objectId);
      let payload: Payload;
      if (command.type === "token.move") {
        const from = tokenSchema.parse(original),
          to = tokenSchema.parse(next);
        if (to.version !== from.version + 1 || to.ownerId !== from.ownerId)
          throw new Error("Invalid move history transition.");
        payload = {
          kind: "move",
          objectType: "token",
          before: from.position,
          after: to.position,
        };
      } else {
        const object = command.type === "object.delete" ? original : next;
        if (!object) throw new Error("Invalid scene history transition.");
        payload = payloadSchema.parse({
          kind: command.type === "object.delete" ? "delete" : "create",
          objectType: "name" in object ? "token" : "drawing",
          object,
        });
      }
      this.db
        .prepare(
          "DELETE FROM scene_edit_history WHERE campaign_id=? AND scene_id=? AND actor_id=? AND state='undone'",
        )
        .run(member.tableId, campaign.activeSceneId, member.id);
      if (payload.kind === "create")
        this.identities.claim(member.tableId, objectId);
      else this.identities.remember(member.tableId, objectId);
      const previous = this.db
        .prepare(
          "SELECT * FROM scene_edit_history WHERE campaign_id=? AND scene_id=? AND actor_id=? AND object_id=? AND state='done' ORDER BY sequence DESC LIMIT 1",
        )
        .get(member.tableId, campaign.activeSceneId, member.id, objectId);
      const preceding = previous ? entryOf(previous) : null;
      const previousId =
        preceding &&
        original &&
        expectsPresent(preceding) &&
        preceding.expected_object_version === original.version
          ? preceding.id
          : null;
      const version =
        payload.kind === "delete" ? original!.version + 1 : next!.version;
      this.db
        .prepare(
          "INSERT INTO scene_edit_history(id,campaign_id,scene_id,actor_id,object_id,previous_id,state,version,expected_object_version,payload_json) VALUES(?,?,?,?,?,?,'done',1,?,?)",
        )
        .run(
          randomUUID(),
          member.tableId,
          campaign.activeSceneId,
          member.id,
          objectId,
          previousId,
          version,
          JSON.stringify(payloadSchema.parse(payload)),
        );
      this.trim(member.tableId, campaign.activeSceneId, member.id);
    });
  }
  apply(
    actor: Member,
    state: TableState,
    command: Extract<Command, { type: "scene.undo" | "scene.redo" }>,
  ): TableState {
    if (!this.db.isTransaction)
      throw new Error("Scene history must share the scene transaction.");
    return transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId),
        undo = command.type === "scene.undo";
      const entry = this.edge(
        member,
        campaign.activeSceneId,
        undo ? "done" : "undone",
      );
      if (!entry || entry.id !== command.historyId)
        throw new StoreError(
          "That history action is unavailable. Review the current scene.",
          404,
        );
      if (entry.version !== command.expectedVersion)
        throw new StoreError(
          "Scene history changed. Review the current action before trying again.",
          409,
        );
      if (!this.available(entry, state, member))
        throw new StoreError(
          "This object changed or is unavailable. Its history cannot be applied over newer edits, ownership changes, or a full scene.",
          409,
        );
      const payload = entry.payload,
        nextVersion = entry.expected_object_version + 1;
      let next: TableState;
      if (payload.kind === "move")
        next = applyCommand(
          state,
          {
            id: command.id,
            type: "token.move",
            tokenId: entry.object_id,
            expectedVersion: entry.expected_object_version,
            position: undo ? payload.before : payload.after,
          },
          member,
        );
      else if (expectsPresent(entry))
        next = applyCommand(
          state,
          {
            id: command.id,
            type: "object.delete",
            objectId: entry.object_id,
            expectedVersion: entry.expected_object_version,
          },
          member,
        );
      else {
        // Restore the saved owner, never the requesting GM. State validation enforces
        // shape/size limits; current permission checks above enforce access to the inverse.
        next = structuredClone(state);
        if (payload.objectType === "token")
          next.tokens.push({ ...payload.object, version: nextVersion });
        else next.drawings.push({ ...payload.object, version: nextVersion });
        next.revision += 1;
        next = tableSchema.parse(next);
      }
      this.db
        .prepare(
          "UPDATE scene_edit_history SET state=?,version=version+1,expected_object_version=? WHERE id=?",
        )
        .run(undo ? "undone" : "done", nextVersion, entry.id);
      // Only causal neighbors are rebased. Remote edits and reused IDs never join a chain.
      if (undo && entry.previous_id)
        this.db
          .prepare(
            "UPDATE scene_edit_history SET expected_object_version=?,version=version+1 WHERE id=? AND campaign_id=? AND scene_id=? AND actor_id=? AND object_id=? AND state='done'",
          )
          .run(
            nextVersion,
            entry.previous_id,
            member.tableId,
            campaign.activeSceneId,
            member.id,
            entry.object_id,
          );
      if (!undo)
        this.db
          .prepare(
            "UPDATE scene_edit_history SET expected_object_version=?,version=version+1 WHERE previous_id=? AND campaign_id=? AND scene_id=? AND actor_id=? AND object_id=? AND state='undone'",
          )
          .run(
            nextVersion,
            entry.id,
            member.tableId,
            campaign.activeSceneId,
            member.id,
            entry.object_id,
          );
      return next;
    });
  }
}
