import { z } from "zod";
import {
  contentKey,
  contentViewSchema,
  contentPageSchema,
} from "@tableloom/core/content";
import type { ContentView } from "@tableloom/core/content";
import {
  instanceSchema,
  instanceMetadataSchema,
  instancePageSchema,
  instanceUpdateSchema,
} from "@tableloom/core/instances";
import type {
  OwnedContentInstance,
  InstanceMetadata,
} from "@tableloom/core/instances";
import type { Member } from "@tableloom/core/access";
import type { BrowserSystem } from "@tableloom/module-sdk/browser";
import type { DocumentData } from "@tableloom/module-sdk";
import { DocumentRequestError } from "./document-client.js";
import type { DocumentRequest } from "./document-client.js";

export interface ContentDraft {
  version: number;
  name: string;
  visibility: "gm" | "public";
  data: DocumentData;
}
export interface ContentState {
  definitions: ReturnType<typeof contentPageSchema.parse>["definitions"];
  catalogNext: string | null;
  catalogCursor: string | null;
  instances: InstanceMetadata[];
  next: string | null;
  cursor: string | null;
  definition: ContentView | null;
  instance: OwnedContentInstance | null;
  draft: ContentDraft | null;
  busy: boolean;
  ready: boolean;
  uncertain: boolean;
  error: string;
}
export const emptyContentState = (): ContentState => ({
  definitions: [],
  catalogNext: null,
  catalogCursor: null,
  instances: [],
  next: null,
  cursor: null,
  definition: null,
  instance: null,
  draft: null,
  busy: false,
  ready: false,
  uncertain: false,
  error: "",
});
const draftOf = (instance: OwnedContentInstance): ContentDraft => ({
  version: instance.version,
  name: instance.name,
  visibility: instance.visibility,
  data: instance.data,
});
export const contentDirty = (state: ContentState) =>
  Boolean(
    state.instance &&
    state.draft &&
    JSON.stringify({ ...state.draft, version: state.instance.version }) !==
      JSON.stringify(draftOf(state.instance)),
  );
export const contentStale = (state: ContentState) =>
  Boolean(
    state.instance &&
    state.draft &&
    state.instance.version !== state.draft.version,
  );
const metadataOf = (instance: OwnedContentInstance) =>
  instanceMetadataSchema.parse(
    Object.fromEntries(
      Object.entries(instance).filter(
        ([key]) => key !== "source" && key !== "data",
      ),
    ),
  );
