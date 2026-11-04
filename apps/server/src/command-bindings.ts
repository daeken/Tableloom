import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clientCommandSchema } from "@tableloom/core";
import { transaction } from "./database.js";

/** Confirmation metadata follows the lifetime of the existing deduplication receipt. */
export class CommandBindings {
  constructor(private readonly db: DatabaseSync) {
    transaction(db, () => {
      const exists = (name: string) =>
        Boolean(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(name),
        );
      if (exists("command_binding_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM command_binding_version WHERE id = 1")
            .get()?.version,
        );
        if (!exists("command_bindings"))
          throw new Error("Command confirmation storage is incomplete.");
        return;
      }
      if (exists("command_bindings"))
        throw new Error(
          "Command confirmation storage is missing its schema version.",
        );
      db.exec(`CREATE TABLE command_bindings (
        campaign_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES access_users(id), digest TEXT NOT NULL,
        PRIMARY KEY(campaign_id, id), FOREIGN KEY(campaign_id, id) REFERENCES campaign_receipts(campaign_id, id) ON DELETE CASCADE
      );
      CREATE TABLE command_binding_version(id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
      INSERT INTO command_binding_version VALUES (1, 1);`);
    });
  }
  private digest(frame: unknown) {
    return createHash("sha256")
      .update(JSON.stringify(clientCommandSchema.parse(frame)))
      .digest("hex");
  }
  matches(
    actorId: string,
    frame: z.infer<typeof clientCommandSchema>,
  ): boolean {
    const row = this.db
      .prepare(
        "SELECT actor_id, digest FROM command_bindings WHERE campaign_id = ? AND id = ?",
      )
      .get(frame.context.campaignId, frame.command.id);
    return row?.actor_id === actorId && row.digest === this.digest(frame);
  }
  bind(actorId: string, frame: z.infer<typeof clientCommandSchema>) {
    z.uuid().parse(actorId);
    this.db
      .prepare(
        "INSERT INTO command_bindings(campaign_id, id, actor_id, digest) VALUES (?, ?, ?, ?)",
      )
      .run(
        frame.context.campaignId,
        frame.command.id,
        actorId,
        this.digest(frame),
      );
  }
}
