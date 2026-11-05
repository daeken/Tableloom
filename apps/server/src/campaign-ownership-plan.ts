import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { memberSchema } from "@tableloom/core/access";
import { StoreError } from "./store.js";
import type { inspectCampaignTransfer } from "./campaign-preflight.js";
import { MAX_CAMPAIGN_EXPORT_BYTES } from "./campaign-export.js";

export const MAX_OWNERSHIP_REVIEW_BYTES = 65 * 1024 * 1024;
export const FRESH_RESOURCE_POLICY =
  "fresh-campaign-and-resource-identifiers" as const;
const MAX_PLAN_BYTES = 512 * 1024;
const assignmentSchema = z
  .object({
    sourceId: z.uuid(),
    target: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("existing"),
          userId: z.uuid(),
          role: memberSchema.shape.role,
        })
        .strict(),
      z
        .object({
          kind: z.literal("new"),
          name: memberSchema.shape.name,
          role: memberSchema.shape.role,
        })
        .strict(),
      z.object({ kind: z.literal("unclaimed") }).strict(),
    ]),
  })
  .strict();
export const ownershipPlanSchema = z
  .object({
    version: z.literal(1),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    acknowledge: z.literal("reviewed-private-content-and-access"),
    acknowledgeMerges: z.boolean(),
    assignments: z.array(assignmentSchema).max(1000),
  })
  .strict();
export type OwnershipPlan = z.infer<typeof ownershipPlanSchema>;

export function parseOwnershipPlan(raw: unknown): OwnershipPlan {
  // Charge array length before Zod clones/validates individual entries.
  if (
    raw &&
    typeof raw === "object" &&
    "assignments" in raw &&
    Array.isArray(raw.assignments) &&
    raw.assignments.length > 1000
  )
    throw new StoreError(
      "Ownership review accepts at most 1,000 identities.",
      400,
    );
  const plan = ownershipPlanSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(plan)) > MAX_PLAN_BYTES)
    throw new StoreError("Ownership plan is too large.", 400);
  plan.assignments.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return plan;
}

/** Preserve the exact source file, rather than reserializing an embedded object. */
export function parseOwnershipReviewEnvelope(serialized: string) {
  return parseEnvelope(serialized, false);
}
export function parsePreparationEnvelope(serialized: string) {
  return parseEnvelope(serialized, true);
}
function parseEnvelope(serialized: string, preparation: boolean) {
  try {
    if (Buffer.byteLength(serialized) > MAX_OWNERSHIP_REVIEW_BYTES)
      throw new Error("Ownership review envelope is too large.");
    const schema = z
      .object({
        file: z.string().max(MAX_CAMPAIGN_EXPORT_BYTES),
        plan: z.unknown(),
      })
      .strict();
    const raw = (
      preparation
        ? schema.extend({ resourcePolicy: z.literal(FRESH_RESOURCE_POLICY) })
        : schema
    ).parse(JSON.parse(serialized));
    if (
      Buffer.byteLength(raw.file) > MAX_CAMPAIGN_EXPORT_BYTES ||
      Buffer.from(raw.file).toString("utf8") !== raw.file
    )
      throw new Error("Invalid source file encoding/size.");
    return { file: raw.file, plan: parseOwnershipPlan(raw.plan) };
  } catch {
    throw new StoreError(
      "Send a bounded campaign file and ownership plan.",
      400,
    );
  }
}

type SourceReport = ReturnType<typeof inspectCampaignTransfer>;
/** Read-only candidate review. No identifier allocation, membership grants or import token. */
export function reviewCampaignOwnership<T extends SourceReport>(
  report: T,
  rawPlan: unknown,
  db: DatabaseSync,
  hostId: string,
) {
  const plan = parseOwnershipPlan(rawPlan);
  if (plan.archiveSha256 !== report.archiveSha256)
    throw new StoreError(
      "The ownership plan belongs to a different campaign file.",
      409,
    );
  const expected = new Set(
    report.ownership.subjects.map((subject) => subject.sourceId),
  );
  for (const assignment of plan.assignments)
    if (!expected.delete(assignment.sourceId))
      throw new StoreError("Review every source identity exactly once.", 400);
  if (expected.size)
    throw new StoreError("Review every source identity exactly once.", 400);
  if (db.isTransaction)
    throw new Error(
      "Ownership review needs its own destination read snapshot.",
    );
  db.exec("BEGIN");
  try {
    const owner = db
      .prepare("SELECT user_id FROM access_host WHERE id=1")
      .get();
    if (owner?.user_id !== hostId)
      throw new StoreError("Only the server host can review ownership.", 403);
    const local = db.prepare("SELECT id,name FROM access_users WHERE id=?"),
      selected = new Map<string, { role: "gm" | "player"; sources: string[] }>([
        [hostId, { role: "gm", sources: [] }],
      ]);
    let newUsers = 0,
      unclaimed = 0;
    const assignments = plan.assignments.map((assignment) => {
      const target = assignment.target;
      if (target.kind === "unclaimed") {
        unclaimed++;
        return { sourceId: assignment.sourceId, target };
      }
      if (target.kind === "new") {
        newUsers++;
        return { sourceId: assignment.sourceId, target };
      }
      const person = z
        .object({ id: z.uuid(), name: memberSchema.shape.name })
        .optional()
        .parse(local.get(target.userId));
      if (!person)
        throw new StoreError("A reviewed local identity is unavailable.", 409);
      const previous = selected.get(person.id);
      if (previous && previous.role !== target.role)
        throw new StoreError(
          "Choose one consistent role per local identity; the server host must remain a GM.",
          400,
        );
      const choice = previous ?? { role: target.role, sources: [] };
      choice.sources.push(assignment.sourceId);
      selected.set(person.id, choice);
      return {
        sourceId: assignment.sourceId,
        target: { ...target, name: person.name },
      };
    });
    const mergedTargets = [...selected]
        .filter(([, target]) => target.sources.length > 1)
        .map(([userId, target]) => ({ userId, sourceIds: target.sources })),
      memberCount = selected.size + newUsers,
      blockers = [...report.blockers];
    if (mergedTargets.length && !plan.acknowledgeMerges)
      blockers.push("identity_merge_acknowledgement_required");
    if (memberCount > 1000) blockers.push("import_member_capacity_reached");
    const complete =
      report.moduleReferenceValidation.complete &&
      (!mergedTargets.length || plan.acknowledgeMerges) &&
      memberCount <= 1000;
    const { status: _sourceStatus, ...source } = report;
    db.exec("COMMIT");
    return {
      ...source,
      status: "ownership-review-only" as const,
      importReady: false as const,
      blockers: blockers.sort(),
      pendingValidation: report.pendingValidation.filter(
        (item) => item !== "ownership-plan" || !complete,
      ),
      ownershipReview: {
        complete,
        planSha256: createHash("sha256")
          .update(JSON.stringify(plan))
          .digest("hex"),
        plan,
        assignments,
        mergedTargets,
        counts: {
          existingUsers: selected.size,
          newUsers,
          unclaimed,
          memberships: memberCount,
          membershipLimit: 1000,
        },
        host: { userId: hostId, role: "gm" as const },
      },
    };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
export type CampaignOwnershipReview = ReturnType<
  typeof reviewCampaignOwnership<SourceReport>
>;
