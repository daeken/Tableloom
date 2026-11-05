import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  assetSchema,
  assetNameSchema,
  assetPageSchema,
  MAX_ASSET_BYTES,
  MAX_CAMPAIGN_ASSETS,
  MAX_CAMPAIGN_ASSET_BYTES,
} from "@tableloom/core/assets";
import type { Member } from "@tableloom/core/access";
import { memberSchema } from "@tableloom/core/access";
import { transaction } from "./database.js";
import { StoreError } from "./store.js";
import { sanitizePng } from "./png.js";
const fields =
  "id,campaign_id AS campaignId,name,'image/png' AS mimeType,byte_length AS byteLength,width,height,created_at AS createdAt";
const missing = () => new StoreError("That asset is unavailable.", 404);
export class AssetStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
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
      if (exists("asset_storage_version")) {
        z.literal(1).parse(
          db
            .prepare("SELECT version FROM asset_storage_version WHERE id=1")
            .get()?.version,
        );
        if (!exists("campaign_assets"))
          throw new Error("Asset storage is incomplete.");
        return;
      }
      if (exists("campaign_assets"))
        throw new Error("Asset storage is missing its schema version.");
      db.exec(`CREATE TABLE asset_storage_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL); INSERT INTO asset_storage_version VALUES(1,1);
        CREATE TABLE campaign_assets(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaign_records(id) ON DELETE CASCADE,name TEXT NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=5242880),width INTEGER NOT NULL,height INTEGER NOT NULL,created_at TEXT NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL);
        CREATE INDEX assets_campaign ON campaign_assets(campaign_id,id);`);
    });
  }
  private gm(actor: Member, hidden = false) {
    const member = memberSchema.parse(actor),
      current = this.db
        .prepare(
          "SELECT role FROM access_memberships WHERE user_id=? AND table_id=?",
        )
        .get(member.id, member.tableId);
    if (!current || current.role !== "gm")
      throw hidden
        ? missing()
        : new StoreError(
            "Only campaign GMs can manage private map assets.",
            403,
          );
    return member;
  }
  list(actor: Member, after?: string, limit = 20) {
    const member = this.gm(actor),
      cursor = after === undefined ? undefined : z.uuid().parse(after);
    z.number().int().min(1).max(50).parse(limit);
    const rows = this.db
      .prepare(
        `SELECT ${fields} FROM campaign_assets WHERE campaign_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`,
      )
      .all(member.tableId, cursor ?? null, cursor ?? null, limit + 1)
      .map((row) => assetSchema.parse(row));
    const usage = this.db
      .prepare(
        "SELECT COUNT(*) AS totalCount,COALESCE(SUM(byte_length),0) AS usedBytes FROM campaign_assets WHERE campaign_id=?",
      )
      .get(member.tableId)!;
    return assetPageSchema.parse({
      assets: rows.slice(0, limit),
      nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      ...usage,
    });
  }
  upload(actor: Member, name: string, input: Buffer) {
    this.gm(actor);
    const parsedName = assetNameSchema.parse(name);
    if (input.length > MAX_ASSET_BYTES)
      throw new StoreError("This image exceeds the 5 MiB upload limit.", 400);
    const image = sanitizePng(input);
    return transaction(this.db, () => {
      const member = this.gm(actor),
        usage = this.list(member);
      if (
        usage.totalCount >= MAX_CAMPAIGN_ASSETS ||
        usage.usedBytes + image.bytes.length > MAX_CAMPAIGN_ASSET_BYTES
      )
        throw new StoreError(
          "This campaign has reached its private asset limit (200 images or 100 MiB). Remove an unused asset first.",
          409,
        );
      const asset = assetSchema.parse({
        id: randomUUID(),
        campaignId: member.tableId,
        name: parsedName,
        mimeType: "image/png",
        byteLength: image.bytes.length,
        width: image.width,
        height: image.height,
        createdAt: new Date(this.now()).toISOString(),
      });
      this.db
        .prepare(
          "INSERT INTO campaign_assets(id,campaign_id,name,byte_length,width,height,created_at,sha256,bytes) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          asset.id,
          member.tableId,
          asset.name,
          asset.byteLength,
          asset.width,
          asset.height,
          asset.createdAt,
          createHash("sha256").update(image.bytes).digest("hex"),
          image.bytes,
        );
      return asset;
    });
  }
  content(actor: Member, id: string) {
    const member = this.gm(actor, true);
    z.uuid().parse(id);
    const row = this.db
      .prepare(
        `SELECT ${fields},sha256,bytes FROM campaign_assets WHERE campaign_id=? AND id=?`,
      )
      .get(member.tableId, id);
    if (!row) throw missing();
    const { bytes: raw, sha256, ...metadata } = row,
      asset = assetSchema.parse(metadata);
    if (!(raw instanceof Uint8Array))
      throw new Error("Stored asset bytes are invalid.");
    const bytes = Buffer.from(raw);
    if (
      bytes.length !== asset.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !==
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(sha256) ||
      bytes.readUInt32BE(16) !== asset.width ||
      bytes.readUInt32BE(20) !== asset.height
    )
      throw new Error("Stored asset content is inconsistent.");
    return { asset, bytes };
  }
  delete(actor: Member, id: string) {
    this.gm(actor);
    z.uuid().parse(id);
    const removed = this.db
      .prepare("DELETE FROM campaign_assets WHERE campaign_id=? AND id=?")
      .run(actor.tableId, id);
    if (!removed.changes) throw missing();
  }
}
