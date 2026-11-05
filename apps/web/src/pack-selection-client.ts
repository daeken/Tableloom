import { contentPacksViewSchema } from "@tableloom/core/content";
import {
  campaignMembershipSchema,
  campaignUpdateSchema,
} from "@tableloom/core/campaigns";
import type { Campaign } from "@tableloom/core/campaigns";
import type { Member } from "@tableloom/core/access";
import type { BrowserSystem } from "@tableloom/module-sdk/browser";
import type { DocumentRequest } from "./document-client.js";
export interface PackSelectionState {
  current: ReturnType<typeof contentPacksViewSchema.parse> | null;
  draft: { version: number; pins: Campaign["contentPacks"] } | null;
  busy: boolean;
  ready: boolean;
  error: string;
}
export const emptyPackSelection = (): PackSelectionState => ({
  current: null,
  draft: null,
  busy: false,
  ready: false,
  error: "",
});
export const packSelectionDirty = (state: PackSelectionState) =>
  Boolean(
    state.current &&
    state.draft &&
    JSON.stringify(state.current.campaign.contentPacks) !==
      JSON.stringify(state.draft.pins),
  );
export const packSelectionStale = (state: PackSelectionState) =>
  Boolean(
    state.current &&
    state.draft &&
    state.current.campaign.version !== state.draft.version,
  );
export class PackSelectionClient {
  private state = emptyPackSelection();
  private running = false;
  private generation = 0;
  private flight: AbortController | null = null;
  constructor(
    private member: Member,
    private module: BrowserSystem,
    private request: DocumentRequest,
    private changed: (state: PackSelectionState) => void,
  ) {}
  private update(fields: Partial<PackSelectionState>) {
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
    this.update({ busy: false, ready: false });
  }
  private scope(campaign: ReturnType<typeof campaignMembershipSchema.parse>) {
    if (
      this.member.role !== "gm" ||
      campaign.role !== "gm" ||
      campaign.id !== this.member.tableId ||
      campaign.system.id !== this.module.manifest.id ||
      campaign.system.version !== this.module.manifest.version
    )
      throw new Error("Incompatible campaign response.");
  }
  private async operation(
    writing: boolean,
    run: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    if (!this.running || this.flight || this.member.role !== "gm") return false;
    const controller = new AbortController(),
      generation = this.generation;
    this.flight = controller;
    const current = () =>
      this.running &&
      this.flight === controller &&
      generation === this.generation &&
      !controller.signal.aborted;
    this.update({ busy: true, error: "" });
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      await run(controller.signal, current);
      if (controller.signal.aborted) throw new Error("Request timed out.");
      return current();
    } catch {
      if (this.running && this.flight === controller)
        this.update({
          ready: false,
          error: writing
            ? "Pack changes were not confirmed. Refresh to check saved settings; your selection draft is kept. Active overrides and owned copies must be reset or removed before removing their pack."
            : "Pack settings could not load. Check GM access and the current campaign.",
        });
      return false;
    } finally {
      clearTimeout(timeout);
      if (this.flight === controller) {
        this.flight = null;
        this.update({ busy: false });
      }
    }
  }
  load() {
    return this.operation(false, async (signal, current) => {
      const result = contentPacksViewSchema.parse(
        await this.request(
          `/api/campaigns/${this.member.tableId}/content-packs`,
          signal,
        ),
      );
      this.scope(result.campaign);
      if (
        result.packs.some(
          (p) =>
            p.systemId !== result.campaign.system.id ||
            p.systemVersion !== result.campaign.system.version,
        )
      )
        throw new Error("Incompatible content pack.");
      if (current())
        this.update({
          current: result,
          ready: true,
          draft:
            packSelectionDirty(this.state) || packSelectionStale(this.state)
              ? this.state.draft
              : {
                  version: result.campaign.version,
                  pins: result.campaign.contentPacks,
                },
        });
    });
  }
  toggle(id: string, version: string, selected: boolean) {
    if (
      !this.running ||
      !this.state.ready ||
      this.state.busy ||
      !this.state.current ||
      !this.state.draft ||
      packSelectionStale(this.state) ||
      !this.state.current.packs.some(
        (p) => p.id === id && p.version === version,
      )
    )
      return;
    const pins = this.state.draft.pins.filter((p) => p.id !== id);
    if (selected) pins.push({ id, version });
    pins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.update({ draft: { ...this.state.draft, pins }, error: "" });
  }
  discard() {
    if (this.state.ready && !this.state.busy && this.state.current)
      this.update({
        draft: {
          version: this.state.current.campaign.version,
          pins: this.state.current.campaign.contentPacks,
        },
        error: "",
      });
  }
  save() {
    const current = this.state.current,
      draft = this.state.draft;
    if (
      !current ||
      !draft ||
      !this.state.ready ||
      !packSelectionDirty(this.state) ||
      packSelectionStale(this.state)
    )
      return Promise.resolve(false);
    const body = campaignUpdateSchema.parse({
      expectedVersion: draft.version,
      settings: {
        name: current.campaign.name,
        description: current.campaign.description,
        system: current.campaign.system,
        contentPacks: draft.pins,
      },
    });
    return this.operation(true, async (signal, active) => {
      const campaign = campaignMembershipSchema.parse(
        await this.request(
          `/api/campaigns/${this.member.tableId}/settings`,
          signal,
          body,
        ),
      );
      this.scope(campaign);
      if (
        campaign.version !== draft.version + 1 ||
        campaign.activeSceneId !== current.campaign.activeSceneId ||
        campaign.name !== body.settings.name ||
        campaign.description !== body.settings.description ||
        JSON.stringify(campaign.contentPacks) !==
          JSON.stringify(body.settings.contentPacks)
      )
        throw new Error("Unexpected campaign confirmation.");
      if (active())
        this.update({
          current: { ...current, campaign },
          draft: { version: campaign.version, pins: campaign.contentPacks },
          ready: true,
        });
    });
  }
}
