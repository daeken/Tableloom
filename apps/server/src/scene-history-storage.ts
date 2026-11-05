import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  pointSchema,
  tokenSchema,
  DEFAULT_TOKEN_RADIUS,
} from "@tableloom/core";
import { ObjectIdentities } from "./object-identities.js";
import { entryOf, payloadSchema, rowSchema } from "./scene-history-model.js";

// Old builds rendered every token at radius 24, including tokens stored only in inverses.
function sizedLegacyPayload(serialized: string): string {
  const payload = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(serialized));
  let changed = false;
  const size = (value: unknown) => {
    const token = tokenSchema
      .omit({ radius: true })
      .extend({ radius: z.literal(DEFAULT_TOKEN_RADIUS).optional() })
      .strict()
      .parse(value);
    if (token.radius === undefined) {
      changed = true;
      return { ...token, radius: DEFAULT_TOKEN_RADIUS };
    }
    return value;
  };
  if (
    (payload.kind === "create" || payload.kind === "delete") &&
    payload.objectType === "token"
  )
    payload.object = size(payload.object);
  if (payload.kind === "delete-many")
    payload.objects = z
      .array(
        z
          .object({
            objectType: z.enum(["token", "drawing"]),
            object: z.unknown(),
          })
          .strict(),
      )
      .parse(payload.objects)
      .map((saved) =>
        saved.objectType === "token"
          ? { ...saved, object: size(saved.object) }
          : saved,
      );
  return changed ? JSON.stringify(payload) : serialized;
}

