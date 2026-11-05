import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  backgroundMapSchema,
  backgroundHistorySchema,
  backgroundHistoryActionSchema,
} from "@tableloom/core/scene-map";
import { StoreError } from "./store.js";

type Map = z.infer<typeof backgroundMapSchema> | null;
export type MapRecord = { version: number; map: Map; cursor: number };
export const backgroundHistoryEntrySchema = z
  .object({
    id: z.uuid(),
    seq: z.number().int().positive(),
    action: backgroundHistoryActionSchema,
    before: backgroundMapSchema.nullable(),
    after: backgroundMapSchema.nullable(),
  })
  .strict();
const entrySchema = backgroundHistoryEntrySchema;
// Image keys are access capabilities, never restored from an older snapshot.
function sameMap(a: Map, b: Map) {
  const value = (m: Map) =>
    m && {
      assetId: m.assetId,
      position: m.position,
      width: m.width,
      height: m.height,
      visibility: m.visibility,
    };
  return JSON.stringify(value(a)) === JSON.stringify(value(b));
}
export class SceneMapHistory {
  constructor(private readonly db: DatabaseSync) {}
  initialize() {
    const marker = z
      .union([z.literal(1), z.literal(2)])
      .parse(
        this.db
          .prepare("SELECT version FROM scene_background_version WHERE id=1")
          .get()?.version,
      );
    const exists = (name: string) =>
      Boolean(
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(name),
      );
    if (marker === 1) {
      if (
        exists("scene_background_history") ||
        exists("scene_background_history_refs")
      )
        throw new Error("Unmarked background history storage.");
      this.db
        .exec(`ALTER TABLE scene_backgrounds ADD COLUMN history_cursor INTEGER NOT NULL DEFAULT 0 CHECK(history_cursor>=0);
        CREATE TABLE scene_background_history(campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0),entry_json TEXT NOT NULL,PRIMARY KEY(campaign_id,scene_id,id),UNIQUE(campaign_id,scene_id,seq),FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_backgrounds(campaign_id,scene_id) ON DELETE CASCADE);
        CREATE TABLE scene_background_history_refs(campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,entry_id TEXT NOT NULL,asset_id TEXT NOT NULL,PRIMARY KEY(campaign_id,scene_id,entry_id,asset_id),FOREIGN KEY(campaign_id,scene_id,entry_id) REFERENCES scene_background_history(campaign_id,scene_id,id) ON DELETE CASCADE,FOREIGN KEY(campaign_id,asset_id) REFERENCES campaign_assets(campaign_id,id));`);
    } else if (
      !exists("scene_background_history") ||
      !exists("scene_background_history_refs")
    ) {
      throw new Error("Background history storage is incomplete.");
    }
    // Prepare even for empty storage, so an incomplete current schema cannot pass startup.
    this.db
      .prepare("SELECT history_cursor FROM scene_backgrounds LIMIT 0")
      .all();
    this.db
      .prepare(
        "SELECT campaign_id,scene_id,id,seq,entry_json FROM scene_background_history LIMIT 0",
      )
      .all();
    this.db
      .prepare(
        "SELECT campaign_id,scene_id,entry_id,asset_id FROM scene_background_history_refs LIMIT 0",
      )
      .all();
    // Validate every scene, including hidden/offstage records, before advancing a marker.
    for (const row of this.db
      .prepare("SELECT * FROM scene_backgrounds")
      .all()) {
      const campaignId = z.uuid().parse(row.campaign_id),
        sceneId = z.uuid().parse(row.scene_id);
      const map = backgroundMapSchema
        .nullable()
        .parse(JSON.parse(z.string().parse(row.map_json)));
      if (
        (map?.assetId ?? null) !== row.asset_id ||
        (map?.imageId ?? null) !== row.image_id
      )
        throw new Error("Stored background map references disagree.");
      if (
        map &&
        !this.db
          .prepare("SELECT 1 FROM campaign_assets WHERE campaign_id=? AND id=?")
          .get(campaignId, map.assetId)
      )
        throw new Error("Stored background asset is unavailable.");
      this.read(campaignId, sceneId, {
        map,
        version: z.number().int().positive().parse(row.version),
        cursor: z.number().int().nonnegative().parse(row.history_cursor),
      });
      this.quota(campaignId);
    }
    if (this.db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Background history references are inconsistent.");
    if (marker === 1)
      this.db.exec("UPDATE scene_background_version SET version=2 WHERE id=1");
  }
  read(campaignId: string, sceneId: string, state: MapRecord) {
    const entries = this.db
      .prepare(
        "SELECT id,seq,entry_json FROM scene_background_history WHERE campaign_id=? AND scene_id=? ORDER BY seq LIMIT 101",
      )
      .all(campaignId, sceneId)
      .map((row) => {
        const raw = z.string().parse(row.entry_json);
        if (Buffer.byteLength(raw, "utf8") > 4096)
          throw new Error("Stored background history entry is too large.");
        const entry = entrySchema.parse(JSON.parse(raw));
        if (
          entry.id !== row.id ||
          entry.seq !== row.seq ||
          entry.seq > state.version ||
          sameMap(entry.before, entry.after)
        )
          throw new Error("Stored background history entry is inconsistent.");
        const refs = this.db
          .prepare(
            "SELECT asset_id FROM scene_background_history_refs WHERE campaign_id=? AND scene_id=? AND entry_id=? ORDER BY asset_id",
          )
          .all(campaignId, sceneId, entry.id)
          .map((r) => z.uuid().parse(r.asset_id));
        const expected = [
          ...new Set(
            [entry.before?.assetId, entry.after?.assetId].filter(
              (id): id is string => Boolean(id),
            ),
          ),
        ].sort();
        if (JSON.stringify(refs) !== JSON.stringify(expected))
          throw new Error("Stored background history references disagree.");
        return entry;
      });
    if (
      entries.length > 100 ||
      (state.cursor !== 0 && !entries.some((e) => e.seq === state.cursor))
    )
      throw new Error("Stored background history cursor is inconsistent.");
    for (let i = 1; i < entries.length; i++)
      if (!sameMap(entries[i - 1]!.after, entries[i]!.before))
        throw new Error("Stored background history chain is inconsistent.");
    const undo = entries.filter((e) => e.seq <= state.cursor).at(-1) ?? null;
    const redo = entries.find((e) => e.seq > state.cursor) ?? null;
    if (
      (undo && !sameMap(state.map, undo.after)) ||
      (redo && !sameMap(state.map, redo.before))
    )
      throw new Error("Stored background history does not match the scene.");
    const summary = (edge: typeof undo, direction: "before" | "after") =>
      edge && {
        id: edge.id,
        action: edge.action,
        restores: edge[direction]?.visibility ?? "none",
      };
    return {
      entries,
      undo,
      redo,
      summary: backgroundHistorySchema.parse({
        undo: summary(undo, "before"),
        redo: summary(redo, "after"),
        count: entries.length,
      }),
    };
  }
  record(
    campaignId: string,
    sceneId: string,
    previous: MapRecord,
    map: Map,
    action: z.infer<typeof backgroundHistoryActionSchema>,
  ) {
    this.db
      .prepare(
        "DELETE FROM scene_background_history WHERE campaign_id=? AND scene_id=? AND seq>?",
      )
      .run(campaignId, sceneId, previous.cursor);
    const entry = entrySchema.parse({
      id: randomUUID(),
      seq: previous.version + 1,
      action,
      before: previous.map,
      after: map,
    });
    this.db
      .prepare("INSERT INTO scene_background_history VALUES(?,?,?,?,?)")
      .run(campaignId, sceneId, entry.id, entry.seq, JSON.stringify(entry));
    for (const id of new Set([entry.before?.assetId, entry.after?.assetId]))
      if (id)
        this.db
          .prepare("INSERT INTO scene_background_history_refs VALUES(?,?,?,?)")
          .run(campaignId, sceneId, entry.id, id);
    this.db
      .prepare(
        "DELETE FROM scene_background_history WHERE campaign_id=? AND scene_id=? AND seq NOT IN (SELECT seq FROM scene_background_history WHERE campaign_id=? AND scene_id=? ORDER BY seq DESC LIMIT 100)",
      )
      .run(campaignId, sceneId, campaignId, sceneId);
    this.cursor(campaignId, sceneId, entry.seq);
    this.quota(campaignId);
  }
  cursor(campaignId: string, sceneId: string, seq: number) {
    this.db
      .prepare(
        "UPDATE scene_backgrounds SET history_cursor=? WHERE campaign_id=? AND scene_id=?",
      )
      .run(seq, campaignId, sceneId);
  }
  clear(campaignId: string, sceneId: string) {
    this.db
      .prepare(
        "DELETE FROM scene_background_history WHERE campaign_id=? AND scene_id=?",
      )
      .run(campaignId, sceneId);
    this.cursor(campaignId, sceneId, 0);
  }
  private quota(campaignId: string) {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(entry_json AS BLOB))),0) AS bytes FROM scene_background_history WHERE campaign_id=?",
      )
      .get(campaignId)!;
    if (
      z.number().parse(row.count) > 10000 ||
      z.number().parse(row.bytes) > 8 * 1024 * 1024
    )
      throw new StoreError(
        "Map history is full. Clear history in a scene before editing again.",
        409,
      );
  }
}
