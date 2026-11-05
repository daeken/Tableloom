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
  homebrewDirty,
  homebrewStale,
} from "./content-client.js";
import { ContentPacksDialog } from "./ContentPacksDialog.js";
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
function HomebrewHost({
  adapter,
  props,
}: {
  adapter: BrowserContent;
  props: InstanceEditorProps<DocumentData>;
}) {
  return adapter.renderHomebrew?.(props);
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
  const [managePacks, setManagePacks] = useState(false);
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
    readOnly = locked || !client.editable() || stale || Boolean(view.homebrew);
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
      {member.role === "gm" && (
        <div className="module-document-actions">
          <button
            type="button"
            disabled={locked || dirty || homebrewDirty(view) || view.uncertain}
            onClick={() => setManagePacks(true)}
          >
            Manage content packs
          </button>
        </div>
      )}
      {managePacks && (
        <ContentPacksDialog
          member={member}
          module={module}
          enabled={enabled}
          close={() => setManagePacks(false)}
          saved={() => void client.refresh(null, null)}
        />
      )}
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
            disabled={locked || view.uncertain || dirty || homebrewDirty(view)}
            onClick={() => void client.create()}
          >
            Make a private copy
          </button>
        </div>
      )}
      {member.role === "gm" && definition && definitionAdapter && (
        <div>
          {!view.homebrew && definitionAdapter.renderHomebrew && (
            <button
              type="button"
              disabled={locked || dirty || view.uncertain}
              onClick={() => client.editHomebrew()}
            >
              Edit campaign homebrew
            </button>
          )}
          {view.homebrew && (
            <form
              className="module-document-editor homebrew-editor"
              onSubmit={async (e) => {
                e.preventDefault();
                if (await client.saveHomebrew()) await client.refresh();
              }}
            >
              <h4>Campaign homebrew replacement</h4>
              <p className="small">
                This replaces this campaign's catalog entry. Existing owned
                copies keep their original source and state.
              </p>
              {homebrewStale(view) && (
                <p role="status">
                  This definition changed. Your draft is kept; discard it before
                  editing the latest version.
                </p>
              )}
              <label>
                Homebrew name
                <input
                  required
                  maxLength={120}
                  disabled={locked || homebrewStale(view)}
                  value={view.homebrew.name}
                  onChange={(e) =>
                    client.changeHomebrew(
                      { name: e.target.value },
                      contentKey(definition.reference),
                      view.homebrew!.revision,
                    )
                  }
                />
              </label>
              <label>
                Who can read this definition?
                <select
                  disabled={locked || homebrewStale(view)}
                  value={view.homebrew.visibility}
                  onChange={(e) =>
                    client.changeHomebrew(
                      {
                        visibility:
                          e.target.value === "public" ? "public" : "gm",
                      },
                      contentKey(definition.reference),
                      view.homebrew!.revision,
                    )
                  }
                >
                  <option value="gm">GM only</option>
                  <option value="public">Everyone at the table</option>
                </select>
              </label>
              <ContentBoundary
                key={`homebrew:${contentKey(definition.reference)}`}
              >
                <HomebrewHost
                  adapter={definitionAdapter}
                  props={{
                    data: view.homebrew.data,
                    readOnly: locked || homebrewStale(view),
                    onChange: (data) =>
                      client.changeHomebrew(
                        { data },
                        contentKey(definition.reference),
                        view.homebrew!.revision,
                      ),
                  }}
                />
              </ContentBoundary>
              <fieldset disabled={locked || homebrewStale(view)}>
                <legend>Replacement sources</legend>
                {view.homebrew.sources.map((source, i) => (
                  <div key={i} className="homebrew-source">
                    {(["title", "edition", "page"] as const).map((field) => (
                      <label key={field}>
                        Source {i + 1} {field}
                        <input
                          required
                          maxLength={field === "title" ? 200 : 100}
                          value={source[field]}
                          onChange={(e) =>
                            client.changeHomebrew(
                              {
                                sources: view.homebrew!.sources.map((s, n) =>
                                  n === i
                                    ? { ...s, [field]: e.target.value }
                                    : s,
                                ),
                              },
                              contentKey(definition.reference),
                              view.homebrew!.revision,
                            )
                          }
                        />
                      </label>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        client.changeHomebrew(
                          {
                            sources: view.homebrew!.sources.filter(
                              (_, n) => n !== i,
                            ),
                          },
                          contentKey(definition.reference),
                          view.homebrew!.revision,
                        )
                      }
                    >
                      Remove source {i + 1}
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={view.homebrew.sources.length >= 20}
                  onClick={() =>
                    client.changeHomebrew(
                      {
                        sources: [
                          ...view.homebrew!.sources,
                          { title: "", edition: "", page: "" },
                        ],
                      },
                      contentKey(definition.reference),
                      view.homebrew!.revision,
                    )
                  }
                >
                  Add source reference
                </button>
              </fieldset>
              {definition.visibility === "gm" &&
                view.homebrew.visibility === "public" && (
                  <label className="content-pack-choice">
                    <input
                      type="checkbox"
                      checked={view.homebrew.shareReviewed}
                      disabled={locked || homebrewStale(view)}
                      onChange={(e) =>
                        client.reviewHomebrewSharing(e.target.checked)
                      }
                    />
                    <span>
                      I reviewed the replacement fields and listed sources for
                      sharing.
                    </span>
                  </label>
                )}
              <div className="module-document-actions">
                <button
                  type="submit"
                  disabled={
                    locked ||
                    !homebrewDirty(view) ||
                    homebrewStale(view) ||
                    view.uncertain ||
                    (definition.visibility === "gm" &&
                      view.homebrew.visibility === "public" &&
                      !view.homebrew.shareReviewed)
                  }
                >
                  Save homebrew replacement
                </button>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => client.discardHomebrew()}
                >
                  Discard homebrew draft
                </button>
              </div>
            </form>
          )}
          {definition.overridden && !view.homebrew && (
            <details className="homebrew-reset">
              <summary>Reset to the installed definition…</summary>
              <p>
                Restore the installed definition's data, name, sources and
                audience. Owned copies stay unchanged.
              </p>
              <button
                type="button"
                disabled={locked || dirty || view.uncertain}
                onClick={async () => {
                  if (
                    await client.resetHomebrew(
                      contentKey(definition.reference),
                      definition.revision,
                    )
                  )
                    await client.refresh();
                }}
              >
                Confirm reset to installed definition
              </button>
            </details>
          )}
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
