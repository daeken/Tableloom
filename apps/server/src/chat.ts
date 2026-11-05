import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  chatInputSchema,
  chatMessageSchema,
  chatPageSchema,
} from "@tableloom/core/chat";
import { memberSchema, type Member } from "@tableloom/core/access";
import { transaction } from "./database.js";
import { StoreError, TableStore } from "./store.js";

/** Separate from scene revisions/receipts. One public bucket and one private bucket per author. */
export class ChatStore {
  constructor(
    private db: DatabaseSync,
    private tables: TableStore,
    private now = Date.now,
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
      if (exists("chat_storage_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM chat_storage_version WHERE id=1")
            .get()?.version,
        );
        if (!exists("chat_messages"))
          throw new Error("Chat storage is incomplete.");
        for (const row of db
          .prepare(
            "SELECT campaign_id,id,message_json,bucket FROM chat_messages",
          )
          .all()) {
          tables.getCampaign(z.uuid().parse(row.campaign_id));
          const message = this.parse(row);
          if (row.bucket !== this.bucket(message))
            throw new Error("Chat audience storage is inconsistent.");
        }
        if (
          db
            .prepare(
              "SELECT 1 FROM chat_messages GROUP BY campaign_id,bucket HAVING count(*)>100",
            )
            .get() ||
          db
            .prepare(
              "SELECT 1 FROM chat_messages GROUP BY campaign_id HAVING count(*)>1100",
            )
            .get()
        )
          throw new Error("Chat storage exceeds retention limits.");
        return;
      }
      if (exists("chat_messages"))
        throw new Error("Chat storage is missing its version.");
      db.exec(`CREATE TABLE chat_storage_version(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
        INSERT INTO chat_storage_version VALUES(1,1);
        CREATE TABLE chat_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,campaign_id TEXT NOT NULL,id TEXT NOT NULL,bucket TEXT NOT NULL,message_json TEXT NOT NULL,UNIQUE(campaign_id,id),FOREIGN KEY(campaign_id) REFERENCES campaign_records(id) ON DELETE CASCADE);
        CREATE INDEX chat_audience ON chat_messages(campaign_id,bucket,sequence);`);
    });
  }
  private parse(row: Record<string, unknown>) {
    const message = chatMessageSchema.parse(
      JSON.parse(z.string().parse(row.message_json)),
    );
    if (row.id !== undefined && row.id !== message.id)
      throw new Error("Chat identity storage is inconsistent.");
    if (row.bucket !== this.bucket(message))
      throw new Error("Chat audience storage is inconsistent.");
    return message;
  }
  private bucket(message: { audience: "public" | "gm"; authorId: string }) {
    return message.audience === "public" ? "public" : message.authorId;
  }
  private current(actor: Member) {
    const parsed = memberSchema.parse(actor),
      row = this.db
        .prepare(
          "SELECT u.id,u.name,m.table_id AS tableId,m.role FROM access_users u JOIN access_memberships m ON m.user_id=u.id WHERE u.id=? AND m.table_id=?",
        )
        .get(parsed.id, parsed.tableId);
    if (!row) throw new StoreError("Sign in to this campaign first.", 403);
    const member = memberSchema.parse(row);
    this.tables.getCampaign(member.tableId);
    return member;
  }
  private page(member: Member) {
    const rows = this.db
      .prepare(
        "SELECT id,bucket,message_json FROM chat_messages WHERE campaign_id=? AND (?='gm' OR bucket='public' OR bucket=?) ORDER BY sequence DESC LIMIT 100",
      )
      .all(member.tableId, member.role, member.id);
    return chatPageSchema.parse({
      campaignId: member.tableId,
      viewerId: member.id,
      messages: rows.reverse().map((row) => this.parse(row)),
    });
  }
  list(actor: Member) {
    return transaction(this.db, () => this.page(this.current(actor)));
  }
  send(actor: Member, input: unknown) {
    const command = chatInputSchema.parse(input);
    return transaction(this.db, () => {
      const member = this.current(actor),
        existing = this.db
          .prepare(
            "SELECT id,bucket,message_json FROM chat_messages WHERE campaign_id=? AND id=?",
          )
          .get(member.tableId, command.id);
      if (existing) {
        const message = this.parse(existing);
        if (
          message.authorId !== member.id ||
          message.body !== command.body ||
          message.audience !== command.audience
        )
          throw new StoreError(
            "This message ID is already used. Start a new message.",
            409,
          );
        return message;
      }
      const message = chatMessageSchema.parse({
          ...command,
          authorId: member.id,
          authorName: member.name,
          createdAt: this.now(),
        }),
        bucket = this.bucket(message);
      this.db
        .prepare(
          "INSERT INTO chat_messages(campaign_id,id,bucket,message_json) VALUES(?,?,?,?)",
        )
        .run(member.tableId, message.id, bucket, JSON.stringify(message));
      // Prune only the submitting audience; private traffic never evicts public or another author's private messages.
      this.db
        .prepare(
          "DELETE FROM chat_messages WHERE campaign_id=? AND bucket=? AND sequence NOT IN (SELECT sequence FROM chat_messages WHERE campaign_id=? AND bucket=? ORDER BY sequence DESC LIMIT 100)",
        )
        .run(member.tableId, bucket, member.tableId, bucket);
      const count = this.db
        .prepare("SELECT count(*) AS n FROM chat_messages WHERE campaign_id=?")
        .get(member.tableId)!.n;
      if (typeof count !== "number" || count > 1100)
        throw new StoreError(
          "Campaign chat has reached its storage limit for a new audience. No message was sent.",
          409,
        );
      return message;
    });
  }
}
