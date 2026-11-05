import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DEFAULT_TEXT_STYLE } from "@tableloom/core";
import type { CommandInput, Point, TableView } from "@tableloom/core";
import { TextStyleFields } from "./TextStyleFields.js";
import {
  creationAvailable,
  objectCreationCommand,
  type CreationDraft,
  type CreationKind,
} from "./object-creation.js";

export function CreateObjectDialog({
  anchor,
  kind,
  color,
  tokenName,
  state,
  enabled,
  pending,
  send,
  close,
}: {
  anchor: Point;
  kind: CreationKind;
  color: string;
  tokenName: string;
  state: TableView;
  enabled: boolean;
  pending: boolean;
  send: (command: CommandInput) => boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    kindField = useRef<HTMLSelectElement>(null),
    [draft, setDraft] = useState<CreationDraft>({
      kind,
      x: String(anchor.x),
      y: String(anchor.y),
      width: "120",
      height: "120",
      name: tokenName,
      text: "",
      color,
      textStyle: { ...DEFAULT_TEXT_STYLE },
    }),
    [error, setError] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    kindField.current?.focus();
    return () => element?.close();
  }, []);
  function change<K extends keyof CreationDraft>(
    key: K,
    value: CreationDraft[K],
  ) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setError("");
  }
  let valid = false;
  try {
    objectCreationCommand(draft, "00000000-0000-4000-8000-000000000000");
    valid = true;
  } catch {
    /* Incomplete drafts never leave the dialog. */
  }
  const available = creationAvailable(draft.kind, state, enabled, pending);
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog text-placement-dialog object-creation-dialog"
      aria-labelledby="object-creation-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <h1 id="object-creation-title">Create an object</h1>
      <p>
        Place a shared object using canvas coordinates. X increases to the
        right; Y increases downward. Coordinates are exact, regardless of zoom
        or Snap.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!available || !valid) return;
          try {
            const command = objectCreationCommand(draft, crypto.randomUUID());
            if (send(command)) close();
            else
              setError(
                "The object was not sent. Check your connection and try again.",
              );
          } catch {
            setError("Review the object fields before creating it.");
          }
        }}
      >
        <label>
          Object type
          <select
            ref={kindField}
            value={draft.kind}
            onChange={(event) =>
              change("kind", event.target.value as CreationKind)
            }
          >
            <option value="token">Token</option>
            <option value="rectangle">Room</option>
            <option value="text">Text label</option>
          </select>
        </label>
        <p>
          {draft.kind === "token"
            ? "X and Y set the token center. Resize it after placement."
            : "X and Y set the upper-left corner."}{" "}
          Values must stay between −10000 and 10000; the whole room or label
          must fit.
        </p>
        <div className="creation-coordinates">
          {(["x", "y"] as const).map((key) => (
            <label key={key}>
              {key.toUpperCase()}
              <input
                type="number"
                required
                min={-10000}
                max={10000}
                step="any"
                value={draft[key]}
                onChange={(event) => change(key, event.target.value)}
              />
            </label>
          ))}
          {draft.kind === "rectangle" &&
            (["width", "height"] as const).map((key) => (
              <label key={key}>
                {key === "width" ? "Width" : "Height"}
                <input
                  type="number"
                  required
                  min={0}
                  max={20000}
                  step="any"
                  value={draft[key]}
                  onChange={(event) => change(key, event.target.value)}
                />
              </label>
            ))}
        </div>
        {draft.kind === "token" && (
          <label>
            Token name
            <input
              required
              maxLength={32}
              value={draft.name}
              onChange={(event) => change("name", event.target.value)}
            />
          </label>
        )}
        {draft.kind === "text" && (
          <>
            <label>
              Label text
              <textarea
                required
                rows={4}
                maxLength={500}
                value={draft.text}
                onChange={(event) => change("text", event.target.value)}
              />
            </label>
            <TextStyleFields
              value={draft.textStyle}
              change={(value) => change("textStyle", value)}
              prefix="create-object"
              text={draft.text}
              color={draft.color}
            />
          </>
        )}
        <label>
          Color
          <input
            type="color"
            value={draft.color}
            onChange={(event) => change("color", event.target.value)}
          />
        </label>
        {!valid && (
          <p className="form-error" role="status">
            Enter a name or nonblank label when needed, valid coordinates, and
            positive room dimensions. Labels allow 500 characters and 20 lines.
            Keep the room or label inside the coordinate limits.
          </p>
        )}
        {!available && (
          <p role="status">
            Creation requires a live connection, no pending edit, and space in
            this scene (200 tokens or 2000 drawings).
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
            disabled={!valid || !available}
          >
            Create shared object
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
