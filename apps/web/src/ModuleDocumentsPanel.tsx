import { Component, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { DocumentData } from "@tableloom/module-sdk";
import type { Member } from "@tableloom/core/access";
import type {
  DocumentSheetProps,
  BrowserSystem,
} from "@tableloom/module-sdk/browser";
import {
  DocumentClient,
  documentRequest,
  documentDirty,
  documentStale,
} from "./document-client.js";
import type { DocumentView } from "./document-client.js";

class SheetBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div role="alert">
        This module could not display its sheet. Your saved record and draft are
        kept.
        <button type="button" onClick={() => this.setState({ failed: false })}>
          Try sheet again
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function SheetHost({
  module,
  props,
}: {
  module: BrowserSystem;
  props: DocumentSheetProps<DocumentData>;
}) {
  return module.renderSheet(props);
}
const initial: DocumentView = {
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
export function ModuleDocumentsPanel({
  member,
  module,
  enabled,
  active,
}: {
  member: Member;
  module: BrowserSystem;
  enabled: boolean;
  active: boolean;
}) {
  const [view, setView] = useState(initial);
  const [client] = useState(
    () => new DocumentClient(member, module, documentRequest, setView),
  );
  useEffect(() => {
    if (!enabled) {
      client.stop();
      return;
    }
    client.start();
    void client.refresh();
    return () => client.stop();
  }, [client, enabled]);
  useEffect(() => {
    if (!active || !enabled) return;
    void client.refresh();
    const refresh = () => {
      if (
        document.visibilityState === "visible" &&
        !document.querySelector(".module-document-editor:focus-within")
      )
        void client.refresh();
    };
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, 10000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(interval);
    };
  }, [active, enabled, client]);
  const dirty = documentDirty(view),
    stale = documentStale(view);
  const readOnly = !enabled || !view.ready || view.busy || !client.editable();
  const record = view.record,
    draft = view.draft;
  return (
    <section
      className="module-documents"
      aria-label={`${module.manifest.name} character records`}
    >
      <span className="eyebrow">Your game</span>
      <h3>{module.manifest.name}</h3>
      {module.manifest.status === "scaffold" && (
        <p className="muted small">
          Provisional character records only. Published rules, items and powers
          await source rulebooks.
        </p>
      )}
      <div className="module-document-actions">
        <button
          type="button"
          disabled={!enabled || !view.ready || view.busy || view.uncertain}
          onClick={async () => {
            if (await client.create()) await client.refresh(null);
          }}
        >
          New private record
        </button>
        <button
          type="button"
          disabled={!enabled || view.busy}
          onClick={() => void client.refresh()}
        >
          Refresh records
        </button>
      </div>
      {view.busy && <p role="status">Updating records…</p>}
      {view.error && (
        <p className="inline-error" role="alert">
          {view.error}
        </p>
      )}
      <div className="module-document-list" aria-label="Visible records">
        {view.documents.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!enabled || view.busy}
            aria-pressed={item.id === record?.id}
            onClick={() => void client.open(item.id)}
          >
            <strong>{item.title}</strong>
            <small>
              {item.visibility === "public" ? "Shared" : "Owner and GM"}
              {item.ownerId === member.id ? " · Yours" : ""}
            </small>
          </button>
        ))}
      </div>
      {view.ready && !view.documents.length && (
        <p className="muted">
          No visible records on this page. New records start private to their
          owner and the GM.
        </p>
      )}
      <div className="module-document-actions">
        {view.cursor && (
          <button
            type="button"
            disabled={view.busy || !enabled}
            onClick={() => void client.refresh(null)}
          >
            First page
          </button>
        )}
        {view.next && (
          <button
            type="button"
            disabled={view.busy || !enabled}
            onClick={() => void client.refresh(view.next)}
          >
            More records
          </button>
        )}
      </div>
      {record && draft && (
        <form
          className="module-document-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void client.save();
          }}
        >
          <label>
            Record title
            <input
              required
              maxLength={120}
              value={draft.title}
              disabled={readOnly}
              onChange={(event) =>
                client.change(
                  { title: event.target.value },
                  record.id,
                  draft.version,
                )
              }
            />
          </label>
          <label>
            Who can read this record?
            <select
              value={draft.visibility}
              disabled={readOnly}
              onChange={(event) =>
                client.change(
                  {
                    visibility:
                      event.target.value === "public" ? "public" : "gm",
                  },
                  record.id,
                  draft.version,
                )
              }
            >
              <option value="gm">Owner and GM</option>
              <option value="public">Everyone at the table</option>
            </select>
          </label>
          {stale && (
            <p role="status">
              This record changed at the table. Your draft is kept. Discard it
              to use the latest saved version.
            </p>
          )}
          <SheetBoundary key={record.id}>
            <SheetHost
              module={module}
              props={{
                data: draft.data,
                onChange: (data) =>
                  client.change({ data }, record.id, draft.version),
                readOnly,
                actionsEnabled: client.actionsEnabled(),
                runAction: (action, input) =>
                  client.act(record.id, record.version, action, input),
              }}
            />
          </SheetBoundary>
          {!client.editable() && (
            <p className="muted">
              Only the owner or GM can edit this shared record.
            </p>
          )}
          <div className="module-document-actions">
            {client.editable() && (
              <button
                type="submit"
                disabled={
                  readOnly ||
                  !dirty ||
                  stale ||
                  view.uncertain ||
                  !draft.title.trim()
                }
              >
                Save record
              </button>
            )}
            {(dirty || stale) && (
              <button
                type="button"
                disabled={!view.ready || view.busy}
                onClick={() => client.discard()}
              >
                Discard draft &amp; use latest
              </button>
            )}
          </div>
          <p className="small muted" role="status">
            {view.uncertain
              ? "Save not confirmed"
              : dirty
                ? "Unsaved changes"
                : "Saved record"}{" "}
            · {record.visibility === "public" ? "Shared" : "Owner and GM"}. Save
            before reloading or signing out.
          </p>
        </form>
      )}
    </section>
  );
}
