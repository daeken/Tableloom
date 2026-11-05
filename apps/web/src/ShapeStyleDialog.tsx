import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { shapeStyleOf } from "@tableloom/core";
import type { CommandInput, Drawing, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
import { shapeEditCommand, fillOpacityPercent } from "./shape-edit.js";
export function ShapeStyleDialog({
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
    first = useRef<HTMLInputElement>(null),
    [captured] = useState(drawing),
    [original] = useState(() => shapeStyleOf(drawing)),
    [color, setColor] = useState(drawing.color),
    [width, setWidth] = useState(String(original.lineWidth)),
    [filled, setFilled] = useState(original.fill !== null),
    [fillColor, setFillColor] = useState(original.fill?.color ?? drawing.color),
    [opacity, setOpacity] = useState(
      fillOpacityPercent(original.fill?.opacity ?? 0.2),
    ),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    first.current?.focus();
    return () => dialog.current?.close();
  }, []);
  const current = deletionReviewCurrent(
      captureDeletionReview([captured]),
      state,
      member,
    ),
    command = shapeEditCommand(
      captured,
      state,
      member,
      color,
      width,
      filled,
      fillColor,
      opacity,
    ),
    validWidth =
      Number.isFinite(Number(width)) &&
      Number(width) >= 0.5 &&
      Number(width) <= 32,
    validFill =
      !filled ||
      (Number.isFinite(Number(opacity)) &&
        Number(opacity) >= 1 &&
        Number(opacity) <= 100);
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog text-placement-dialog"
      aria-labelledby="shape-style-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <span className="eyebrow">SHARED SHAPE STYLE</span>
      <h1 id="shape-style-title">
        Style {captured.kind === "rectangle" ? "room" : "stroke"}
      </h1>
      <p>
        Change this drawing for everyone. Its shape and owner stay the same;
        Undo restores the previous style.
      </p>
      <div className="shape-style-fields">
        <label htmlFor="shape-line-color">
          Line color
          <input
            ref={first}
            id="shape-line-color"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <label htmlFor="shape-line-width">
          Line width
          <input
            id="shape-line-width"
            type="number"
            min="0.5"
            max="32"
            step="any"
            value={width}
            onChange={(e) => setWidth(e.target.value)}
          />
        </label>
      </div>
      <p>Line width: 0.5–32 canvas units. Resize keeps this width fixed.</p>
      {captured.kind === "rectangle" ? (
        <>
          <label className="shape-fill-toggle">
            <input
              type="checkbox"
              checked={filled}
              onChange={(e) => setFilled(e.target.checked)}
            />{" "}
            Fill room
          </label>
          {filled && (
            <div className="shape-style-fields">
              <label htmlFor="shape-fill-color">
                Fill color
                <input
                  id="shape-fill-color"
                  type="color"
                  value={fillColor}
                  onChange={(e) => setFillColor(e.target.value)}
                />
              </label>
              <label htmlFor="shape-fill-opacity">
                Fill opacity (%)
                <input
                  id="shape-fill-opacity"
                  type="number"
                  min="1"
                  max="100"
                  step="any"
                  value={opacity}
                  onChange={(e) => setOpacity(e.target.value)}
                />
              </label>
            </div>
          )}
        </>
      ) : (
        <p>Freehand strokes use a line without a fill.</p>
      )}
      <svg
        className="shape-style-preview"
        viewBox="0 0 300 110"
        role="img"
        aria-label="Shape style preview"
      >
        {captured.kind === "rectangle" ? (
          <rect
            x="24"
            y="24"
            width="252"
            height="62"
            rx="3"
            stroke={color}
            strokeWidth={validWidth ? Number(width) : 3}
            fill={filled ? fillColor : "none"}
            fillOpacity={validFill ? Number(opacity) / 100 : 1}
          />
        ) : (
          <path
            d="M24 80 L80 30 L145 65 L210 28 L276 70"
            fill="none"
            stroke={color}
            strokeWidth={validWidth ? Number(width) : 3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      {(!validWidth || !validFill) && (
        <p role="alert" className="form-error">
          Use a line width of 0.5–32 and fill opacity of 1–100%.
        </p>
      )}
      {!current && (
        <p role="alert" className="form-error">
          This drawing changed or is no longer editable. Your draft is retained
          here. Cancel and reopen to review the latest version.
        </p>
      )}
      {!enabled && <p role="status">Reconnect before saving.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="selection-delete-actions">
        <button onClick={close}>Cancel</button>
        <button
          className="token-size-confirm"
          disabled={!command || !enabled || pending}
          onClick={() => {
            if (!command || !enabled || pending) return;
            if (send(command)) close();
            else
              setError(
                "The style was not sent. Check your connection and try again.",
              );
          }}
        >
          Save shape style
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
