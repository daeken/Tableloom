import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommandInput, Drawing, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";
import {
  captureDrawingOrder,
  drawingOrderCurrent,
  drawingOrderCommand,
  drawingOrderName,
} from "./drawing-order.js";
const PAGE_SIZE = 12;
export function DrawingOrderDialog({
  initial,
  state,
  member,
  enabled,
  pending,
  send,
  close,
}: {
  initial: Drawing | null;
  state: TableView;
  member: Member | null;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    [review, setReview] = useState(() =>
      initial ? captureDrawingOrder(initial, state) : null,
    ),
    [page, setPage] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => dialog.current?.close();
  }, []);
  const list = [...state.drawings].reverse(),
    lastPage = Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1),
    visiblePage = Math.min(page, lastPage),
    current = review ? drawingOrderCurrent(review, state, member) : false;
  function arrange(direction: "front" | "back") {
    if (!review || !enabled || pending) return;
    const command = drawingOrderCommand(review, state, member, direction);
    if (!command) return;
    if (send(command)) close();
    else
      setError(
        "The order change was not sent. Check your connection and try again.",
      );
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog text-placement-dialog"
      aria-labelledby="drawing-order-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <span className="eyebrow">DRAWINGS LAYER</span>
      <h1 id="drawing-order-title">Drawing order</h1>
      <p>
        Above background maps, below tokens. Drawings at the front cover and are
        picked before drawings behind them.
      </p>
      {review ? (
        <>
          <h2 className="drawing-order-target">
            {drawingOrderName(review.drawing)}
          </h2>
          <p>
            Position{" "}
            {review.order.length - review.order.indexOf(review.drawing.id)} of{" "}
            {review.order.length}, counting from the front. Change this
            drawing’s position for everyone; Undo restores the previous stack.
          </p>
          {!current && (
            <p role="alert" className="form-error">
              This drawing or its stack changed, or it is no longer editable.
              The review is retained. Choose again to review the latest order.
            </p>
          )}
          <div className="drawing-order-actions">
            {(["front", "back"] as const).map((direction) => (
              <button
                key={direction}
                disabled={
                  !enabled ||
                  pending ||
                  !drawingOrderCommand(review, state, member, direction)
                }
                onClick={() => arrange(direction)}
              >
                {direction === "front" ? "Bring to front" : "Send to back"}
              </button>
            ))}
          </div>
          <button
            className="drawing-order-choose"
            onClick={() => {
              setReview(null);
              setError("");
            }}
          >
            Choose another drawing
          </button>
        </>
      ) : (
        <>
          <p>
            Choose a drawing you can edit, including one covered on the
            battlefield. The list runs from front to back.
          </p>
          <ol
            className="drawing-order-list"
            start={visiblePage * PAGE_SIZE + 1}
          >
            {list
              .slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE)
              .map((d) => (
                <li key={d.id}>
                  <button
                    disabled={!canEditObject(member, d)}
                    onClick={() => {
                      setReview(captureDrawingOrder(d, state));
                      setError("");
                    }}
                  >
                    <span
                      className="drawing-order-color"
                      style={{ background: d.color }}
                    />
                    {drawingOrderName(d)}
                    {!canEditObject(member, d) && <small> · Read only</small>}
                  </button>
                </li>
              ))}
          </ol>
          {!list.length && <p>No drawings in this scene yet.</p>}
          <div className="drawing-order-pages">
            <button
              disabled={visiblePage === 0}
              onClick={() => setPage(visiblePage - 1)}
            >
              Previous
            </button>
            <span>
              Page {visiblePage + 1} of {lastPage + 1}
            </span>
            <button
              disabled={visiblePage === lastPage}
              onClick={() => setPage(visiblePage + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
      {!enabled && <p role="status">Reconnect before arranging.</p>}
      {pending && <p role="status">Waiting for the current scene edit.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="selection-delete-actions">
        <button ref={cancel} onClick={close}>
          Close
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
