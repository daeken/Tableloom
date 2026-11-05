import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommandInput, Drawing, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { drawingBounds } from "@tableloom/core/geometry";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
import { drawingSizeCommand } from "./drawing-size.js";

export function ResizeDrawingDialog({
  drawing,
  state,
  member,
  enabled,
  pending,
  send,
  close,
}: {
  drawing: Drawing;
  state: TableView;
  member: Member | null;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    widthField = useRef<HTMLInputElement>(null),
    before = drawingBounds(drawing),
    [width, setWidth] = useState(String(before.right - before.left)),
    [height, setHeight] = useState(String(before.bottom - before.top)),
    [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    widthField.current?.focus();
    widthField.current?.select();
    return () => element?.close();
  }, []);
  const current = deletionReviewCurrent(
      captureDeletionReview([drawing]),
      state,
      member,
    ),
    command = drawingSizeCommand(
      drawing,
      width,
      height,
      state,
      member,
      enabled,
      pending,
    );
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog selection-delete-dialog selection-resize-dialog"
      aria-labelledby="resize-drawing-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <h1 id="resize-drawing-title">Resize drawing</h1>
      <p>
        Set the width and height of this{" "}
        {drawing.kind === "rectangle"
          ? "room"
          : drawing.kind === "text"
            ? "text label"
            : "freehand drawing"}{" "}
        in canvas units. Its upper-left corner stays at {before.left},{" "}
        {before.top}. Each axis scales independently; zoom and Snap do not
        change these sizes. Undo restores the saved geometry.
      </p>
      <p className="resize-dimensions">
        Current size: {before.right - before.left} ×{" "}
        {before.bottom - before.top}.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!command) return;
          if (send(command)) close();
          else
            setError(
              "The resize was not sent. Check your connection and try again.",
            );
        }}
      >
        <div className="creation-coordinates">
          <label htmlFor="drawing-width">Width</label>
          <label htmlFor="drawing-height">Height</label>
          <input
            ref={widthField}
            id="drawing-width"
            type="number"
            required
            min={1}
            max={20000}
            step="any"
            value={width}
            onChange={(event) => {
              setWidth(event.target.value);
              setError("");
            }}
          />
          <input
            id="drawing-height"
            type="number"
            required
            min={1}
            max={20000}
            step="any"
            value={height}
            onChange={(event) => {
              setHeight(event.target.value);
              setError("");
            }}
          />
        </div>
        {current && !command && enabled && !pending && (
          <p role="status">
            Change the size, keeping both dimensions at least one unit. The
            whole drawing must fit between −10000 and 10000 on each axis.
          </p>
        )}
        {!current && (
          <p role="alert" className="form-error">
            This drawing changed or is no longer editable. Cancel and review its
            current size.
          </p>
        )}
        {(!enabled || pending) && (
          <p role="status">
            Wait for a live connection and any pending edit before resizing.
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
            Resize drawing
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
