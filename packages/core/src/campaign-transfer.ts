import { z } from "zod";
import { memberSchema } from "./access.js";
import {
  campaignMembershipSchema,
  campaignSchema,
  versionPinSchema,
} from "./campaigns.js";

export const MAX_TRANSFER_FILE_BYTES = 32 * 1024 * 1024;
export const FRESH_RESOURCE_POLICY =
  "fresh-campaign-and-resource-identifiers" as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  count = z.number().int().nonnegative();
export const transferTargetSchema = z.discriminatedUnion("kind", [
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
]);
export const ownershipPlanSchema = z
  .object({
    version: z.literal(1),
    archiveSha256: hash,
    acknowledge: z.literal("reviewed-private-content-and-access"),
    acknowledgeMerges: z.boolean(),
    assignments: z
      .array(
        z.object({ sourceId: z.uuid(), target: transferTargetSchema }).strict(),
      )
      .max(1000),
  })
  .strict();
export type OwnershipPlan = z.infer<typeof ownershipPlanSchema>;
export type TransferTarget = z.infer<typeof transferTargetSchema>;
export const transferFileMetadataSchema = z.object({
  format: z.literal("tableloom-campaign-export"),
  version: z.literal(1),
  privacy: z.literal("all-campaign-content-including-private"),
  identityPolicy: z.literal("source-identifiers-without-access-grants"),
  assetEncoding: z.literal("base64"),
  campaign: campaignSchema,
});
const person = z
  .object({ id: z.uuid(), name: memberSchema.shape.name })
  .strict();
export const importPeopleQuerySchema = z
  .object({
    after: z.uuid().optional(),
    q: z.string().trim().max(32).optional(),
  })
  .strict();
export const importPeoplePageSchema = z
  .object({
    host: person,
    people: z.array(person).max(100),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
const status = z.enum([
  "available",
  "unavailable",
  "changed",
  "incompatible",
  "historical-only",
]);
const resourceNames = [
  "campaign_records",
  "scene_records",
  "campaign_receipts",
  "command_bindings",
  "object_id_reservations",
  "module_documents",
  "content_overrides",
  "content_instances",
  "campaign_assets",
  "scene_backgrounds",
  "scene_background_history",
  "scene_background_history_refs",
  "scene_grids",
  "scene_history_entries",
  "roll_archive",
  "chat_messages",
] as const;
const sourceSubject = z.object({
  sourceId: z.uuid(),
  name: memberSchema.shape.name.nullable(),
  sourceRole: memberSchema.shape.role.nullable(),
});
export const transferInspectionSchema = z.object({
  status: z.literal("preflight-only"),
  importReady: z.literal(false),
  archiveSha256: hash,
  campaign: z.object({ id: z.uuid(), name: campaignSchema.shape.name }),
  resourceCounts: z.record(z.enum(resourceNames), count.max(100000)),
  packages: z.object({
    system: versionPinSchema.extend({ status }),
    contentPacks: z
      .array(
        versionPinSchema.extend({
          selected: z.boolean(),
          sha256: hash,
          status,
        }),
      )
      .max(1100),
  }),
  blockers: z.array(z.string().max(128)).max(100),
  pendingValidation: z.array(z.string().max(128)).max(100),
  ownership: z.object({
    policy: z.literal("explicit-mapping-required"),
    subjects: z
      .array(sourceSubject)
      .max(1000)
      .refine(
        (rows) => new Set(rows.map((r) => r.sourceId)).size === rows.length,
      ),
  }),
  moduleReferenceValidation: z.object({
    records: count,
    references: count,
    complete: z.boolean(),
  }),
});
export const transferOwnershipReviewSchema = transferInspectionSchema
  .omit({ status: true })
  .extend({
    status: z.literal("ownership-review-only"),
    ownershipReview: z.object({
      complete: z.boolean(),
      planSha256: hash,
      plan: ownershipPlanSchema,
      assignments: z
        .array(
          z.object({
            sourceId: z.uuid(),
            target: z.discriminatedUnion("kind", [
              transferTargetSchema.options[0]
                .extend({ name: memberSchema.shape.name })
                .strict(),
              transferTargetSchema.options[1],
              transferTargetSchema.options[2],
            ]),
          }),
        )
        .max(1000),
      mergedTargets: z
        .array(
          z.object({
            userId: z.uuid(),
            sourceIds: z.array(z.uuid()).min(2).max(1000),
          }),
        )
        .max(500),
      counts: z.object({
        existingUsers: count,
        newUsers: count,
        unclaimed: count,
        memberships: count,
        membershipLimit: z.literal(1000),
      }),
      host: z.object({ userId: z.uuid(), role: z.literal("gm") }),
    }),
  });
export const transferCandidateSchema = transferOwnershipReviewSchema
  .omit({ status: true })
  .extend({
    status: z.literal("candidate-preflight-only"),
    resourcePlan: z.object({
      policy: z.literal(FRESH_RESOURCE_POLICY),
      complete: z.boolean(),
      targetCampaignId: z.uuid().nullable(),
      candidateSha256: hash.nullable(),
    }),
    candidateValidation: z.object({
      complete: z.boolean(),
      failedStage: z.string().max(64).nullable(),
    }),
  });
export type TransferInspection = z.infer<typeof transferInspectionSchema>;
export type TransferOwnershipReview = z.infer<
  typeof transferOwnershipReviewSchema
>;
export type TransferCandidate = z.infer<typeof transferCandidateSchema>;
export type ImportPeoplePage = z.infer<typeof importPeoplePageSchema>;

export const transferImportReceiptSchema = z
  .object({
    status: z.literal("imported"),
    requestId: z.uuid(),
    archiveSha256: hash,
    ownershipPlanSha256: hash,
    resourcePolicy: z.literal(FRESH_RESOURCE_POLICY),
    importedAt: z.iso.datetime(),
    campaign: campaignMembershipSchema.refine(
      (campaign) => campaign.role === "gm",
    ),
    summary: z
      .object({
        createdPeople: count,
        attributionRecords: count,
        memberships: count.positive(),
        rows: count,
      })
      .strict(),
  })
  .strict();
export const transferImportResultSchema = transferImportReceiptSchema
  .extend({ replayed: z.boolean() })
  .strict();
export const transferImportStatusSchema = z
  .object({
    status: z.literal("import-request-status"),
    hostId: z.uuid(),
    requestId: z.uuid(),
    archiveSha256: hash,
    result: transferImportResultSchema
      .extend({ replayed: z.literal(true) })
      .nullable(),
  })
  .strict();
export type TransferImportReceipt = z.infer<typeof transferImportReceiptSchema>;
export type TransferImportResult = z.infer<typeof transferImportResultSchema>;
export type TransferImportStatus = z.infer<typeof transferImportStatusSchema>;
