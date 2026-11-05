import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { campaignMembershipSchema } from "@tableloom/core/campaigns";
import type { ServerSystemDefinition } from "@tableloom/module-sdk/server";
import { transaction } from "./database.js";
import { StoreError, type TableStore, type InstalledCatalog } from "./store.js";
import { AccessError, type AccessStore } from "./access.js";
import type { ContentCatalog } from "./content-catalog.js";
import { campaignExportTables } from "./campaign-export.js";
import type { CampaignTransfer } from "./campaign-transfer-format.js";
import {
  inspectCampaignTransfer,
  type inspectCampaignTransferWithImages,
} from "./campaign-preflight.js";
import {
  reviewCampaignOwnership,
  FRESH_RESOURCE_POLICY,
  type CampaignImportRequest,
} from "./campaign-ownership-plan.js";
import { prepareCampaignCandidate } from "./campaign-prepare.js";

export const MAX_IMPORT_RECEIPTS = 1000;
const MAX_RESULT_BYTES = 256 * 1024,
  hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const resultSchema = z
  .object({
    status: z.literal("imported"),
    requestId: z.uuid(),
    archiveSha256: hashSchema,
    ownershipPlanSha256: hashSchema,
    resourcePolicy: z.literal(FRESH_RESOURCE_POLICY),
    importedAt: z.iso.datetime(),
    campaign: campaignMembershipSchema,
    summary: z
      .object({
        createdPeople: z.number().int().nonnegative(),
        attributionRecords: z.number().int().nonnegative(),
        memberships: z.number().int().positive(),
        rows: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const receiptSchema = z
  .object({
    request_id: z.uuid(),
    host_id: z.uuid(),
    fingerprint: hashSchema,
    target_id: z.uuid(),
    result_json: z.string().max(MAX_RESULT_BYTES),
  })
  .strict();
type ImportResult = z.infer<typeof resultSchema>;
type VerifiedSource = Awaited<
  ReturnType<typeof inspectCampaignTransferWithImages>
>;
const fingerprint = (fileHash: string, planHash: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "tableloom-import-v1",
        fileHash,
        planHash,
        FRESH_RESOURCE_POLICY,
        "create-new-campaign",
      ]),
    )
    .digest("hex");
// Fixed columns and order only. New storage envelopes must choose an explicit write policy.
const policies = {
  campaign_records: "insert",
  scene_records: "insert",
  campaign_receipts: "discard",
  command_bindings: "discard",
  object_id_reservations: "insert",
  module_documents: "insert",
  content_overrides: "insert",
  content_instances: "insert",
  campaign_assets: "asset",
  scene_backgrounds: "insert",
  scene_background_history: "insert",
  scene_background_history_refs: "insert",
  scene_grids: "insert",
  scene_history_entries: "sequence",
  roll_archive: "insert",
  chat_messages: "sequence",
} as const satisfies Record<
  keyof CampaignTransfer["records"],
  "insert" | "discard" | "asset" | "sequence"
>;

export class CampaignImportStore {
  constructor(
    private db: DatabaseSync,
    private access: AccessStore,
    private tables: TableStore,
    private catalog: InstalledCatalog,
    private content: ContentCatalog,
    private systems: readonly ServerSystemDefinition<unknown>[],
    private now: () => number = Date.now,
  ) {
    transaction(db, () => {
      const exists = (name: string) =>
        !!db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(name);
      if (exists("campaign_import_storage_version")) {
        z.literal(1).parse(
          db
            .prepare(
              "SELECT version FROM campaign_import_storage_version WHERE id=1",
            )
            .get()?.version,
        );
        if (!exists("campaign_import_requests"))
          throw new Error("Campaign import storage is incomplete.");
      } else {
        if (exists("campaign_import_requests"))
          throw new Error("Campaign import storage is missing its version.");
        db.exec(`CREATE TABLE campaign_import_storage_version(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
          INSERT INTO campaign_import_storage_version VALUES(1,1);
          CREATE TABLE campaign_import_requests(request_id TEXT PRIMARY KEY,host_id TEXT NOT NULL REFERENCES access_users(id),fingerprint TEXT NOT NULL,target_id TEXT NOT NULL UNIQUE,result_json TEXT NOT NULL);`);
      }
      const columns = db
        .prepare(
          "SELECT name FROM pragma_table_info('campaign_import_requests')",
        )
        .all()
        .map((r) => r.name)
        .sort();
      if (
        JSON.stringify(columns) !==
          JSON.stringify(Object.keys(receiptSchema.shape).sort()) ||
        Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM campaign_import_requests")
            .get()!.n,
        ) > MAX_IMPORT_RECEIPTS ||
        db
          .prepare(
            "SELECT 1 FROM campaign_import_requests WHERE length(CAST(result_json AS BLOB))>? LIMIT 1",
          )
          .get(MAX_RESULT_BYTES) ||
        db
          .prepare(
            "SELECT 1 FROM campaign_import_requests r LEFT JOIN access_users u ON u.id=r.host_id WHERE u.id IS NULL LIMIT 1",
          )
          .get()
      )
        throw new Error("Campaign import storage is invalid or unsupported.");
      for (const row of db
        .prepare("SELECT * FROM campaign_import_requests")
        .iterate())
        this.receipt(row);
    });
  }
  private receipt(raw: unknown) {
    const row = receiptSchema.parse(raw),
      result = resultSchema.parse(JSON.parse(row.result_json));
    if (
      Buffer.byteLength(row.result_json) > MAX_RESULT_BYTES ||
      row.request_id !== result.requestId ||
      row.target_id !== result.campaign.id ||
      row.fingerprint !==
        fingerprint(result.archiveSha256, result.ownershipPlanSha256)
    )
      throw new Error("Campaign import receipt is inconsistent.");
    return { row, result };
  }
  private identity(input: CampaignImportRequest) {
    const fileHash = createHash("sha256").update(input.file).digest("hex"),
      planHash = createHash("sha256")
        .update(JSON.stringify(input.plan))
        .digest("hex");
    if (
      fileHash !== input.plan.archiveSha256 ||
      planHash !== input.expectedPlanSha256
    )
      throw new StoreError(
        "The import file or reviewed ownership plan changed.",
        409,
      );
    return {
      fileHash,
      planHash,
      fingerprint: fingerprint(fileHash, planHash),
    };
  }
  replay(input: CampaignImportRequest, token: string) {
    const host = this.access.requireServerHost(token),
      identity = this.identity(input),
      raw = this.db
        .prepare("SELECT * FROM campaign_import_requests WHERE request_id=?")
        .get(input.requestId);
    if (!raw) return null;
    const { row, result } = this.receipt(raw);
    if (row.host_id !== host.id || row.fingerprint !== identity.fingerprint)
      throw new StoreError(
        "That import request ID already belongs to another request.",
        409,
      );
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM campaign_records c JOIN access_campaigns a ON a.id=c.id WHERE c.id=?",
        )
        .get(row.target_id) ||
      this.access.getMember(host.id, row.target_id)?.role !== "gm"
    )
      throw new StoreError(
        "The previous import target is no longer available.",
        409,
      );
    return { ...result, replayed: true as const };
  }
  commit(input: CampaignImportRequest, token: string, checked: VerifiedSource) {
    if (this.db.isTransaction)
      throw new Error("Campaign import must own its write transaction.");
    const identity = this.identity(input);
    if (
      checked.archiveSha256 !== identity.fileHash ||
      checked.pendingValidation.includes("image-decoding") ||
      checked.imageValidation.checked !== checked.resourceCounts.campaign_assets
    )
      throw new StoreError(
        "Complete image inspection before importing this file.",
        409,
      );
    try {
      return transaction(this.db, () => {
        const host = this.access.requireServerHost(token),
          replay = this.replay(input, token);
        if (replay) return replay;
        if (
          Number(
            this.db
              .prepare("SELECT COUNT(*) AS n FROM campaign_import_requests")
              .get()!.n,
          ) >= MAX_IMPORT_RECEIPTS
        )
          throw new StoreError(
            "This server has reached its retained import request limit.",
            409,
          );
        const source = inspectCampaignTransfer(
            input.file,
            this.catalog,
            this.content,
            this.systems,
            this.db,
            "existing",
          ),
          reviewed = reviewCampaignOwnership(
            source,
            input.plan,
            this.db,
            host.id,
            "existing",
          );
        if (reviewed.ownershipReview.planSha256 !== input.expectedPlanSha256)
          throw new StoreError("The reviewed ownership plan changed.", 409);
        const validation = prepareCampaignCandidate(
            input.file,
            reviewed,
            this.catalog,
            this.content,
            this.systems,
            this.db,
            undefined,
            "existing",
          ),
          prepared = validation.prepared;
        if (
          !prepared ||
          !validation.report.resourcePlan.complete ||
          validation.report.blockers.length
        )
          throw new StoreError(
            "The campaign no longer passes import validation. Review it again.",
            409,
          );
        const { candidate } = prepared;
        // Never establish a new global binding solely from an unavailable archive claim.
        const missingBindings: {
          id: string;
          version: string;
          sha256: string;
        }[] = [];
        for (const pin of candidate.packages.contentPacks) {
          const old = this.db
            .prepare(
              "SELECT digest FROM content_pack_bindings WHERE pack_id=? AND pack_version=?",
            )
            .get(pin.id, pin.version);
          if (old) {
            if (old.digest !== pin.sha256)
              throw new StoreError("A content binding changed.", 409);
            continue;
          }
          if (
            !this.content.packs.some(
              (p) =>
                p.pack.id === pin.id &&
                p.pack.version === pin.version &&
                p.digest === pin.sha256,
            )
          )
            throw new StoreError(
              "Install or verify the historical content pack before importing its binding.",
              409,
            );
          missingBindings.push(pin);
        }
        try {
          for (const pin of missingBindings)
            this.db
              .prepare("INSERT INTO content_pack_bindings VALUES(?,?,?)")
              .run(pin.id, pin.version, pin.sha256);
          const at = z
              .number()
              .int()
              .nonnegative()
              .max(8640000000000000)
              .parse(this.now()),
            addPerson = this.db.prepare(
              "INSERT INTO access_users(id,name,created_at) VALUES(?,?,?)",
            );
          for (const person of [
            ...prepared.newUsers,
            ...prepared.unclaimedUsers,
          ])
            addPerson.run(person.id, person.name, at);
          const rows = this.write(candidate);
          this.db
            .prepare("INSERT INTO access_campaigns(id) VALUES(?)")
            .run(candidate.campaign.id);
          const membership = this.db.prepare(
            "INSERT INTO access_memberships(user_id,table_id,role) VALUES(?,?,?)",
          );
          for (const member of prepared.memberships)
            membership.run(member.id, candidate.campaign.id, member.role);
          this.tables.load(candidate.campaign.id);
          const result: ImportResult = resultSchema.parse({
            status: "imported",
            requestId: input.requestId,
            archiveSha256: identity.fileHash,
            ownershipPlanSha256: identity.planHash,
            resourcePolicy: FRESH_RESOURCE_POLICY,
            importedAt: new Date(at).toISOString(),
            campaign: { ...candidate.campaign, role: "gm" },
            summary: {
              createdPeople: prepared.newUsers.length,
              attributionRecords: prepared.unclaimedUsers.length,
              memberships: prepared.memberships.length,
              rows,
            },
          });
          const serialized = JSON.stringify(result);
          if (Buffer.byteLength(serialized) > MAX_RESULT_BYTES)
            throw new StoreError("Import result metadata is too large.", 409);
          this.access.requireServerHost(token);
          this.db
            .prepare(
              "INSERT INTO campaign_import_requests(request_id,host_id,fingerprint,target_id,result_json) VALUES(?,?,?,?,?)",
            )
            .run(
              input.requestId,
              host.id,
              identity.fingerprint,
              candidate.campaign.id,
              serialized,
            );
          return { ...result, replayed: false as const };
        } catch (error) {
          if (error instanceof AccessError) throw error;
          throw new StoreError(
            "The import could not be saved; all changes were rolled back.",
            409,
          );
        }
      });
    } catch (error) {
      if (error instanceof AccessError || error instanceof StoreError)
        throw error;
      throw new StoreError(
        "The import could not be completed; retry with the same request ID.",
        409,
      );
    }
  }
  private write(candidate: CampaignTransfer) {
    let count = 0;
    for (const [table, policy] of Object.entries(policies) as [
      keyof typeof policies,
      (typeof policies)[keyof typeof policies],
    ][]) {
      const rows = candidate.records[table];
      if (policy === "discard") {
        if (rows.length) throw new Error("Source retries cannot be imported.");
        continue;
      }
      const columns = Object.keys(campaignExportTables[table].shape).filter(
          (column) => policy !== "sequence" || column !== "sequence",
        ),
        statement = this.db.prepare(
          `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
        ),
        ordered =
          policy === "sequence"
            ? [...rows].sort(
                (a, b) =>
                  ("sequence" in a ? a.sequence : 0) -
                  ("sequence" in b ? b.sequence : 0),
              )
            : rows;
      for (const raw of ordered) {
        const row = campaignExportTables[table].parse(raw) as Record<
          string,
          string | number | null
        >;
        const values: SQLInputValue[] = columns.map((column) =>
          policy === "asset" && column === "bytes"
            ? Buffer.from(String(row[column]), "base64")
            : row[column]!,
        );
        statement.run(...values);
        count++;
      }
    }
    return count;
  }
}
