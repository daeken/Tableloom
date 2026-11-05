import { z } from "zod";
import {
  documentSchema,
  documentPageSchema,
  documentUpdateSchema,
  documentActionSchema,
} from "@tableloom/core/documents";
import type {
  SystemDocument,
  DocumentMetadata,
} from "@tableloom/core/documents";
import type { Member } from "@tableloom/core/access";
import type { BrowserSystem } from "@tableloom/module-sdk/browser";
import type { DocumentData } from "@tableloom/module-sdk";

export class DocumentRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type DocumentRequest = (
  path: string,
  signal: AbortSignal,
  body?: unknown,
) => Promise<unknown>;
export async function documentRequest(
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(path, {
    signal,
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string().max(500) }).safeParse(json);
    throw new DocumentRequestError(
      response.status,
      error.success ? error.data.error : "The record request failed.",
    );
  }
  return json;
}
export interface DocumentDraft {
  version: number;
  title: string;
  visibility: "public" | "gm";
  data: DocumentData;
}
export interface DocumentView {
  documents: DocumentMetadata[];
  next: string | null;
  cursor: string | null;
  record: SystemDocument | null;
  draft: DocumentDraft | null;
  busy: boolean;
  ready: boolean;
  uncertain: boolean;
  error: string;
}
const metadataOf = ({
  id,
  campaignId,
  title,
  ownerId,
  visibility,
  system,
  schemaVersion,
  version,
}: SystemDocument): DocumentMetadata => ({
  id,
  campaignId,
  title,
  ownerId,
  visibility,
  system,
  schemaVersion,
  version,
});
const draftOf = (record: SystemDocument): DocumentDraft => ({
  version: record.version,
  title: record.title,
  visibility: record.visibility,
  data: record.data,
});
export const documentDirty = (view: DocumentView) =>
  Boolean(
    view.record &&
    view.draft &&
    JSON.stringify({ ...view.draft, version: view.record.version }) !==
      JSON.stringify(draftOf(view.record)),
  );
export const documentStale = (view: DocumentView) =>
  Boolean(
    view.draft && view.record && view.draft.version !== view.record.version,
  );

