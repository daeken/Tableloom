import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pointSchema, tokenSchema } from "@tableloom/core";
import type { Command, TableState } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";
import { sceneHistorySchema } from "@tableloom/core/scene-history";
import { transaction } from "./database.js";
import { TableStore, StoreError } from "./store.js";

export const MAX_MEMBER_MOVE_HISTORY = 100;
export const MAX_CAMPAIGN_MOVE_HISTORY = 10000;
const entrySchema = z.object({
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
type Entry = z.infer<typeof entrySchema>;
/** Trusted move inverses only. No caller-supplied positions, owners, or inverse payloads. */
export class SceneHistoryStore {
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
      if (exists("scene_history_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM scene_history_version WHERE id=1")
            .get()?.version,
        );
        if (!exists("scene_move_history"))
          throw new Error("Scene history storage is incomplete.");
        return;
      }
      if (exists("scene_move_history"))
        throw new Error("Scene history storage is missing its version.");
      db.exec(`CREATE TABLE scene_move_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        campaign_id TEXT NOT NULL, scene_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES access_users(id), token_id TEXT NOT NULL,
        previous_id TEXT REFERENCES scene_move_history(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK(state IN ('done','undone')), version INTEGER NOT NULL CHECK(version>0), expected_token_version INTEGER NOT NULL CHECK(expected_token_version>0),
        from_json TEXT NOT NULL, to_json TEXT NOT NULL,
        FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_records(campaign_id,id)
      );
      CREATE INDEX scene_history_member ON scene_move_history(campaign_id,scene_id,actor_id,sequence);
      CREATE TABLE scene_history_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT INTO scene_history_version VALUES(1,1);`);
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
    // Undo walks the applied prefix backward; redo walks the undone suffix forward.
    const order = state === "done" ? "DESC" : "ASC";
    const row = this.db
      .prepare(
        `SELECT * FROM scene_move_history WHERE campaign_id=? AND scene_id=? AND actor_id=? AND state=? ORDER BY sequence ${order} LIMIT 1`,
      )
      .get(member.tableId, sceneId, member.id, state);
    if (!row) return null;
    const entry = entrySchema.parse(row);
    pointSchema.parse(JSON.parse(entry.from_json));
    pointSchema.parse(JSON.parse(entry.to_json));
    return entry;
  }
  status(actor: Member) {
    return transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId),
        state = this.tables.load(member.tableId);
      const item = (entry: Entry | null) => {
        if (!entry) return null;
        const token = state.tokens.find((token) => token.id === entry.token_id);
        return {
          id: entry.id,
          version: entry.version,
          tokenId: entry.token_id,
          name: token?.name ?? "Token",
          available: Boolean(
            token &&
            canEditObject(member, token) &&
            token.version === entry.expected_token_version,
          ),
        };
      };
      return sceneHistorySchema.parse({
        undo: item(this.edge(member, campaign.activeSceneId, "done")),
        redo: item(this.edge(member, campaign.activeSceneId, "undone")),
      });
    });
  }
  record(
    actor: Member,
    before: TableState,
    after: TableState,
    command: Command,
  ) {
    if (!["object.delete", "token.add", "token.move"].includes(command.type))
      return;
    if (!this.db.isTransaction)
      throw new Error("Move history must share the scene transaction.");
    if (command.type === "object.delete" || command.type === "token.add") {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId);
      // A deleted UUID may later be reused; never let old inverses target a new incarnation.
      const tokenId =
        command.type === "token.add" ? command.token.id : command.objectId;
      this.db
        .prepare(
          "DELETE FROM scene_move_history WHERE campaign_id=? AND scene_id=? AND token_id=?",
        )
        .run(member.tableId, campaign.activeSceneId, tokenId);
      return;
    }
    if (command.type !== "token.move") return;
    transaction(this.db, () => {
      const member = this.member(actor),
        campaign = this.tables.getCampaign(member.tableId);
      const original = tokenSchema.parse(
          before.tokens.find((token) => token.id === command.tokenId),
        ),
        next = tokenSchema.parse(
          after.tokens.find((token) => token.id === command.tokenId),
        );
      if (
        next.version !== original.version + 1 ||
        next.ownerId !== original.ownerId
      )
        throw new Error("Invalid move history transition.");
      this.db
        .prepare(
          "DELETE FROM scene_move_history WHERE campaign_id=? AND scene_id=? AND actor_id=? AND state='undone'",
        )
        .run(member.tableId, campaign.activeSceneId, member.id);
      const previous = this.db
        .prepare(
          "SELECT id,expected_token_version FROM scene_move_history WHERE campaign_id=? AND scene_id=? AND actor_id=? AND token_id=? AND state='done' ORDER BY sequence DESC LIMIT 1",
        )
        .get(member.tableId, campaign.activeSceneId, member.id, next.id);
      // Only our own uninterrupted moves form a chain. An intervening remote edit
      // permanently breaks it, even if that editor returns to identical coordinates.
      const previousId =
        previous?.expected_token_version === original.version
          ? z.uuid().parse(previous.id)
          : null;
      this.db
        .prepare(
          "INSERT INTO scene_move_history(id,campaign_id,scene_id,actor_id,token_id,previous_id,state,version,expected_token_version,from_json,to_json) VALUES(?,?,?,?,?,?,'done',1,?,?,?)",
        )
        .run(
          randomUUID(),
          member.tableId,
          campaign.activeSceneId,
          member.id,
          next.id,
          previousId,
          next.version,
          JSON.stringify(pointSchema.parse(original.position)),
          JSON.stringify(pointSchema.parse(next.position)),
        );
      this.db
        .prepare(
          "DELETE FROM scene_move_history WHERE id IN (SELECT id FROM scene_move_history WHERE campaign_id=? AND scene_id=? AND actor_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
        )
        .run(
          member.tableId,
          campaign.activeSceneId,
          member.id,
          MAX_MEMBER_MOVE_HISTORY,
        );
      this.db
        .prepare(
          "DELETE FROM scene_move_history WHERE id IN (SELECT id FROM scene_move_history WHERE campaign_id=? ORDER BY sequence DESC LIMIT -1 OFFSET ?)",
        )
        .run(member.tableId, MAX_CAMPAIGN_MOVE_HISTORY);
    });
  }
  apply(
    actor: Member,
    state: TableState,
    command: Extract<Command, { type: "scene.undo" | "scene.redo" }>,
  ): TableState {
    if (!this.db.isTransaction)
      throw new Error("Move history must share the scene transaction.");
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
          "That move history action is unavailable. Review the current scene.",
          404,
        );
      if (entry.version !== command.expectedVersion)
        throw new StoreError(
          "Move history changed. Review the current action before trying again.",
          409,
        );
      const token = state.tokens.find((token) => token.id === entry.token_id);
      if (
        !token ||
        !canEditObject(member, token) ||
        token.version !== entry.expected_token_version
      )
        throw new StoreError(
          "This token changed or is unavailable. Its old move cannot be applied over newer edits.",
          409,
        );
      const position = pointSchema.parse(
        JSON.parse(undo ? entry.from_json : entry.to_json),
      );
      const next = applyCommand(
        state,
        {
          id: command.id,
          type: "token.move",
          tokenId: token.id,
          expectedVersion: token.version,
          position,
        },
        member,
      );
      const nextVersion = tokenSchema.parse(
        next.tokens.find((object) => object.id === token.id),
      ).version;
      this.db
        .prepare(
          "UPDATE scene_move_history SET state=?,version=version+1,expected_token_version=? WHERE id=?",
        )
        .run(undo ? "undone" : "done", nextVersion, entry.id);
      // Rebase only causal neighbors, advancing their cursors to prevent stale ABA
      // requests after repeated undo/redo. Remote edits never receive this treatment.
      if (undo && entry.previous_id)
        this.db
          .prepare(
            "UPDATE scene_move_history SET expected_token_version=?,version=version+1 WHERE id=? AND campaign_id=? AND scene_id=? AND actor_id=? AND token_id=? AND state='done'",
          )
          .run(
            nextVersion,
            entry.previous_id,
            member.tableId,
            campaign.activeSceneId,
            member.id,
            token.id,
          );
      if (!undo)
        this.db
          .prepare(
            "UPDATE scene_move_history SET expected_token_version=?,version=version+1 WHERE previous_id=? AND campaign_id=? AND scene_id=? AND actor_id=? AND token_id=? AND state='undone'",
          )
          .run(
            nextVersion,
            entry.id,
            member.tableId,
            campaign.activeSceneId,
            member.id,
            token.id,
          );
      return next;
    });
  }
}
