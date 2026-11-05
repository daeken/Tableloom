import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommandInput, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
  type SceneObject,
} from "./scene-selection.js";
import {
  selectionPosition,
  selectionPositionCommand,
} from "./selection-position.js";

export function PositionSelectionDialog({
  objects,
  state,
  member,
  enabled,
  pending,
  send,
  close,
}: {
  objects: SceneObject[];
  state: TableView;
  member: Member | null;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    xField = useRef<HTMLInputElement>(null),
    anchor = selectionPosition(objects)!,
    [x, setX] = useState(String(anchor.x)),
    [y, setY] = useState(String(anchor.y)),
    [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    xField.current?.focus();
    xField.current?.select();
    return () => element?.close();
  }, []);
  const review = captureDeletionReview(objects),
    current = deletionReviewCurrent(review, state, member),
    command = selectionPositionCommand(
      objects,
      x,
      y,
      state,
      member,
      enabled,
      pending,
    );
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog selection-delete-dialog selection-position-dialog"
      aria-labelledby="position-selection-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <h1 id="position-selection-title">Position selection</h1>
      <p>
        {objects.length === 1
          ? "position" in objects[0]!
            ? "Set this token’s center."
            : "Set this drawing’s upper-left corner."
          : "Set the selection’s minimum X and Y across token centers and drawing points. Token edges are excluded from this anchor."}{" "}
        X increases rightward; Y increases downward. Coordinates are exact
        canvas units, regardless of zoom or Snap. Shapes and spacing stay
        unchanged.
      </p>
      <p>
        Current position: {anchor.x}, {anchor.y}. Saved moves can be undone.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!command) return;
          if (send(command)) close();
          else
            setError(
              "The move was not sent. Check your connection and try again.",
            );
        }}
      >
        <div className="creation-coordinates">
          <label htmlFor="selection-position-x">X</label>
          <label htmlFor="selection-position-y">Y</label>
          <input
            ref={xField}
            id="selection-position-x"
            type="number"
            required
            min={-10000}
            max={10000}
            step="any"
            value={x}
            onChange={(event) => {
              setX(event.target.value);
              setError("");
            }}
          />
          <input
            id="selection-position-y"
            type="number"
            required
            min={-10000}
            max={10000}
            step="any"
            value={y}
            onChange={(event) => {
              setY(event.target.value);
              setError("");
            }}
          />
        </div>
        <ul className="selection-delete-list">
          {review.map((item) => (
            <li key={item.id}>{item.label}</li>
          ))}
        </ul>
        {!current && (
          <p role="alert" className="form-error">
            An object changed or is no longer editable. Cancel and review the
            current selection. This reviewed set will not shrink.
          </p>
        )}
        {current && !command && enabled && !pending && (
          <p role="status">
            Change the position using finite coordinates between −10000 and
            10000. All drawing points and token centers must fit inside those
            limits.
          </p>
        )}
        {(!enabled || pending) && (
          <p role="status">
            Wait for a live connection and any pending edit before moving.
          </p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="selection-delete-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="submit"
            className="token-size-confirm"
            disabled={!command}
          >
            Move selection
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