/** Called inside the same transaction as the history service initialization. */
export function initializeSceneHistory(db: DatabaseSync): ObjectIdentities {
  const identities = new ObjectIdentities(db),
    exists = (name: string) =>
      Boolean(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(name),
      );
  const marked = exists("scene_history_version");
  const version = marked
    ? z
        .union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
          z.literal(6),
          z.literal(7),
          z.literal(8),
        ])
        .parse(
          db
            .prepare("SELECT version FROM scene_history_version WHERE id=1")
            .get()?.version,
        )
    : 0;
  if (version >= 3) {
    if (
      !exists("scene_history_entries") ||
      exists("scene_edit_history") ||
      exists("scene_move_history")
    )
      throw new Error("Scene history storage is incomplete or inconsistent.");
    if (version < 8) {
      const entries = db
          .prepare("SELECT * FROM scene_history_entries ORDER BY sequence")
          .all()
          .map((raw) => {
            const row = rowSchema.parse(raw);
            return entryOf({
              ...row,
              payload_json:
                version < 7
                  ? sizedLegacyPayload(row.payload_json)
                  : row.payload_json,
            });
          }),
        byId = new Map(entries.map((entry) => [entry.id, entry]));
      for (const entry of entries) {
        if (
          entry.payload.kind === "resize-many" ||
          (version < 7 && entry.payload.kind === "token-resize") ||
          (version < 6 && entry.payload.kind === "resize") ||
          (version < 5 && entry.payload.kind === "delete-many") ||
          (version === 3 && entry.payload.kind === "translate")
        )
          throw new Error("Unsupported history payload in old storage.");
        for (const target of entry.targets) {
          const previous = target.previousId
            ? byId.get(target.previousId)
            : undefined;
          if (
            previous &&
            (previous.sequence >= entry.sequence ||
              previous.campaign_id !== entry.campaign_id ||
              previous.scene_id !== entry.scene_id ||
              previous.actor_id !== entry.actor_id ||
              !previous.targets.some(
                (other) => other.objectId === target.objectId,
              ))
          )
            throw new Error("Scene history causal link is invalid.");
        }
      }
      if (
        db.prepare("PRAGMA foreign_key_check(scene_history_entries)").all()
          .length
      )
        throw new Error("Scene history references unavailable data.");
      for (const entry of entries)
        db.prepare(
          "UPDATE scene_history_entries SET payload_json=? WHERE id=?",
        ).run(entry.payload_json, entry.id);
      db.exec("UPDATE scene_history_version SET version=8 WHERE id=1");
    }
    return identities;
  }
  if (exists("scene_history_entries"))
    throw new Error(
      "Scene history storage is missing its version or is inconsistent.",
    );
  if (
    version === 1
      ? !exists("scene_move_history") || exists("scene_edit_history")
      : version === 2
        ? !exists("scene_edit_history") || exists("scene_move_history")
        : exists("scene_move_history") || exists("scene_edit_history")
  )
    throw new Error(
      marked
        ? "Scene history storage is incomplete or inconsistent."
        : "Scene history storage is missing its version.",
    );
  db.exec(`CREATE TABLE scene_history_entries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
    campaign_id TEXT NOT NULL,scene_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES access_users(id),state TEXT NOT NULL CHECK(state IN ('done','undone')),version INTEGER NOT NULL CHECK(version>0),targets_json TEXT NOT NULL,payload_json TEXT NOT NULL,
    FOREIGN KEY(campaign_id,scene_id) REFERENCES scene_records(campaign_id,id));
    CREATE INDEX scene_entries_actor ON scene_history_entries(campaign_id,scene_id,actor_id,sequence);
    CREATE INDEX scene_entries_campaign ON scene_history_entries(campaign_id,sequence);`);
  if (marked) {
    const common = {
      sequence: z.number().int().positive(),
      id: z.uuid(),
      campaign_id: z.uuid(),
      scene_id: z.uuid(),
      actor_id: z.uuid(),
      previous_id: z.uuid().nullable(),
      state: z.enum(["done", "undone"]),
      version: z.number().int().positive(),
    };
    const v1 = z.object({
      ...common,
      token_id: z.uuid(),
      expected_token_version: z.number().int().positive(),
      from_json: z.string(),
      to_json: z.string(),
    });
    const v2 = z.object({
      ...common,
      object_id: z.uuid(),
      expected_object_version: z.number().int().positive(),
      payload_json: z.string(),
    });
    const source = version === 1 ? "scene_move_history" : "scene_edit_history";
    const rows = db
      .prepare(`SELECT * FROM ${source} ORDER BY sequence`)
      .all()
      .map((raw) => {
        if (version === 1) {
          const row = v1.parse(raw);
          return {
            ...row,
            object_id: row.token_id,
            expected_object_version: row.expected_token_version,
            payload_json: JSON.stringify({
              kind: "move",
              objectType: "token",
              before: pointSchema.parse(JSON.parse(row.from_json)),
              after: pointSchema.parse(JSON.parse(row.to_json)),
            }),
          };
        }
        const row = v2.parse(raw),
          payload = payloadSchema.parse(
            JSON.parse(sizedLegacyPayload(row.payload_json)),
          );
        if (
          payload.kind === "resize-many" ||
          payload.kind === "token-resize" ||
          payload.kind === "resize" ||
          payload.kind === "move-many" ||
          payload.kind === "translate" ||
          payload.kind === "delete-many"
        )
          throw new Error("Unexpected group history in old storage.");
        return { ...row, payload_json: sizedLegacyPayload(row.payload_json) };
      });
    const byId = new Map(rows.map((row) => [row.id, row]));
    identities.rememberMany(
      rows.map((row) => ({ campaignId: row.campaign_id, id: row.object_id })),
    );
    const insert = db.prepare(
      "INSERT INTO scene_history_entries(sequence,id,campaign_id,scene_id,actor_id,state,version,targets_json,payload_json) VALUES(?,?,?,?,?,?,?,?,?)",
    );
    for (const row of rows) {
      if (row.previous_id) {
        const previous = byId.get(row.previous_id);
        if (
          !previous ||
          previous.sequence >= row.sequence ||
          previous.campaign_id !== row.campaign_id ||
          previous.scene_id !== row.scene_id ||
          previous.actor_id !== row.actor_id ||
          previous.object_id !== row.object_id
        )
          throw new Error("Scene history causal link is invalid.");
      }
      const entry = entryOf({
        ...row,
        targets_json: JSON.stringify([
          {
            objectId: row.object_id,
            expectedVersion: row.expected_object_version,
            previousId: row.previous_id,
          },
        ]),
      });
      insert.run(
        entry.sequence,
        entry.id,
        entry.campaign_id,
        entry.scene_id,
        entry.actor_id,
        entry.state,
        entry.version,
        entry.targets_json,
        entry.payload_json,
      );
    }
    if (
      db.prepare("PRAGMA foreign_key_check(scene_history_entries)").all().length
    )
      throw new Error("Scene history references unavailable data.");
    db.exec(
      `DROP TABLE ${source}; UPDATE scene_history_version SET version=8 WHERE id=1;`,
    );
  } else
    db.exec(
      "CREATE TABLE scene_history_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO scene_history_version VALUES(1,8);",
    );
  return identities;
}
