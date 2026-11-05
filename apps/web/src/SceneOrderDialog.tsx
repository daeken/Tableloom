import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CommandInput, TableView } from "@tableloom/core";
import type { SceneObject } from "./scene-selection.js";
import type { Member } from "@tableloom/core/access";
import { canEditObject } from "@tableloom/core/permissions";
import {
  captureSceneOrder,
  sceneOrderCurrent,
  sceneOrderCommand,
  sceneOrderName,
} from "./scene-order.js";
const PAGE_SIZE = 12;
export function SceneOrderDialog({
  kind,
  initial,
  state,
  member,
  enabled,
  pending,
  send,
  close,
}: {
  kind: "drawing" | "token";
  initial: SceneObject | null;
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
      initial ? captureSceneOrder(initial, state) : null,
    ),
    [page, setPage] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
    return () => dialog.current?.close();
  }, []);
  const title = kind === "drawing" ? "Drawing" : "Token";
  const list = [
      ...(kind === "drawing" ? state.drawings : state.tokens),
    ].reverse(),
    lastPage = Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1),
    visiblePage = Math.min(page, lastPage),
    current = review ? sceneOrderCurrent(review, state, member) : false;
  function arrange(direction: "front" | "back") {
    if (!review || !enabled || pending) return;
    const command = sceneOrderCommand(review, state, member, direction);
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
      <span className="eyebrow">{title.toUpperCase()}S LAYER</span>
      <h1 id="drawing-order-title">{title} order</h1>
      <p>
        {kind === "drawing"
          ? "Above background maps, below tokens."
          : "Above drawings and background maps."}{" "}
        {title}s at the front cover and are picked before {kind}s behind them.
      </p>
      {review ? (
        <>
          <h2 className="drawing-order-target">
            {sceneOrderName(review.object)}
          </h2>
          <p>
            Position{" "}
            {review.order.length - review.order.indexOf(review.object.id)} of{" "}
            {review.order.length}, counting from the front. Change this {kind}’s
            position for everyone; Undo restores the previous stack.
          </p>
          {!current && (
            <p role="alert" className="form-error">
              This {kind} or its stack changed, or it is no longer editable. The
              review is retained. Choose again to review the latest order.
            </p>
          )}
          <div className="drawing-order-actions">
            {(["front", "back"] as const).map((direction) => (
              <button
                key={direction}
                disabled={
                  !enabled ||
                  pending ||
                  !sceneOrderCommand(review, state, member, direction)
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
            Choose another {kind}
          </button>
        </>
      ) : (
        <>
          <p>
            Choose a {kind} you can edit, including one covered on the
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
                      setReview(captureSceneOrder(d, state));
                      setError("");
                    }}
                  >
                    <span
                      className="drawing-order-color"
                      style={{ background: d.color }}
                    />
                    {sceneOrderName(d)}
                    {!canEditObject(member, d) && <small> · Read only</small>}
                  </button>
                </li>
              ))}
          </ol>
          {!list.length && <p>No {kind}s in this scene yet.</p>}
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
