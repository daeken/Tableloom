import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ServerSystemDefinition } from "@tableloom/module-sdk/server";
import { buildCampaignCandidate } from "./campaign-candidate.js";
import { FRESH_RESOURCE_POLICY } from "./campaign-ownership-plan.js";
import type { OwnershipReview } from "./campaign-resource-ids.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import { validateCampaignStorageQuotas } from "./campaign-storage-quotas.js";
import type { InstalledCatalog } from "./store.js";
import type { ContentCatalog } from "./content-catalog.js";

const checked = new Set([
  "resource-id-plan",
  "mapped-storage-quotas",
  "mapped-module-references",
  "mapped-history-graph",
]);
type Prepared = ReturnType<typeof buildCampaignCandidate>;
/** A fresh preview each time; the private candidate is returned only to trusted server callers. */
export function prepareCampaignCandidate<T extends OwnershipReview>(
  file: string,
  review: T,
  catalog: InstalledCatalog,
  content: ContentCatalog,
  systems: readonly ServerSystemDefinition<unknown>[],
  db: DatabaseSync,
  uuid: () => string = randomUUID,
) {
  if (db.isTransaction)
    throw new Error("Candidate preparation needs independent read snapshots.");
  const { status: _sourceStatus, ...base } = review;
  const result = (
    blocker: string | null,
    stage: string | null,
    prepared?: Prepared,
    mapped?: ReturnType<typeof inspectCampaignTransfer>,
  ) => ({
    report: {
      ...base,
      status: "candidate-preflight-only" as const,
      importReady: false as const,
      blockers: [
        ...new Set([
          ...review.blockers,
          ...(blocker ? [blocker] : []),
          ...(mapped?.blockers ?? []),
        ]),
      ].sort(),
      pendingValidation: review.pendingValidation.filter(
        (item) => !prepared || !checked.has(item),
      ),
      resourcePlan: {
        policy: FRESH_RESOURCE_POLICY,
        complete: !!prepared,
        targetCampaignId: prepared?.candidate.campaign.id ?? null,
        candidateSha256: prepared
          ? createHash("sha256")
              .update(JSON.stringify(prepared.candidate))
              .digest("hex")
          : null,
        counts: prepared?.ids.counts ?? null,
        droppedRetryRecords: prepared?.droppedRetries ?? null,
      },
      candidateValidation: {
        complete: !!prepared,
        failedStage: stage,
        objectHistory: mapped?.objectHistoryValidation ?? null,
        moduleReferences: mapped?.moduleReferenceValidation ?? null,
      },
    },
    prepared,
  });
  if (!review.ownershipReview.complete || review.blockers.length)
    return result("source_or_ownership_review_incomplete", "source-review");
  let stage = "mapping";
  try {
    const prepared = buildCampaignCandidate(
      file,
      review,
      content,
      systems,
      db,
      uuid,
    );
    stage = "storage";
    validateCampaignStorageQuotas(prepared.candidate.records);
    stage = "relations";
    const mapped = inspectCampaignTransfer(
      JSON.stringify(prepared.candidate),
      catalog,
      content,
      systems,
      db,
    );
    if (mapped.blockers.length || !mapped.moduleReferenceValidation.complete)
      return result("mapped_campaign_unavailable", stage, undefined, mapped);
    return result(null, null, prepared, mapped);
  } catch {
    // Module-controlled errors/paths and partially rewritten private data never enter the report.
    return result(
      stage === "mapping"
        ? "candidate_mapping_failed"
        : stage === "storage"
          ? "mapped_storage_limits_exceeded"
          : "mapped_campaign_invalid",
      stage,
    );
  }
}
