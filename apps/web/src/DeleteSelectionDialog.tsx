import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommandInput, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import type { DeletionReviewItem } from "./scene-selection.js";
import { deletionReviewCurrent } from "./scene-selection.js";

export function DeleteSelectionDialog({
  review,
  state,
  member,
  enabled,
  pending,
  send,
  close,
}: {
  review: DeletionReviewItem[];
  state: TableView;
  member: Member | null;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const current = deletionReviewCurrent(review, state, member);
  function confirm() {
    if (!enabled || pending || !current) return;
    if (
      send({
        type: "objects.delete",
        objects: review.map((item) => ({
          objectId: item.id,
          expectedVersion: item.version,
        })),
      })
    )
      close();
    else
      setError(
        "The deletion was not sent. Check your connection and try again.",
      );
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog selection-delete-dialog"
      aria-labelledby="selection-delete-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <span className="eyebrow">REVIEW SELECTION</span>
      <h1 id="selection-delete-title">Delete this selection?</h1>
      <p>
        Remove{" "}
        {review.length === 1 ? "this object" : `these ${review.length} objects`}{" "}
        from the scene for everyone. You can restore the selection with Undo
        while that edit remains available.
      </p>
      <ul className="selection-delete-list">
        {review.map((item) => (
          <li key={item.id}>{item.label}</li>
        ))}
      </ul>
      {!current && (
        <p role="alert" className="form-error">
          One or more objects changed or are no longer editable. Cancel and
          review the current selection before deleting.
        </p>
      )}
      {!enabled && <p role="status">Reconnect to the table before deleting.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="selection-delete-actions">
        <button autoFocus onClick={close}>
          Cancel
        </button>
        <button
          className="selection-delete-confirm"
          disabled={!enabled || pending || !current}
          onClick={confirm}
        >
          Delete {review.length} {review.length === 1 ? "object" : "objects"}
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