/** One in-flight request, scoped to one viewer/campaign/module. No write replay. */
export class DocumentClient {
  private running = false;
  private generation = 0;
  private flight: {
    controller: AbortController;
    generation: number;
    writing: boolean;
  } | null = null;
  private view: DocumentView = {
    documents: [],
    next: null,
    cursor: null,
    record: null,
    draft: null,
    busy: false,
    ready: false,
    uncertain: false,
    error: "",
  };
  constructor(
    private member: Member,
    private module: BrowserSystem,
    private request: DocumentRequest,
    private changed: (view: DocumentView) => void,
  ) {}
  private update(value: Partial<DocumentView>) {
    this.view = { ...this.view, ...value };
    this.changed(this.view);
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
              "Saving was not confirmed. Your draft is kept; refresh before continuing.",
          }
        : {}),
    });
  }
  private root() {
    return `/api/campaigns/${this.member.tableId}/documents`;
  }
  private visible(metadata: DocumentMetadata) {
    if (
      metadata.campaignId !== this.member.tableId ||
      metadata.system.id !== this.module.manifest.id ||
      metadata.system.version !== this.module.manifest.version
    )
      throw new Error(
        "This record does not match the active campaign or installed module.",
      );
    if (
      this.member.role !== "gm" &&
      metadata.visibility === "gm" &&
      metadata.ownerId !== this.member.id
    )
      throw new Error(
        "Unexpected private record response. Refresh this campaign.",
      );
  }
  private record(value: unknown, id?: string): SystemDocument {
    const record = documentSchema.parse(value);
    this.visible(record);
    if (
      (id && record.id !== id) ||
      record.schemaVersion !== this.module.documentVersion
    )
      throw new Error(
        "This record needs a compatible installed sheet or migration.",
      );
    return { ...record, data: this.module.parse(record.data) };
  }
  editable() {
    return Boolean(
      this.view.record &&
      (this.member.role === "gm" ||
        this.view.record.ownerId === this.member.id),
    );
  }
  private cleanSelection() {
    if (documentDirty(this.view)) {
      this.update({
        error: "Save or discard your draft before opening another record.",
      });
      return false;
    }
    return true;
  }
  private async operation(
    writing: boolean,
    run: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ): Promise<boolean> {
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
      this.generation === flight.generation;
    const current = () => active() && !flight.controller.signal.aborted;
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
          uncertain: writing && !(error instanceof DocumentRequestError),
          ...(denied
            ? {
                record: null,
                draft: null,
                documents: [],
                next: null,
                cursor: null,
              }
            : {}),
          error:
            error instanceof DocumentRequestError
              ? error.message
              : writing
                ? "Saving was not confirmed. Your draft is kept. Refresh and check the record/list before trying again."
                : error instanceof z.ZodError
                  ? "The table returned an incompatible record. Check the installed module or reload."
                  : error instanceof Error
                    ? error.message
                    : "Records could not refresh.",
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
  async refresh(cursor = this.view.cursor): Promise<boolean> {
    return this.operation(false, async (signal, current) => {
      const page = documentPageSchema.parse(
        await this.request(
          `${this.root()}?limit=25${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`,
          signal,
        ),
      );
      if (!current()) return;
      page.documents.forEach((d) => this.visible(d));
      const selected = this.view.record;
      const record = selected
        ? this.record(
            await this.request(`${this.root()}/${selected.id}`, signal),
            selected.id,
          )
        : null;
      if (!current()) return;
      const keepDraft = Boolean(
        this.view.draft &&
        (documentDirty(this.view) || documentStale(this.view)),
      );
      this.update({
        documents: page.documents,
        next: page.next,
        cursor,
        record,
        draft: record ? (keepDraft ? this.view.draft : draftOf(record)) : null,
        ready: true,
        uncertain: false,
      });
    });
  }
  async open(id: string): Promise<boolean> {
    if (!this.cleanSelection()) return false;
    return this.operation(false, async (signal, current) => {
      const record = this.record(
        await this.request(`${this.root()}/${z.uuid().parse(id)}`, signal),
        id,
      );
      if (current())
        this.update({
          record,
          draft: draftOf(record),
          ready: true,
          uncertain: false,
        });
    });
  }
  async create(): Promise<boolean> {
    if (!this.view.ready || this.view.uncertain || !this.cleanSelection())
      return false;
    return this.operation(true, async (signal, current) => {
      const record = this.record(
        await this.request(this.root(), signal, {
          title: "Untitled character",
          visibility: "gm",
          system: {
            id: this.module.manifest.id,
            version: this.module.manifest.version,
          },
        }),
      );
      if (
        record.ownerId !== this.member.id ||
        record.version !== 1 ||
        record.visibility !== "gm"
      )
        throw new Error("Unexpected creation response.");
      if (current())
        this.update({
          record,
          draft: draftOf(record),
          ready: true,
          uncertain: false,
          documents: [
            metadataOf(record),
            ...this.view.documents.filter((d) => d.id !== record.id),
          ].slice(0, 25),
        });
    });
  }
  change(
    fields: Partial<Pick<DocumentDraft, "title" | "visibility" | "data">>,
    id = this.view.record?.id,
    version = this.view.draft?.version,
  ) {
    if (
      !this.running ||
      !this.editable() ||
      this.view.busy ||
      !this.view.draft ||
      id !== this.view.record?.id ||
      version !== this.view.draft.version
    )
      return;
    try {
      const draft = { ...this.view.draft, ...fields };
      draft.data = this.module.parse(draft.data);
      this.update({ draft, error: "" });
    } catch {
      this.update({
        error:
          "Check the sheet fields. This change was not accepted by the module.",
      });
    }
  }
  discard() {
    if (!this.view.ready || this.view.busy || !this.view.record) return;
    this.update({
      draft: draftOf(this.view.record),
      error: "",
      uncertain: false,
    });
  }
  private canWrite() {
    return (
      this.running &&
      this.view.ready &&
      !this.view.busy &&
      !this.view.uncertain &&
      this.editable() &&
      !documentStale(this.view) &&
      Boolean(this.view.record && this.view.draft)
    );
  }
  actionsEnabled() {
    return this.canWrite() && !documentDirty(this.view);
  }
  private confirm(record: SystemDocument, before: SystemDocument) {
    if (
      record.version !== before.version + 1 ||
      record.ownerId !== before.ownerId
    )
      throw new Error("Unexpected record confirmation.");
    this.update({
      record,
      draft: draftOf(record),
      ready: true,
      uncertain: false,
      documents: this.view.documents.map((d) =>
        d.id === record.id ? metadataOf(record) : d,
      ),
    });
  }
  async save(): Promise<boolean> {
    if (!this.canWrite() || !documentDirty(this.view)) return false;
    const before = this.view.record!,
      draft = this.view.draft!;
    let body;
    try {
      body = documentUpdateSchema.parse({
        expectedVersion: draft.version,
        title: draft.title,
        visibility: draft.visibility,
        data: this.module.parse(draft.data),
      });
    } catch {
      this.update({
        error: "Check the record title and sheet fields before saving.",
      });
      return false;
    }
    return this.operation(true, async (signal, current) => {
      const record = this.record(
        await this.request(`${this.root()}/${before.id}`, signal, body),
        before.id,
      );
      if (record.title !== body.title || record.visibility !== body.visibility)
        throw new Error("Unexpected record confirmation.");
      if (current()) this.confirm(record, before);
    });
  }
  async act(
    id: string,
    version: number,
    action: string,
    input: DocumentData,
  ): Promise<boolean> {
    if (
      !this.canWrite() ||
      id !== this.view.record?.id ||
      version !== this.view.record.version
    )
      return false;
    if (documentDirty(this.view)) {
      this.update({
        error: "Save or discard sheet changes before using an action.",
      });
      return false;
    }
    const before = this.view.record!;
    const parsed = documentActionSchema.safeParse({
      expectedVersion: before.version,
      action,
      input,
    });
    if (!parsed.success) {
      this.update({
        error: "Check the module action fields before trying again.",
      });
      return false;
    }
    const body = parsed.data;
    return this.operation(true, async (signal, current) => {
      const record = this.record(
        await this.request(`${this.root()}/${before.id}/actions`, signal, body),
        before.id,
      );
      if (
        record.title !== before.title ||
        record.visibility !== before.visibility
      )
        throw new Error("Unexpected action confirmation.");
      if (current()) this.confirm(record, before);
    });
  }
}
