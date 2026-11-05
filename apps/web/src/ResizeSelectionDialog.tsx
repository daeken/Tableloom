import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupScaleSchema } from "@tableloom/core";
import type { CommandInput, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { groupBounds, resizedObjects } from "@tableloom/core/geometry";
import type { SceneObject } from "@tableloom/core/geometry";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";

export function ResizeSelectionDialog({
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
    [percent, setPercent] = useState("100"),
    [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const review = captureDeletionReview(objects),
    current = deletionReviewCurrent(review, state, member),
    scale = groupScaleSchema.safeParse(Number(percent) / 100),
    before = groupBounds(objects);
  let resized: SceneObject[] | null = null;
  if (scale.success) {
    try {
      resized = resizedObjects(objects, scale.data);
    } catch {
      /* Display bounded geometry feedback below. */
    }
  }
  const after = resized ? groupBounds(resized) : null;
  const dimensions = (box: typeof before) =>
    `${(box.right - box.left).toFixed(2)} × ${(box.bottom - box.top).toFixed(2)}`;
  function confirm() {
    if (!enabled || pending || !current || !resized || !scale.success) return;
    if (
      send({
        type: "objects.resize",
        objects: review.map((item) => ({
          objectId: item.id,
          expectedVersion: item.version,
        })),
        scale: scale.data,
      })
    )
      close();
    else
      setError("The resize was not sent. Check your connection and try again.");
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog selection-delete-dialog selection-resize-dialog"
      aria-labelledby="resize-selection-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <span className="eyebrow">RESIZE SELECTION</span>
      <h1 id="resize-selection-title">Resize {objects.length} objects</h1>
      <p>
        Scale the whole selection around its center. Tokens stay round; drawings
        and spacing scale together. Undo restores the whole edit.
      </p>
      <label htmlFor="selection-scale">Scale (%)</label>
      <input
        autoFocus
        id="selection-scale"
        type="number"
        min="1"
        max="10000"
        step="any"
        value={percent}
        onChange={(event) => setPercent(event.target.value)}
      />
      <p>50% halves sizes and spacing; 200% doubles them. Choose 1–10,000%.</p>
      <p className="resize-dimensions">
        Bounds: {dimensions(before)}
        {after && <> → {dimensions(after)}</>} canvas units
      </p>
      {resized && (
        <svg
          className="resize-preview"
          role="img"
          aria-label="Resized selection preview"
          viewBox={`${after!.left - 5} ${after!.top - 5} ${Math.max(1, after!.right - after!.left) + 10} ${Math.max(1, after!.bottom - after!.top) + 10}`}
        >
          {resized.map((object) =>
            "position" in object ? (
              <circle
                key={object.id}
                cx={object.position.x}
                cy={object.position.y}
                r={object.radius}
                fill={object.color}
              />
            ) : object.kind === "rectangle" ? (
              <rect
                key={object.id}
                x={Math.min(object.points[0]!.x, object.points.at(-1)!.x)}
                y={Math.min(object.points[0]!.y, object.points.at(-1)!.y)}
                width={Math.abs(object.points.at(-1)!.x - object.points[0]!.x)}
                height={Math.abs(object.points.at(-1)!.y - object.points[0]!.y)}
                fill="none"
                stroke={object.color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <polyline
                key={object.id}
                points={object.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={object.color}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            ),
          )}
        </svg>
      )}
      <ul className="selection-delete-list resize-targets">
        {review.map((item) => (
          <li key={item.id}>{item.label}</li>
        ))}
      </ul>
      {!scale.success && Number(percent) !== 100 && (
        <p role="alert" className="form-error">
          Choose a valid scale from 1–10,000%.
        </p>
      )}
      {scale.success && !resized && (
        <p role="alert" className="form-error">
          This scale exceeds the board or token-size limits, or leaves the
          selection unchanged. Choose another scale.
        </p>
      )}
      {!current && (
        <p role="alert" className="form-error">
          An object changed or is no longer editable. Cancel and review the
          current selection. This reviewed set will not shrink.
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
          disabled={!enabled || pending || !current || !resized}
          onClick={confirm}
        >
          Resize selection
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
