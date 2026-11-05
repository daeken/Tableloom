import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tokenRadiusSchema } from "@tableloom/core";
import type { CommandInput, TableView, Token } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";

/** Frozen object/version preconditions, including while the diameter draft changes. */
export function ResizeTokenDialog({
  token,
  state,
  member,
  enabled,
  pending,
  send,
  close,
}: {
  token: Token;
  state: TableView;
  member: Member | null;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [diameter, setDiameter] = useState(String(token.radius * 2)),
    [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const current = deletionReviewCurrent(
      captureDeletionReview([token]),
      state,
      member,
    ),
    parsed = tokenRadiusSchema.safeParse(Number(diameter) / 2),
    valid = parsed.success && parsed.data !== token.radius;
  function confirm() {
    if (!current || !enabled || pending || !parsed.success || !valid) return;
    if (
      send({
        type: "token.resize",
        tokenId: token.id,
        expectedVersion: token.version,
        radius: parsed.data,
      })
    )
      close();
    else
      setError("The resize was not sent. Check your connection and try again.");
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog selection-delete-dialog"
      aria-labelledby="resize-token-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <span className="eyebrow">TOKEN SIZE</span>
      <h1 id="resize-token-title">Resize {token.name}</h1>
      <p>
        Keep the token’s center fixed and change its size for everyone. Undo
        restores its previous size.
      </p>
      <label htmlFor="token-diameter">Diameter (canvas units)</label>
      <input
        autoFocus
        id="token-diameter"
        type="number"
        min="8"
        max="600"
        step="any"
        value={diameter}
        onChange={(event) => setDiameter(event.target.value)}
      />
      <p>
        Choose 8–600. New tokens are 48 units across; one grid cell is 60 units.
      </p>
      {!parsed.success && (
        <p role="alert" className="form-error">
          Enter a diameter between 8 and 600.
        </p>
      )}
      {!current && (
        <p role="alert" className="form-error">
          This token changed or is no longer editable. Cancel and review its
          current size.
        </p>
      )}
      {!enabled && <p role="status">Reconnect to the table before resizing.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="selection-delete-actions">
        <button onClick={close}>Cancel</button>
        <button
          className="token-size-confirm"
          disabled={!enabled || pending || !current || !valid}
          onClick={confirm}
        >
          Resize token
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
