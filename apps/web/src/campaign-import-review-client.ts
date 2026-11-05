import { z } from "zod";
import {
  MAX_TRANSFER_FILE_BYTES,
  FRESH_RESOURCE_POLICY,
  transferFileMetadataSchema,
  importPeoplePageSchema,
  transferInspectionSchema,
  transferOwnershipReviewSchema,
  transferCandidateSchema,
  ownershipPlanSchema,
  transferTargetSchema,
} from "@tableloom/core/campaign-transfer";
import type {
  ImportPeoplePage,
  TransferInspection,
  TransferOwnershipReview,
  TransferCandidate,
  OwnershipPlan,
} from "@tableloom/core/campaign-transfer";
import { readTransferBytes } from "./transfer-http.js";
import type { ExportRequest } from "./campaign-export-client.js";

type Role = "gm" | "player";
export type ImportChoice =
  | { kind: "unclaimed" }
  | { kind: "new"; name: string; role: Role }
  | { kind: "existing"; userId: string; role: Role; label: string };
export interface ImportReviewState {
  host: ImportPeoplePage["host"] | null;
  people: ImportPeoplePage["people"];
  nextCursor: string | null;
  peopleQuery: string;
  file: { name: string; bytes: number } | null;
  uploadConsent: boolean;
  inspection: TransferInspection | null;
  choices: Record<string, ImportChoice>;
  reviewConsent: boolean;
  mergeConsent: boolean;
  review: TransferOwnershipReview | null;
  candidate: TransferCandidate | null;
  busy: "people" | "file" | "inspect" | "ownership" | "candidate" | null;
  error: string;
}
export const emptyImportReview = (): ImportReviewState => ({
  host: null,
  people: [],
  nextCursor: null,
  peopleQuery: "",
  file: null,
  uploadConsent: false,
  inspection: null,
  choices: {},
  reviewConsent: false,
  mergeConsent: false,
  review: null,
  candidate: null,
  busy: null,
  error: "",
});
const targetOf = (choice: ImportChoice | undefined) =>
  !choice
    ? undefined
    : choice.kind === "existing"
      ? { kind: choice.kind, userId: choice.userId, role: choice.role }
      : choice;
export const reviewedChoiceCount = (state: ImportReviewState) =>
  state.inspection?.ownership.subjects.filter(
    (s) =>
      transferTargetSchema.safeParse(targetOf(state.choices[s.sourceId]))
        .success,
  ).length ?? 0;
export function mergedChoices(state: ImportReviewState) {
  const groups = new Map<string, string[]>();
  for (const [sourceId, choice] of Object.entries(state.choices))
    if (choice.kind === "existing" && choice.userId) {
      const group = groups.get(choice.userId) ?? [];
      group.push(sourceId);
      groups.set(choice.userId, group);
    }
  return [...groups]
    .filter(([, sources]) => sources.length > 1)
    .map(([userId, sources]) => ({ userId, sources }));
}
export function buildReviewPlan(
  state: ImportReviewState,
): OwnershipPlan | null {
  if (
    !state.inspection ||
    !state.reviewConsent ||
    (mergedChoices(state).length > 0 && !state.mergeConsent)
  )
    return null;
  const plan = ownershipPlanSchema.safeParse({
    version: 1,
    archiveSha256: state.inspection.archiveSha256,
    acknowledge: "reviewed-private-content-and-access",
    acknowledgeMerges: state.mergeConsent,
    assignments: state.inspection.ownership.subjects.map((s) => ({
      sourceId: s.sourceId,
      target: targetOf(state.choices[s.sourceId]),
    })),
  });
  if (
    !plan.success ||
    new TextEncoder().encode(JSON.stringify(plan.data)).byteLength > 512 * 1024
  )
    return null;
  plan.data.assignments.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return plan.data;
}
class ReviewFailure extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
const requestFailure = (status: number) =>
  new ReviewFailure(
    status === 401
      ? "Sign in again before reviewing a campaign import."
      : status === 403
        ? "Only the signed-in server host can review campaign imports. No file was imported."
        : status === 409
          ? "The file, local people or destination state changed. Review your choices again."
          : status === 413
            ? "This request is too large. Campaign files are limited to 32 MiB; use a whole-instance backup for larger campaigns."
            : status === 503
              ? "Another file inspection is running. Wait for it to finish, then try again."
              : "The file could not be checked. Use a supported campaign export and compatible installed game modules, then try again.",
    status,
  );
