import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Member } from "@tableloom/core/access";
import { memberSchema } from "@tableloom/core/access";
import { rollSchema } from "@tableloom/core";
import type { Roll } from "@tableloom/core";
import { canSeeRoll, canManageRoll } from "@tableloom/core/permissions";
import {
  MAX_ARCHIVED_ROLLS,
  archivedRollSchema,
  rollArchivePageSchema,
  rollSelectionSchema,
} from "@tableloom/core/roll-history";
import { TableStore, StoreError } from "./store.js";
import { transaction } from "./database.js";

/** Archives are immutable, campaign-scoped rows, never part of a table snapshot. */
export class RollHistoryStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tables: TableStore,
  ) {
    transaction(db, () => {
      const exists = (name: string) =>
        Boolean(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(name),
        );
      if (exists("roll_archive_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM roll_archive_version WHERE id = 1")
            .get()?.version,
        );
        if (!exists("roll_archive"))
          throw new Error("Roll archive storage is incomplete.");
        return;
      }
      if (exists("roll_archive"))
        throw new Error("Roll archive storage is missing its schema version.");
      db.exec(`CREATE TABLE roll_archive (
        campaign_id TEXT NOT NULL REFERENCES campaign_records(id), id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('public', 'gm')), owner_id TEXT REFERENCES access_users(id),
        archived_at TEXT NOT NULL, roll_json TEXT NOT NULL, PRIMARY KEY(campaign_id, id)
      );
      CREATE TABLE roll_archive_version(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
      INSERT INTO roll_archive_version(id, version) VALUES (1, 1);`);
    });
  }
  list(actor: Member, options: { after?: string; limit?: number } = {}) {
    const query = z
      .object({
        after: z.uuid().optional(),
        limit: z.number().int().min(1).max(50).default(25),
      })
      .strict()
      .parse(options);
    return transaction(this.db, () => {
      const member = this.member(actor);
      const rows = this.db
        .prepare(
          `SELECT * FROM roll_archive WHERE campaign_id = ? AND (? = 'gm' OR visibility = 'public' OR owner_id = ?) AND id > ? ORDER BY id LIMIT ?`,
        )
        .all(
          member.tableId,
          member.role,
          member.id,
          query.after ?? "",
          query.limit + 1,
        );
      const entries = rows.slice(0, query.limit).map((row) => this.decode(row));
      return rollArchivePageSchema.parse({
        entries,
        next: rows.length > query.limit ? entries.at(-1)!.roll.id : null,
      });
    });
  }
  change(
    actor: Member,
    input: unknown,
    action: "archive" | "delete",
    source: "live" | "archive" = "live",
  ) {
    const { ids } = rollSelectionSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.member(actor);
      if (source === "archive") {
        if (action !== "delete")
          throw new StoreError("Archived rolls cannot be archived again.", 400);
        // Authorize the entire batch before deleting any row; hidden rows are not decoded.
        for (const id of ids) {
          const row = this.db
            .prepare(
              "SELECT * FROM roll_archive WHERE campaign_id = ? AND id = ? AND (? = 'gm' OR visibility = 'public' OR owner_id = ?)",
            )
            .get(member.tableId, id, member.role, member.id);
          if (!row)
            throw new StoreError(
              "A selected roll is unavailable. Refresh the history.",
              404,
            );
          this.manage(member, this.decode(row).roll);
        }
        const remove = this.db.prepare(
          "DELETE FROM roll_archive WHERE campaign_id = ? AND id = ?",
        );
        for (const id of ids) remove.run(member.tableId, id);
      } else {
        const state = this.tables.load(member.tableId);
        const rolls = ids.map((id) => {
          const roll = state.rolls.find((roll) => roll.id === id);
          if (!roll || !canSeeRoll(member, roll))
            throw new StoreError(
              "A selected roll is unavailable. Refresh the history.",
              404,
            );
          this.manage(member, roll);
          return roll;
        });
        if (action === "archive") {
          const count = Number(
            this.db
              .prepare(
                "SELECT COUNT(*) AS count FROM roll_archive WHERE campaign_id = ?",
              )
              .get(member.tableId)?.count,
          );
          if (count + rolls.length > MAX_ARCHIVED_ROLLS)
            throw new StoreError(
              "This campaign's roll archive is full. Delete archived results before saving more.",
              409,
            );
          const insert = this.db.prepare(
            "INSERT INTO roll_archive(campaign_id, id, visibility, owner_id, archived_at, roll_json) VALUES (?, ?, ?, ?, ?, ?)",
          );
          const archivedAt = new Date().toISOString();
          for (const roll of rolls)
            insert.run(
              member.tableId,
              roll.id,
              roll.visibility,
              roll.ownerId,
              archivedAt,
              JSON.stringify(roll),
            );
        }
        const selected = new Set(ids);
        this.tables.save(
          {
            ...state,
            revision: state.revision + 1,
            rolls: state.rolls.filter((roll) => !selected.has(roll.id)),
          },
          randomUUID(),
          member.tableId,
        );
      }
      return { affected: ids.length };
    });
  }
  private member(actor: Member): Member {
    const identity = memberSchema.parse(actor);
    const row = this.db
      .prepare(
        "SELECT u.id, u.name, m.table_id AS tableId, m.role FROM access_memberships m JOIN access_users u ON u.id = m.user_id WHERE m.user_id = ? AND m.table_id = ?",
      )
      .get(identity.id, identity.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    return memberSchema.parse(row);
  }
  private manage(member: Member, roll: Roll) {
    if (!canManageRoll(member, roll))
      throw new StoreError(
        "Only the GM can manage public history; players can manage their own private rolls.",
        403,
      );
  }
  private decode(row: Record<string, unknown>) {
    const entry = archivedRollSchema.parse({
      roll: rollSchema.parse(JSON.parse(z.string().parse(row.roll_json))),
      archivedAt: row.archived_at,
    });
    if (
      entry.roll.id !== row.id ||
      entry.roll.ownerId !== row.owner_id ||
      entry.roll.visibility !== row.visibility
    )
      throw new Error("Stored roll archive metadata is inconsistent.");
    return entry;
  }
}
