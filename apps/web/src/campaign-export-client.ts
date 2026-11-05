import { z } from "zod";
import {
  campaignMembershipSchema,
  campaignSchema,
} from "@tableloom/core/campaigns";
import type { Member } from "@tableloom/core/access";

import {
  MAX_TRANSFER_FILE_BYTES,
  transferFileMetadataSchema,
} from "@tableloom/core/campaign-transfer";
import { readTransferBytes } from "./transfer-http.js";
export const MAX_EXPORT_DOWNLOAD_BYTES = MAX_TRANSFER_FILE_BYTES;
type Campaign = z.infer<typeof campaignMembershipSchema>;
export interface CampaignExportState {
  campaign: Campaign | null;
  busy: "review" | "export" | null;
  acknowledged: boolean;
  artifact: { blob: Blob; filename: string; bytes: number } | null;
  error: string;
}
export const emptyCampaignExport = (): CampaignExportState => ({
  campaign: null,
  busy: null,
  acknowledged: false,
  artifact: null,
  error: "",
});
export type ExportRequest = (
  path: string,
  init: RequestInit,
) => Promise<Response>;
export const exportRequest: ExportRequest = (path, init) => fetch(path, init);

function responseFailure(status: number) {
  if (status === 401)
    return "Sign in again, then review this campaign before exporting.";
  if (status === 403)
    return "GM access to the active campaign is required to export it.";
  if (status === 409)
    return "Campaign settings changed. Review the latest settings and confirm the private export again.";
  if (status === 413)
    return "This campaign exceeds the portable file limit. Use a whole-instance backup instead.";
  return "The export could not be prepared. Review the campaign and try again.";
}
export class CampaignExportClient {
  private state = emptyCampaignExport();
  private running = false;
  private flight: AbortController | null = null;
  private generation = 0;
  constructor(
    private member: Member,
    private request: ExportRequest,
    private changed: (state: CampaignExportState) => void,
    private timeoutMs = 30_000,
  ) {}
  private update(fields: Partial<CampaignExportState>) {
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
    this.state = emptyCampaignExport();
    this.changed(this.state);
  }
  acknowledge(value: boolean) {
    if (!this.running || this.flight || !this.state.campaign) return;
    this.update({ acknowledged: value, artifact: null });
  }
  private async operation(
    stage: "review" | "export",
    run: (signal: AbortSignal) => Promise<Partial<CampaignExportState>>,
  ) {
    if (!this.running || this.flight || this.member.role !== "gm") return false;
    const controller = new AbortController(),
      generation = this.generation;
    this.flight = controller;
    this.update({ busy: stage, artifact: null, error: "" });
    const current = () =>
      this.running &&
      this.flight === controller &&
      generation === this.generation;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await run(controller.signal);
      controller.signal.throwIfAborted();
      if (!current()) return false;
      this.update(result);
      return true;
    } catch (error) {
      if (current())
        this.update({
          campaign: null,
          acknowledged: false,
          artifact: null,
          error: controller.signal.aborted
            ? "The request timed out. Review the campaign and try again."
            : error instanceof ExportFailure
              ? error.message
              : "The server did not return a valid campaign file or review. Review the campaign and try again.",
        });
      return false;
    } finally {
      clearTimeout(timer);
      if (this.flight === controller) {
        this.flight = null;
        this.update({ busy: null });
      }
    }
  }
  private async read(
    path: string,
    signal: AbortSignal,
    body?: unknown,
    limit = 256 * 1024,
  ) {
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
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ExportFailure(responseFailure(response.status));
    }
    return readTransferBytes(response, limit, signal);
  }
  review() {
    if (this.flight) return Promise.resolve(false);
    this.update({ campaign: null, acknowledged: false, artifact: null });
    return this.operation("review", async (signal) => {
      const bytes = await this.read(
        `/api/campaigns/${encodeURIComponent(this.member.tableId)}`,
        signal,
      );
      const campaign = campaignMembershipSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      if (campaign.id !== this.member.tableId || campaign.role !== "gm")
        throw new Error("Invalid campaign review.");
      return { campaign, acknowledged: false };
    });
  }
  download() {
    const campaign = this.state.campaign;
    if (!campaign || !this.state.acknowledged) return Promise.resolve(false);
    return this.operation("export", async (signal) => {
      const bytes = await this.read(
        `/api/campaigns/${encodeURIComponent(campaign.id)}/export`,
        signal,
        {
          expectedVersion: campaign.version,
          include: "all-campaign-content-including-private",
        },
        MAX_EXPORT_DOWNLOAD_BYTES,
      );
      // Inspect only transfer metadata; saved resource contents belong to destination preflight.
      const envelope = transferFileMetadataSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      const { role: _role, ...reviewed } = campaign;
      if (
        JSON.stringify(envelope.campaign) !==
        JSON.stringify(campaignSchema.parse(reviewed))
      )
        throw new Error("Export scope changed.");
      return {
        artifact: {
          blob: new Blob([bytes], { type: "application/json" }),
          filename: `tableloom-campaign-${campaign.id}.json`,
          bytes: bytes.byteLength,
        },
      };
    });
  }
}
class ExportFailure extends Error {}
