import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { tableSchema } from "@tableloom/core";
import { transaction } from "./database.js";
import { StoreError } from "./store.js";

export const MAX_CAMPAIGN_OBJECT_IDS = 250000;
/** Permanent, content-free UUID reservations prevent stale edits targeting a new incarnation. */
export class ObjectIdentities {
  constructor(private readonly db: DatabaseSync) {
    transaction(db, () => {
      const exists = (name: string) =>
        Boolean(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(name),
        );
      if (exists("object_identity_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM object_identity_version WHERE id=1")
            .get()?.version,
        );
        if (!exists("object_id_reservations"))
          throw new Error("Object identity storage is incomplete.");
        return;
      }
      if (exists("object_id_reservations"))
        throw new Error("Object identity storage is missing its version.");
      if (
        exists("scene_history_version") &&
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(
          Number(
            db
              .prepare("SELECT version FROM scene_history_version WHERE id=1")
              .get()?.version,
          ),
        )
      )
        throw new Error(
          "Object identity storage is missing from scene history.",
        );
      db.exec(`CREATE TABLE object_id_reservations(campaign_id TEXT NOT NULL REFERENCES campaign_records(id) ON DELETE CASCADE,id TEXT NOT NULL,PRIMARY KEY(campaign_id,id));
        CREATE TABLE object_identity_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO object_identity_version VALUES(1,1);`);
      const scene = z
        .object({
          tokens: tableSchema.shape.tokens,
          drawings: tableSchema.shape.drawings,
        })
        .strict();
      for (const row of db
        .prepare("SELECT campaign_id,state_json FROM scene_records")
        .all()) {
        const campaignId = z.uuid().parse(row.campaign_id),
          data = scene.parse(JSON.parse(z.string().parse(row.state_json)));
        this.rememberMany(
          [...data.tokens, ...data.drawings].map((object) => ({
            campaignId,
            id: object.id,
          })),
        );
      }
      const campaign = z
        .object({
          schemaVersion: z.literal(10),
          revision: tableSchema.shape.revision,
          notes: tableSchema.shape.notes,
          rolls: tableSchema.shape.rolls,
        })
        .strict();
      for (const row of db
        .prepare("SELECT id,state_json FROM campaign_records")
        .all()) {
        const id = z.uuid().parse(row.id),
          data = campaign.parse(JSON.parse(z.string().parse(row.state_json)));
        this.rememberMany(
          data.notes.map((note) => ({ campaignId: id, id: note.id })),
        );
      }
    });
  }
  private has(campaignId: string, id: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT id FROM object_id_reservations WHERE campaign_id=? AND id=?",
        )
        .get(campaignId, id),
    );
  }
  claim(campaignId: string, id: string) {
    if (this.has(campaignId, id))
      throw new StoreError(
        "This object ID has already been used in this campaign. Create a new object with a fresh ID, or restore it through undo.",
        409,
      );
    this.remember(campaignId, id);
  }
  remember(campaignId: string, id: string) {
    this.rememberMany([{ campaignId, id }]);
  }
  rememberMany(entries: Iterable<{ campaignId: string; id: string }>) {
    if (!this.db.isTransaction)
      throw new Error("Object identities must share the scene transaction.");
    const counts = new Map<string, number>();
    for (const { campaignId, id } of entries) {
      z.uuid().parse(campaignId);
      z.uuid().parse(id);
      if (this.has(campaignId, id)) continue;
      const count =
        counts.get(campaignId) ??
        Number(
          this.db
            .prepare(
              "SELECT count(*) AS count FROM object_id_reservations WHERE campaign_id=?",
            )
            .get(campaignId)!.count,
        );
      if (count >= MAX_CAMPAIGN_OBJECT_IDS)
        throw new StoreError(
          "This campaign has reached its reserved object ID limit. Use another campaign for new objects.",
          409,
        );
      this.db
        .prepare(
          "INSERT INTO object_id_reservations(campaign_id,id) VALUES(?,?)",
        )
        .run(campaignId, id);
      counts.set(campaignId, count + 1);
    }
  }
}
