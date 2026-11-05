import { useEffect, useRef, useState } from "react";
import type { Member } from "@tableloom/core/access";
import type { BrowserSystem } from "@tableloom/module-sdk/browser";
import {
  PackSelectionClient,
  emptyPackSelection,
  packSelectionDirty,
  packSelectionStale,
} from "./pack-selection-client.js";
import { documentRequest } from "./document-client.js";
export function ContentPacksDialog({
  member,
  module,
  enabled,
  close,
  saved,
}: {
  member: Member;
  module: BrowserSystem;
  enabled: boolean;
  close: () => void;
  saved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [view, setView] = useState(emptyPackSelection),
    [client] = useState(
      () => new PackSelectionClient(member, module, documentRequest, setView),
    );
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    if (!enabled) {
      client.stop();
      return;
    }
    client.start();
    void client.load();
    return () => client.stop();
  }, [client, enabled]);
  const dirty = packSelectionDirty(view),
    stale = packSelectionStale(view),
    locked = !enabled || !view.ready || view.busy;
  return (
    <dialog
      ref={dialog}
      className="join-card invite-dialog access-management"
      aria-labelledby="content-packs-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!view.busy) close();
      }}
    >
      <h2 id="content-packs-title">Campaign content packs</h2>
      <p>
        Select exact installed versions for this system. Active homebrew
        overrides and owned copies prevent removing their pack. Save or discard
        before closing.
      </p>
      {view.error && <p role="alert">{view.error}</p>}
      {view.busy && <p role="status">Updating pack settings…</p>}
      {stale && (
        <p role="status">
          Campaign settings changed. Your selection draft is kept; discard it to
          use the latest settings.
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await client.save()) {
            saved();
            close();
          }
        }}
      >
        <fieldset disabled={locked || stale}>
          <legend>Installed compatible packs</legend>
          {view.current?.packs.map((p) => (
            <label className="content-pack-choice" key={`${p.id}@${p.version}`}>
              <input
                type="checkbox"
                checked={Boolean(
                  view.draft?.pins.some(
                    (pin) => pin.id === p.id && pin.version === p.version,
                  ),
                )}
                onChange={(e) =>
                  client.toggle(p.id, p.version, e.target.checked)
                }
              />
              <span>
                {p.id} · {p.version}
              </span>
            </label>
          ))}
          {view.ready && !view.current?.packs.length && (
            <p>No compatible packs are installed.</p>
          )}
        </fieldset>
        {view.draft?.pins
          .filter(
            (pin) =>
              !view.current?.packs.some(
                (p) => p.id === pin.id && p.version === pin.version,
              ),
          )
          .map((pin) => (
            <p key={pin.id}>
              Retained unavailable pin: {pin.id} · {pin.version}. It cannot be
              changed here.
            </p>
          ))}
        <div className="module-document-actions">
          <button type="submit" disabled={locked || !dirty || stale}>
            Save pack selection
          </button>
          <button
            type="button"
            disabled={!enabled || view.busy}
            onClick={() => void client.load()}
          >
            Refresh pack settings
          </button>
          {(dirty || stale) && (
            <button
              type="button"
              disabled={locked}
              onClick={() => client.discard()}
            >
              Discard pack draft &amp; use latest
            </button>
          )}
          <button type="button" disabled={view.busy} onClick={close}>
            Close pack settings
          </button>
        </div>
      </form>
    </dialog>
  );
}
