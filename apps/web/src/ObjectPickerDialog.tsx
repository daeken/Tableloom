import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TableView } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import {
  keyboardObjectChoices,
  keyboardSelection,
  sceneObjectLabel,
} from "./keyboard-objects.js";

export function ObjectPickerDialog({
  state,
  member,
  selected,
  enabled,
  pending,
  choose,
  close,
}: {
  state: TableView;
  member: Member | null;
  selected: string[];
  enabled: boolean;
  pending: boolean;
  choose: (ids: string[]) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    searchInput = useRef<HTMLInputElement>(null);
  const [ids, setIds] = useState([...selected]),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
    searchInput.current?.focus();
    return () => dialog.current?.close();
  }, []);
  const matches = keyboardObjectChoices(state, member, search);
  const pages = Math.max(1, Math.ceil(matches.length / 50)),
    currentPage = Math.min(page, pages - 1),
    rows = matches.slice(currentPage * 50, (currentPage + 1) * 50);
  const valid = keyboardSelection(ids, state, member) !== null;
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog object-picker-dialog"
      aria-labelledby="object-picker-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <span className="eyebrow">CURRENT SCENE</span>
      <h1 id="object-picker-title">Select objects</h1>
      <p>
        Choose up to 100 objects you can edit. Selection stays local. After
        selecting, use arrow keys to move, or Tab to the selection actions.
      </p>
      <label htmlFor="object-search">Find an object</label>
      <input
        ref={searchInput}
        id="object-search"
        value={search}
        maxLength={80}
        onChange={(event) => {
          setSearch(event.target.value);
          setPage(0);
        }}
        placeholder="Name, text or ID"
      />
      <p role="status">
        {ids.length} selected · {matches.length} matching objects
      </p>
      <div className="object-picker-list" aria-label="Editable scene objects">
        {rows.map((object) => (
          <label key={object.id}>
            <input
              type="checkbox"
              checked={ids.includes(object.id)}
              disabled={
                !enabled ||
                pending ||
                (!ids.includes(object.id) && ids.length >= 100)
              }
              onChange={(event) =>
                setIds((previous) =>
                  event.target.checked
                    ? previous.includes(object.id) || previous.length >= 100
                      ? previous
                      : [...previous, object.id]
                    : previous.filter((id) => id !== object.id),
                )
              }
            />
            <span>
              {sceneObjectLabel(object)}
              <small>{object.id}</small>
            </span>
          </label>
        ))}
      </div>
      {!matches.length && <p>No matching editable objects in this scene.</p>}
      <div className="object-picker-pages">
        <button
          disabled={currentPage === 0}
          onClick={() => setPage(currentPage - 1)}
        >
          Previous objects
        </button>
        <span>
          Page {currentPage + 1} of {pages}
        </span>
        <button
          disabled={currentPage + 1 === pages}
          onClick={() => setPage(currentPage + 1)}
        >
          Next objects
        </button>
      </div>
      {!valid && (
        <p role="alert">
          An object is unavailable or no longer editable. Clear this selection
          and choose again.
        </p>
      )}
      {!enabled && <p role="status">Reconnect before selecting objects.</p>}
      <div className="selection-delete-actions">
        <button onClick={() => setIds([])}>Clear choices</button>
        <button onClick={close}>Cancel</button>
        <button
          disabled={!enabled || pending || !valid}
          onClick={() => {
            if (
              enabled &&
              !pending &&
              keyboardSelection(ids, state, member) !== null
            )
              choose([...ids]);
          }}
        >
          Use selection
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
