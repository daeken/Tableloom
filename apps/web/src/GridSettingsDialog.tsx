import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_GRID,
  gridStateSchema,
  type SceneGrid,
} from "@tableloom/core/scene-grid";
import type { Member } from "@tableloom/core/access";
import type { CommandContext } from "@tableloom/core/campaigns";
import { accessRequest } from "./useAccess.js";
import { gridDraft, gridReviewCurrent } from "./grid-review.js";
export function GridSettingsDialog({
  context,
  grid,
  member,
  enabled,
  close,
}: {
  context: CommandContext;
  grid: SceneGrid;
  member: Member;
  enabled: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    first = useRef<HTMLInputElement>(null),
    alive = useRef(true),
    [review] = useState(() => structuredClone({ context, grid })),
    [spacing, setSpacing] = useState(String(grid.settings.spacing)),
    [x, setX] = useState(String(grid.settings.origin.x)),
    [y, setY] = useState(String(grid.settings.origin.y)),
    [visible, setVisible] = useState(grid.settings.visible),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    first.current?.focus();
    return () => {
      alive.current = false;
      element?.close();
    };
  }, []);
  const current = gridReviewCurrent(review, context, grid, member),
    command = gridDraft(review, spacing, x, y, visible),
    disabled = !current || !enabled || busy || uncertain;
  async function save() {
    if (disabled || !command) return;
    setBusy(true);
    setError("");
    try {
      const result = await accessRequest(
        `/api/campaigns/${context.campaignId}/scene-grid`,
        gridStateSchema,
        command,
      );
      if (result.version !== review.grid.version + 1)
        throw new Error("Unable to confirm the saved grid.");
      if (alive.current) close();
    } catch (err) {
      if (alive.current) {
        setUncertain(true);
        setError(
          `${err instanceof Error ? err.message : "Unable to confirm the saved grid."} Close and reopen settings to review the latest saved grid before retrying.`,
        );
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog text-placement-dialog"
      aria-labelledby="grid-settings-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <span className="eyebrow">SHARED SCENE GRID</span>
      <h1 id="grid-settings-title">Grid settings</h1>
      <p>
        Set the square grid for everyone in this scene. Existing objects stay in
        place. Each player chooses whether to snap to it.
      </p>
      <label>
        Cell spacing (canvas units)
        <input
          ref={first}
          type="number"
          min="10"
          max="500"
          step="any"
          value={spacing}
          onChange={(e) => setSpacing(e.target.value)}
        />
      </label>
      <div className="shape-style-fields">
        <label>
          Origin X
          <input
            type="number"
            min="-10000"
            max="10000"
            step="any"
            value={x}
            onChange={(e) => setX(e.target.value)}
          />
        </label>
        <label>
          Origin Y
          <input
            type="number"
            min="-10000"
            max="10000"
            step="any"
            value={y}
            onChange={(e) => setY(e.target.value)}
          />
        </label>
      </div>
      <label className="shape-fill-toggle">
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => setVisible(e.target.checked)}
        />{" "}
        Show grid to everyone
      </label>
      <p>
        Spacing: 10–500. Origin: −10,000–10,000 on each axis. Hidden grids still
        support snapping. Grid saves have no Undo yet.
      </p>
      <button
        disabled={busy}
        onClick={() => {
          setSpacing(String(DEFAULT_GRID.spacing));
          setX("0");
          setY("0");
          setVisible(true);
        }}
      >
        Use default values
      </button>
      {!current && (
        <p role="alert" className="form-error">
          The grid or active scene changed. Your draft is retained; close and
          reopen to review current settings.
        </p>
      )}
      {!enabled && <p role="status">Reconnect before saving.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="selection-delete-actions">
        <button disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="token-size-confirm"
          disabled={disabled || !command}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save shared grid"}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