export class CampaignImportReviewClient {
  private state = emptyImportReview();
  private source: string | null = null;
  private sourceCampaign: { id: string; name: string } | null = null;
  private running = false;
  private generation = 0;
  private flight: AbortController | null = null;
  constructor(
    private request: ExportRequest,
    private changed: (state: ImportReviewState) => void,
    private timeoutMs = 30_000,
  ) {}
  private update(fields: Partial<ImportReviewState>) {
    this.state = { ...this.state, ...fields };
    this.changed(this.state);
  }
  start() {
    this.running = true;
  }
  stop() {
    this.running = false;
    this.generation++;
    this.flight?.abort();
    this.flight = null;
    this.source = null;
    this.sourceCampaign = null;
    this.state = emptyImportReview();
    this.changed(this.state);
  }
  private async operation(
    stage: NonNullable<ImportReviewState["busy"]>,
    run: (
      signal: AbortSignal,
      current: () => boolean,
    ) => Promise<Partial<ImportReviewState>>,
  ) {
    if (!this.running || this.flight) return false;
    const controller = new AbortController(),
      generation = this.generation;
    this.flight = controller;
    this.update({ busy: stage, error: "" });
    const current = () =>
      this.running &&
      this.flight === controller &&
      this.generation === generation;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await run(controller.signal, current);
      controller.signal.throwIfAborted();
      if (!current()) return false;
      this.update(result);
      return true;
    } catch (error) {
      if (current()) {
        if (
          error instanceof ReviewFailure &&
          [401, 403].includes(error.status)
        ) {
          this.source = null;
          this.sourceCampaign = null;
          this.state = emptyImportReview();
        }
        this.update({
          review: null,
          candidate: null,
          reviewConsent: false,
          error: controller.signal.aborted
            ? "The review timed out. Nothing was imported; try the check again."
            : error instanceof ReviewFailure
              ? error.message
              : "The server did not return a valid review. Nothing was imported; try again.",
        });
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (this.flight === controller) {
        this.flight = null;
        this.update({ busy: null });
      }
    }
  }
  private async json(path: string, signal: AbortSignal, body?: string) {
    const response = await this.request(path, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw requestFailure(response.status);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readTransferBytes(response, 2 * 1024 * 1024, signal),
      ),
    ) as unknown;
  }
  loadPeople(q = "", after?: string) {
    if (q.trim().length > 32) return Promise.resolve(false);
    return this.operation("people", async (signal) => {
      const query = new URLSearchParams();
      if (q.trim()) query.set("q", q.trim());
      if (after) query.set("after", z.uuid().parse(after));
      const page = importPeoplePageSchema.parse(
        await this.json(
          `/api/campaign-imports/people${query.size ? `?${query}` : ""}`,
          signal,
        ),
      );
      if (this.state.host && page.host.id !== this.state.host.id)
        throw new ReviewFailure(
          "The signed-in host changed. Reopen the review before selecting a file.",
          403,
        );
      if (
        new Set(page.people.map((p) => p.id)).size !== page.people.length ||
        (page.nextCursor !== null && page.nextCursor !== page.people.at(-1)?.id)
      )
        throw new Error("Invalid people page.");
      return {
        host: page.host,
        people: page.people,
        nextCursor: page.nextCursor,
        peopleQuery: q.trim(),
      };
    });
  }
  selectFile(file: File) {
    if (!this.running || !this.state.host) return Promise.resolve(false);
    this.generation++;
    this.flight?.abort();
    this.flight = null;
    this.source = null;
    this.sourceCampaign = null;
    this.update({
      file: null,
      inspection: null,
      choices: {},
      review: null,
      candidate: null,
      uploadConsent: false,
      reviewConsent: false,
      mergeConsent: false,
      busy: null,
    });
    return this.operation("file", async (signal, current) => {
      if (file.size === 0 || file.size > MAX_TRANSFER_FILE_BYTES)
        throw new ReviewFailure(
          "Choose a nonempty campaign export file of at most 32 MiB.",
        );
      const bytes = await readTransferBytes(
        new Response(file, { headers: { "Content-Type": "application/json" } }),
        MAX_TRANSFER_FILE_BYTES,
        signal,
      );
      let source: string, metadata: z.infer<typeof transferFileMetadataSchema>;
      try {
        source = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        metadata = transferFileMetadataSchema.parse(JSON.parse(source));
      } catch {
        throw new ReviewFailure(
          "Choose a valid UTF-8 Tableloom campaign export. Unsupported files are not uploaded.",
        );
      }
      if (!current()) return {};
      this.source = source;
      this.sourceCampaign = {
        id: metadata.campaign.id,
        name: metadata.campaign.name,
      };
      return {
        file: { name: file.name.slice(0, 255), bytes: bytes.byteLength },
      };
    });
  }
  acknowledgeUpload(value: boolean) {
    if (!this.running || this.flight || !this.source) return;
    this.update({
      uploadConsent: value,
      inspection: null,
      choices: {},
      reviewConsent: false,
      mergeConsent: false,
      review: null,
      candidate: null,
    });
  }
  inspect() {
    if (
      !this.source ||
      !this.state.host ||
      !this.state.uploadConsent ||
      this.flight
    )
      return Promise.resolve(false);
    const source = this.source;
    this.update({
      inspection: null,
      choices: {},
      reviewConsent: false,
      mergeConsent: false,
      review: null,
      candidate: null,
    });
    return this.operation("inspect", async (signal) => {
      const report = transferInspectionSchema.parse(
        await this.json("/api/campaign-imports/preflight", signal, source),
      );
      this.checkScope(report);
      if (report.pendingValidation.includes("image-decoding"))
        throw new Error("Images were not inspected.");
      return { inspection: report };
    });
  }
  choose(sourceId: string, choice: ImportChoice) {
    if (
      !this.running ||
      this.flight ||
      !this.state.inspection?.ownership.subjects.some(
        (s) => s.sourceId === sourceId,
      )
    )
      return;
    let target = choice;
    if (choice.kind === "existing" && choice.userId) {
      const person =
          choice.userId === this.state.host?.id
            ? this.state.host
            : this.state.people.find((p) => p.id === choice.userId),
        previous = this.state.choices[sourceId];
      if (
        !person &&
        !(previous?.kind === "existing" && previous.userId === choice.userId)
      )
        return;
      target = {
        ...choice,
        label:
          person?.name ?? (previous?.kind === "existing" ? previous.label : ""),
        role:
          choice.userId === this.state.host?.id
            ? "gm"
            : previous?.kind === "existing" && previous.userId === choice.userId
              ? choice.role
              : "player",
      };
    }
    this.update({
      choices: { ...this.state.choices, [sourceId]: target },
      reviewConsent: false,
      mergeConsent: false,
      review: null,
      candidate: null,
      error: "",
    });
  }
  acknowledgeReview(value: boolean) {
    if (this.running && !this.flight)
      this.update({ reviewConsent: value, review: null, candidate: null });
  }
  acknowledgeMerges(value: boolean) {
    if (this.running && !this.flight)
      this.update({
        mergeConsent: value,
        reviewConsent: false,
        review: null,
        candidate: null,
      });
  }
  private checkScope(report: {
    archiveSha256: string;
    campaign: { id: string; name: string };
  }) {
    if (
      !this.sourceCampaign ||
      report.campaign.id !== this.sourceCampaign.id ||
      report.campaign.name !== this.sourceCampaign.name
    )
      throw new Error("Review belongs to another file.");
    if (
      this.state.inspection &&
      report.archiveSha256 !== this.state.inspection.archiveSha256
    )
      throw new Error("File fingerprint changed.");
  }
  private checkReview(
    report: TransferOwnershipReview | TransferCandidate,
    plan: OwnershipPlan,
  ) {
    this.checkScope(report);
    if (report.ownershipReview.host.userId !== this.state.host?.id)
      throw new ReviewFailure(
        "The signed-in host changed. Reopen the review before selecting a file.",
        403,
      );
    if (
      JSON.stringify(report.ownershipReview.plan) !== JSON.stringify(plan) ||
      JSON.stringify(
        report.ownershipReview.assignments.map(({ sourceId, target }) => ({
          sourceId,
          target:
            target.kind === "existing"
              ? { kind: target.kind, userId: target.userId, role: target.role }
              : target,
        })),
      ) !== JSON.stringify(plan.assignments) ||
      JSON.stringify(report.ownership.subjects) !==
        JSON.stringify(this.state.inspection?.ownership.subjects)
    )
      throw new Error("Ownership review changed.");
  }
  reviewOwnership() {
    const plan = buildReviewPlan(this.state),
      source = this.source;
    if (
      !plan ||
      !source ||
      this.flight ||
      this.state.inspection?.blockers.length ||
      !this.state.inspection?.moduleReferenceValidation.complete
    )
      return Promise.resolve(false);
    this.update({ review: null, candidate: null });
    return this.operation("ownership", async (signal) => {
      const review = transferOwnershipReviewSchema.parse(
        await this.json(
          "/api/campaign-imports/ownership-review",
          signal,
          JSON.stringify({ file: source, plan }),
        ),
      );
      this.checkReview(review, plan);
      return { review };
    });
  }
  prepare() {
    const review = this.state.review,
      source = this.source;
    if (
      !source ||
      !review?.ownershipReview.complete ||
      review.blockers.length ||
      this.flight
    )
      return Promise.resolve(false);
    this.update({ candidate: null });
    return this.operation("candidate", async (signal) => {
      const candidate = transferCandidateSchema.parse(
        await this.json(
          "/api/campaign-imports/prepare",
          signal,
          JSON.stringify({
            file: source,
            plan: review.ownershipReview.plan,
            resourcePolicy: FRESH_RESOURCE_POLICY,
          }),
        ),
      );
      this.checkReview(candidate, review.ownershipReview.plan);
      if (
        candidate.ownershipReview.planSha256 !==
          review.ownershipReview.planSha256 ||
        (candidate.resourcePlan.complete &&
          (!candidate.candidateValidation.complete ||
            !candidate.resourcePlan.targetCampaignId ||
            !candidate.resourcePlan.candidateSha256 ||
            candidate.blockers.length ||
            JSON.stringify(candidate.pendingValidation) !==
              JSON.stringify(["atomic-import"])))
      )
        throw new Error("Incomplete candidate validation.");
      return { candidate };
    });
  }
}
