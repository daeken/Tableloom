import { Component, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Member } from "@tableloom/core/access";
import type {
  BrowserSystem,
  BrowserContent,
  InstanceEditorProps,
} from "@tableloom/module-sdk/browser";
import type { DocumentData } from "@tableloom/module-sdk";
import { contentKey } from "@tableloom/core/content";
import {
  ContentClient,
  emptyContentState,
  contentDirty,
  contentStale,
} from "./content-client.js";
import { documentRequest } from "./document-client.js";

class ContentBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        The module could not display this content. Saved copies and drafts are
        kept.
        <button type="button" onClick={() => this.setState({ failed: false })}>
          Try content again
        </button>
      </p>
    ) : (
      this.props.children
    );
  }
}
function DefinitionHost({
  adapter,
  data,
}: {
  adapter: BrowserContent;
  data: DocumentData;
}) {
  return adapter.renderDefinition(data);
}
function InstanceHost({
  adapter,
  props,
}: {
  adapter: BrowserContent;
  props: InstanceEditorProps<DocumentData>;
}) {
  return adapter.renderInstance(props);
}
export function ModuleContentPanel({
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
  const [view, setView] = useState(emptyContentState),
    [client] = useState(
      () => new ContentClient(member, module, documentRequest, setView),
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
    if (enabled && active) void client.refresh();
  }, [client, enabled, active]);
  const dirty = contentDirty(view),
    stale = contentStale(view),
    instance = view.instance,
    draft = view.draft,
    definition = view.definition;
  const locked = !enabled || !view.ready || view.busy,
    readOnly = locked || !client.editable() || stale;
  const definitionAdapter = definition
      ? client.adapter(definition.reference)
      : null,
    instanceAdapter = instance ? client.adapter(instance.reference) : null;
  return (
    <section
      className="module-documents module-content"
      aria-label={`${module.manifest.name} catalog and copies`}
    >
      <h3>Catalog &amp; your copies</h3>
      <p className="small muted">
        Browse the campaign's selected packs and make a private copy. Copies
        keep their original source when homebrew changes. Refresh to check for
        changes.
      </p>
      <button
        type="button"
        disabled={!enabled || view.busy}
        onClick={() => void client.refresh()}
      >
        Refresh content
      </button>
      {view.busy && <p role="status">Updating content…</p>}
      {view.error && (
        <p role="alert" className="inline-error">
          {view.error}
        </p>
      )}
      <h4>Catalog</h4>
      <div
        className="module-document-list"
        aria-label="Visible catalog entries"
      >
        {view.definitions.map((d) => (
          <button
            type="button"
            key={contentKey(d.reference)}
            disabled={!enabled || view.busy || !client.adapter(d.reference)}
            aria-pressed={
              definition
                ? contentKey(d.reference) === contentKey(definition.reference)
                : false
            }
            onClick={() => void client.openDefinition(d.reference)}
          >
            <strong>{d.name}</strong>
            <small>
              {d.visibility === "public" ? "Shared" : "GM only"}
              {!client.adapter(d.reference)
                ? " · Compatible controls needed"
                : ""}
            </small>
          </button>
        ))}
      </div>
      {view.ready && !view.definitions.length && (
        <p className="muted">
          No visible catalog entries on this page. Packs must be installed and
          selected for this campaign.
        </p>
      )}
      <div className="module-document-actions">
        {view.catalogCursor && (
          <button
            type="button"
            disabled={!enabled || view.busy}
            onClick={() => void client.refresh(null, view.cursor)}
          >
            First catalog page
          </button>
        )}
        {view.catalogNext && (
          <button
            type="button"
            disabled={!enabled || view.busy}
            onClick={() => void client.refresh(view.catalogNext, view.cursor)}
          >
            More catalog entries
          </button>
        )}
      </div>
      {definition && definitionAdapter && (
        <div className="content-definition">
          <h4>{definition.name}</h4>
          <ContentBoundary key={contentKey(definition.reference)}>
            <DefinitionHost
              adapter={definitionAdapter}
              data={definition.data}
            />
          </ContentBoundary>
          {definition.sources.length > 0 && (
            <ul className="small">
              {definition.sources.map((s, i) => (
                <li key={i}>
                  {s.title} · {s.edition} · {s.page}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            disabled={locked || view.uncertain || dirty}
            onClick={() => void client.create()}
          >
            Make a private copy
          </button>
        </div>
      )}
      <h4>Copies you can read</h4>
      <div className="module-document-list" aria-label="Visible owned copies">
        {view.instances.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={!enabled || view.busy || !client.adapter(item.reference)}
            aria-pressed={item.id === instance?.id}
            onClick={() => void client.openInstance(item.id)}
          >
            <strong>{item.name}</strong>
            <small>
              {item.visibility === "public" ? "Shared" : "Owner and GM"}
              {item.ownerId === member.id ? " · Yours" : ""}
            </small>
          </button>
        ))}
      </div>
      {view.ready && !view.instances.length && (
        <p className="muted">
          No visible copies on this page. New copies start private to their
          owner and the GM.
        </p>
      )}
      <div className="module-document-actions">
        {view.cursor && (
          <button
            type="button"
            disabled={!enabled || view.busy}
            onClick={() => void client.refresh(view.catalogCursor, null)}
          >
            First copies page
          </button>
        )}
        {view.next && (
          <button
            type="button"
            disabled={!enabled || view.busy}
            onClick={() => void client.refresh(view.catalogCursor, view.next)}
          >
            More copies
          </button>
        )}
      </div>
      {instance && draft && instanceAdapter && (
        <form
          className="module-document-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void client.save();
          }}
        >
          <label>
            Copy name
            <input
              required
              maxLength={120}
              value={draft.name}
              disabled={readOnly}
              onChange={(e) =>
                client.change(
                  { name: e.target.value },
                  instance.id,
                  draft.version,
                )
              }
            />
          </label>
          <label>
            Who can read this copy?
            <select
              value={draft.visibility}
              disabled={readOnly}
              onChange={(e) =>
                client.change(
                  { visibility: e.target.value === "public" ? "public" : "gm" },
                  instance.id,
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
              This copy changed at the table. Your draft is kept. Discard it to
              use the latest saved version.
            </p>
          )}
          <ContentBoundary key={instance.id}>
            <InstanceHost
              adapter={instanceAdapter}
              props={{
                data: draft.data,
                readOnly,
                onChange: (data) =>
                  client.change({ data }, instance.id, draft.version),
              }}
            />
          </ContentBoundary>
          <p className="small muted">
            Copied from {instance.source.name}. This source stays fixed when the
            catalog changes.
          </p>
          {!client.editable() && (
            <p className="muted">
              Only the owner or GM can edit this shared copy.
            </p>
          )}
          <div className="module-document-actions">
            {client.editable() && (
              <button
                type="submit"
                disabled={
                  readOnly || !dirty || view.uncertain || !draft.name.trim()
                }
              >
                Save copy
              </button>
            )}
            {(dirty || stale) && (
              <button
                type="button"
                disabled={locked}
                onClick={() => client.discard()}
              >
                Discard copy draft &amp; use latest
              </button>
            )}
          </div>
          <p role="status" className="small muted">
            {view.uncertain
              ? "Save not confirmed"
              : dirty
                ? "Unsaved copy changes"
                : "Saved copy"}
            . Save before switching campaigns, reloading or signing out.
          </p>
        </form>
      )}
    </section>
  );
}
