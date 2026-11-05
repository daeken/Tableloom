import { useEffect, useRef, useState } from "react";
import type { Point, DrawingInput } from "@tableloom/core";
import { textPlacement } from "./text-placement.js";
export function TextPlacementDialog({
  anchor,
  color,
  enabled,
  save,
  close,
}: {
  anchor: Point;
  color: string;
  enabled: boolean;
  save: (drawing: DrawingInput) => boolean;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    editor.current?.focus();
    return () => el?.close();
  }, []);
  let valid = false;
  try {
    textPlacement(text, anchor, color, "00000000-0000-4000-8000-000000000000");
    valid = true;
  } catch {
    /* Draft validation is shown below. */
  }
  return (
    <dialog
      ref={ref}
      className="join-card invite-dialog text-placement-dialog"
      aria-labelledby="text-placement-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <span className="eyebrow">SHARED SCENE TEXT</span>
      <h1 id="text-placement-title">Add a label</h1>
      <p>
        Everyone in this campaign can read this text in the current scene. Use
        up to 500 characters and 20 lines.
      </p>
      <label htmlFor="scene-text-input">Label text</label>
      <textarea
        ref={editor}
        id="scene-text-input"
        rows={6}
        maxLength={500}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p>
        Plain text, with line breaks. Move and resize the saved label with
        Select, then choose Edit label to change its wording or color.
      </p>
      {!valid && text && (
        <p className="form-error">
          Enter nonblank plain text, up to 20 lines, without control characters.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="selection-delete-actions">
        <button onClick={close}>Cancel</button>
        <button
          className="token-size-confirm"
          disabled={!valid || !enabled}
          onClick={() => {
            try {
              if (save(textPlacement(text, anchor, color, crypto.randomUUID())))
                close();
              else
                setError(
                  "The scene is not ready. Wait for reconnection before placing the label.",
                );
            } catch {
              setError("Review the text before placing it.");
            }
          }}
        >
          Place shared label
        </button>
      </div>
    </dialog>
  );
}
