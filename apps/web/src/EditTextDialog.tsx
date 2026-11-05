import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sceneTextContentSchema } from "@tableloom/core";
import type { CommandInput, Drawing, TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  captureDeletionReview,
  deletionReviewCurrent,
} from "./scene-selection.js";
import { textEditCommand } from "./text-edit.js";

export function EditTextDialog({
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
    editor = useRef<HTMLTextAreaElement>(null),
    [captured] = useState(drawing),
    [text, setText] = useState(drawing.text ?? ""),
    [color, setColor] = useState(drawing.color),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    editor.current?.focus();
    return () => dialog.current?.close();
  }, []);
  const current = deletionReviewCurrent(
      captureDeletionReview([captured]),
      state,
      member,
    ),
    valid = sceneTextContentSchema.safeParse({ text, color }).success,
    command = textEditCommand(captured, state, member, text, color);
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog text-placement-dialog"
      aria-labelledby="edit-label-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <span className="eyebrow">SHARED SCENE TEXT</span>
      <h1 id="edit-label-title">Edit label</h1>
      <p>
        Everyone in this scene can read the saved label. Undo restores its
        previous wording and color.
      </p>
      <label htmlFor="edit-label-text">Label text</label>
      <textarea
        ref={editor}
        id="edit-label-text"
        rows={6}
        maxLength={500}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <label htmlFor="edit-label-color">Text color</label>
      <input
        id="edit-label-color"
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
      />
      <p>
        Use up to 500 characters and 20 lines. The label keeps its current box;
        resize it afterward to adjust the fit.
      </p>
      {!valid && (
        <p role="alert" className="form-error">
          Enter nonblank plain text, up to 20 lines, without control characters.
        </p>
      )}
      {!current && (
        <p role="alert" className="form-error">
          This label changed or is no longer editable. Your draft is retained
          here. Cancel and reopen Edit label to review the latest saved version.
        </p>
      )}
      {!enabled && <p role="status">Reconnect to the table before saving.</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="selection-delete-actions">
        <button onClick={close}>Cancel</button>
        <button
          className="token-size-confirm"
          disabled={!enabled || pending || !command}
          onClick={() => {
            if (!enabled || pending || !command) return;
            if (send(command)) close();
            else
              setError(
                "The edit was not sent. Check your connection and try again.",
              );
          }}
        >
          Save label
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