/** One viewer/campaign/module, one bounded request flight. Never replay mutations. */
export class ContentClient {
  private state = emptyContentState();
  private running = false;
  private generation = 0;
  private flight: {
    controller: AbortController;
    generation: number;
    writing: boolean;
  } | null = null;
  constructor(
    private member: Member,
    private module: BrowserSystem,
    private request: DocumentRequest,
    private changed: (state: ContentState) => void,
  ) {}
  private update(fields: Partial<ContentState>) {
    this.state = { ...this.state, ...fields };
    this.changed(this.state);
  }
  start() {
    this.running = true;
  }
  stop() {
    this.running = false;
    this.generation++;
    const writing = this.flight?.writing;
    this.flight?.controller.abort();
    this.flight = null;
    this.update({
      busy: false,
      ready: false,
      ...(writing
        ? {
            uncertain: true,
            error:
              "Save not confirmed. Refresh and check your copies before continuing.",
          }
        : {}),
    });
  }
  private root(kind: "content" | "instances") {
    return `/api/campaigns/${this.member.tableId}/${kind}`;
  }
  private path(ref: ContentView["reference"]) {
    return `${this.root("content")}/${encodeURIComponent(ref.packId)}/${encodeURIComponent(ref.packVersion)}/${encodeURIComponent(ref.definitionId)}`;
  }
  adapter(ref: ContentView["reference"]) {
    return this.module.content?.find(
      (c) => c.id === ref.packId && c.version === ref.packVersion,
    );
  }
  private scope(metadata: {
    campaignId: string;
    system: { id: string; version: string };
  }) {
    if (
      metadata.campaignId !== this.member.tableId ||
      metadata.system.id !== this.module.manifest.id ||
      metadata.system.version !== this.module.manifest.version
    )
      throw new Error(
        "Content does not match this campaign or installed module.",
      );
  }
  private definition(value: unknown, ref: ContentView["reference"]) {
    const d = contentViewSchema.parse(value);
    this.scope(d);
    if (
      contentKey(d.reference) !== contentKey(ref) ||
      (this.member.role !== "gm" && d.visibility !== "public")
    )
      throw new Error("Unexpected catalog response.");
    const adapter = this.adapter(d.reference);
    if (!adapter)
      throw new Error("Compatible module content controls are not installed.");
    return { ...d, data: adapter.parseDefinition(d.data) };
  }
  private metadata(value: InstanceMetadata) {
    this.scope(value);
    if (
      this.member.role !== "gm" &&
      value.visibility !== "public" &&
      value.ownerId !== this.member.id
    )
      throw new Error("Unexpected private copy response.");
  }
  private instance(value: unknown, id?: string) {
    const item = instanceSchema.parse(value);
    this.metadata(item);
    const adapter = this.adapter(item.reference);
    if (
      (id && item.id !== id) ||
      !adapter ||
      adapter.schemaVersion !== item.schemaVersion
    )
      throw new Error(
        "This copy needs compatible module controls or migration.",
      );
    return {
      ...item,
      source: {
        ...item.source,
        data: adapter.parseDefinition(item.source.data),
      },
      data: adapter.parseInstance(item.data),
    };
  }
  editable() {
    return Boolean(
      this.state.instance &&
      (this.member.role === "gm" ||
        this.state.instance.ownerId === this.member.id),
    );
  }
  private clean() {
    if (contentDirty(this.state)) {
      this.update({
        error: "Save or discard your copy draft before choosing another entry.",
      });
      return false;
    }
    return true;
  }
  private async operation(
    writing: boolean,
    run: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    if (!this.running || this.flight) return false;
    const flight = {
      controller: new AbortController(),
      generation: this.generation,
      writing,
    };
    this.flight = flight;
    const active = () =>
        this.running &&
        this.flight === flight &&
        this.generation === flight.generation,
      current = () => active() && !flight.controller.signal.aborted;
    this.update({ busy: true, error: "" });
    const timeout = setTimeout(() => flight.controller.abort(), 10000);
    try {
      await run(flight.controller.signal, current);
      if (active() && flight.controller.signal.aborted)
        throw new Error("Request timed out.");
      return current();
    } catch (error) {
      if (active()) {
        const denied =
          error instanceof DocumentRequestError &&
          [401, 403, 404].includes(error.status);
        this.update({
          ready: false,
          uncertain: writing,
          ...(denied ? { ...emptyContentState(), busy: true } : {}),
          error: writing
            ? "Saving was not confirmed. Refresh and check your copies before trying again."
            : error instanceof DocumentRequestError
              ? error.message
              : "Content could not refresh. Check access and installed module controls.",
        });
      }
      return false;
    } finally {
      clearTimeout(timeout);
      if (this.flight === flight) {
        this.flight = null;
        this.update({ busy: false });
      }
    }
  }
  async refresh(
    catalogCursor = this.state.catalogCursor,
    cursor = this.state.cursor,
  ) {
    return this.operation(false, async (signal, current) => {
      const catalog = contentPageSchema.parse(
        await this.request(
          `${this.root("content")}?limit=25${catalogCursor ? `&after=${encodeURIComponent(catalogCursor)}` : ""}`,
          signal,
        ),
      );
      if (!current()) return;
      catalog.definitions.forEach((d) => {
        this.scope(d);
        if (this.member.role !== "gm" && d.visibility !== "public")
          throw new Error("Unexpected private catalog response.");
      });
      const page = instancePageSchema.parse(
        await this.request(
          `${this.root("instances")}?limit=25${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
          signal,
        ),
      );
      if (!current()) return;
      page.instances.forEach((d) => this.metadata(d));
      const selected = this.state.instance,
        oldDefinition = this.state.definition;
      const instance = selected
        ? this.instance(
            await this.request(
              `${this.root("instances")}/${selected.id}`,
              signal,
            ),
            selected.id,
          )
        : null;
      if (!current()) return;
      const definition = oldDefinition
        ? this.definition(
            await this.request(this.path(oldDefinition.reference), signal),
            oldDefinition.reference,
          )
        : null;
      if (!current()) return;
      const keep = contentDirty(this.state) || contentStale(this.state);
      this.update({
        definitions: catalog.definitions,
        catalogNext: catalog.next,
        catalogCursor,
        instances: page.instances,
        next: page.next,
        cursor,
        definition,
        instance,
        draft: instance ? (keep ? this.state.draft : draftOf(instance)) : null,
        ready: true,
        uncertain: false,
      });
    });
  }
  async openDefinition(ref: ContentView["reference"]) {
    if (!this.clean()) return false;
    return this.operation(false, async (signal, current) => {
      const definition = this.definition(
        await this.request(this.path(ref), signal),
        ref,
      );
      if (current()) this.update({ definition, ready: true, uncertain: false });
    });
  }
  async openInstance(id: string) {
    if (!this.clean()) return false;
    return this.operation(false, async (signal, current) => {
      const instance = this.instance(
        await this.request(
          `${this.root("instances")}/${z.uuid().parse(id)}`,
          signal,
        ),
        id,
      );
      if (current())
        this.update({
          instance,
          draft: draftOf(instance),
          ready: true,
          uncertain: false,
        });
    });
  }
  async create() {
    const definition = this.state.definition;
    if (
      !definition ||
      !this.state.ready ||
      this.state.uncertain ||
      !this.clean()
    )
      return false;
    return this.operation(true, async (signal, current) => {
      const instance = this.instance(
        await this.request(this.root("instances"), signal, {
          reference: definition.reference,
          expectedRevision: definition.revision,
        }),
      );
      if (
        instance.ownerId !== this.member.id ||
        instance.visibility !== "gm" ||
        instance.version !== 1 ||
        contentKey(instance.reference) !== contentKey(definition.reference) ||
        instance.definitionRevision !== definition.revision ||
        instance.kind !== definition.kind ||
        JSON.stringify(instance.source) !==
          JSON.stringify({
            name: definition.name,
            kind: definition.kind,
            data: definition.data,
            sources: definition.sources,
          })
      )
        throw new Error("Unexpected creation confirmation.");
      if (current())
        this.update({
          instance,
          draft: draftOf(instance),
          instances: [
            metadataOf(instance),
            ...this.state.instances.filter((i) => i.id !== instance.id),
          ].slice(0, 25),
          ready: true,
          uncertain: false,
        });
    });
  }
  change(
    fields: Partial<Pick<ContentDraft, "name" | "visibility" | "data">>,
    id: string,
    version: number,
  ) {
    if (
      !this.running ||
      !this.state.ready ||
      this.state.busy ||
      !this.editable() ||
      contentStale(this.state) ||
      !this.state.instance ||
      !this.state.draft ||
      id !== this.state.instance.id ||
      version !== this.state.draft.version
    )
      return;
    try {
      const draft = { ...this.state.draft, ...fields };
      draft.data = this.adapter(this.state.instance.reference)!.parseInstance(
        draft.data,
      );
      this.update({ draft, error: "" });
    } catch {
      this.update({
        error: "Check the module fields. This change was not accepted.",
      });
    }
  }
  discard() {
    if (!this.state.ready || this.state.busy || !this.state.instance) return;
    this.update({
      draft: draftOf(this.state.instance),
      uncertain: false,
      error: "",
    });
  }
  async save() {
    const before = this.state.instance,
      draft = this.state.draft;
    if (
      !before ||
      !draft ||
      !this.state.ready ||
      this.state.uncertain ||
      !this.editable() ||
      contentStale(this.state) ||
      !contentDirty(this.state)
    )
      return false;
    const parsed = instanceUpdateSchema.safeParse({
      expectedVersion: draft.version,
      name: draft.name,
      visibility: draft.visibility,
      data: draft.data,
    });
    if (!parsed.success) {
      this.update({
        error: "Check the copy name and module fields before saving.",
      });
      return false;
    }
    const body = parsed.data;
    return this.operation(true, async (signal, current) => {
      const instance = this.instance(
        await this.request(
          `${this.root("instances")}/${before.id}`,
          signal,
          body,
        ),
        before.id,
      );
      const {
        name: oldName,
        visibility: oldVisibility,
        data: oldData,
        version: oldVersion,
        ...immutableBefore
      } = before;
      const { name, visibility, data, version, ...immutableAfter } = instance;
      void oldName;
      void oldVisibility;
      void oldData;
      void data;
      if (
        name !== body.name ||
        visibility !== body.visibility ||
        version !== oldVersion + 1 ||
        JSON.stringify(immutableBefore) !== JSON.stringify(immutableAfter)
      )
        throw new Error("Unexpected copy confirmation.");
      if (current())
        this.update({
          instance,
          draft: draftOf(instance),
          instances: this.state.instances.map((i) =>
            i.id === instance.id ? metadataOf(instance) : i,
          ),
          ready: true,
          uncertain: false,
        });
    });
  }
}
