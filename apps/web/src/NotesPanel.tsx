import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Plus } from "lucide-react";
import type { CommandInput, Note } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import type { CommandDelivery } from "./table-connection.js";
import { canEditObject } from "@tableloom/core/permissions";

type Fields = Pick<Note, "title" | "body" | "visibility">;
type Draft = { fields: Fields; baseFields: Fields; baseVersion: number };
const fieldsOf = (note: Note): Fields => ({
  title: note.title,
  body: note.body,
  visibility: note.visibility,
});
const matches = (a: Fields, b: Fields) =>
  a.title === b.title && a.body === b.body && a.visibility === b.visibility;
const draftOf = (note: Note): Draft => {
  const fields = fieldsOf(note);
  return { fields, baseFields: fields, baseVersion: note.version };
};

function NoteEditor({
  note,
  draft,
  change,
  enabled,
  member,
  send,
  deliveries,
}: {
  note: Note;
  draft: Draft;
  change: (draft: Draft) => void;
  enabled: boolean;
  member: Member;
  send: (command: CommandInput) => boolean;
  deliveries: CommandDelivery[];
}) {
  const submitted = useRef<Fields | null>(null);
  const delivery = deliveries.find(
    (item) =>
      item.target === note.id &&
      (item.type === "note.update" || item.type === "note.delete"),
  );
  const pending = delivery?.status === "pending";
  const saved = fieldsOf(note);
  const dirty = !matches(draft.fields, draft.baseFields);
  const stale =
    draft.baseVersion !== note.version &&
    dirty &&
    !matches(draft.fields, saved);
  const editable = canEditObject(member, note);
  useEffect(() => {
    if (
      draft.baseVersion !== note.version &&
      (!dirty ||
        matches(draft.fields, saved) ||
        (submitted.current && matches(submitted.current, saved)))
    ) {
      submitted.current = null;
      change({
        fields: dirty ? draft.fields : saved,
        baseFields: saved,
        baseVersion: note.version,
      });
    }
  }, [note.version, note.title, note.body, note.visibility, draft, change]);
  function update(fields: Partial<Fields>) {
    change({ ...draft, fields: { ...draft.fields, ...fields } });
  }
  function save(event: FormEvent) {
    event.preventDefault();
    const fields = { ...draft.fields, title: draft.fields.title.trim() };
    if (
      send({
        type: "note.update",
        noteId: note.id,
        expectedVersion: draft.baseVersion,
        changes: fields,
      })
    ) {
      submitted.current = fields;
      change({ ...draft, fields });
    }
  }
  return (
    <form className="note-editor" onSubmit={save}>
      <span className="eyebrow">
        {note.visibility === "public"
          ? "SHARED WITH THE TABLE"
          : "PRIVATE · OWNER AND GM"}
      </span>
      <label htmlFor="note-title">Title</label>
      <input
        id="note-title"
        maxLength={120}
        required
        value={draft.fields.title}
        readOnly={!editable}
        onChange={(event) => update({ title: event.target.value })}
      />
      <label htmlFor="note-body">Note</label>
      <textarea
        id="note-body"
        maxLength={10000}
        value={draft.fields.body}
        readOnly={!editable}
        onChange={(event) => update({ body: event.target.value })}
        placeholder="Keep the details that matter."
      />
      <label htmlFor="note-visibility">Who can read this?</label>
      <select
        id="note-visibility"
        disabled={!editable}
        value={draft.fields.visibility}
        onChange={(event) =>
          update({
            visibility: event.target.value === "public" ? "public" : "gm",
          })
        }
      >
        <option value="gm">Owner and GM</option>
        <option value="public">Everyone at the table</option>
      </select>
      {stale && (
        <div className="note-conflict" role="status">
          This note changed at the table. Your draft is kept here.
          <button
            type="button"
            onClick={() => {
              submitted.current = null;
              change(draftOf(note));
            }}
          >
            Discard draft &amp; reload latest
          </button>
        </div>
      )}
      {editable ? (
        <>
          <div className="note-actions">
            <button
              type="submit"
              disabled={
                !enabled ||
                pending ||
                !dirty ||
                stale ||
                !draft.fields.title.trim()
              }
            >
              Save changes
            </button>
            <button
              type="button"
              disabled={!enabled || pending || stale}
              onClick={() =>
                send({
                  type: "note.delete",
                  noteId: note.id,
                  expectedVersion: draft.baseVersion,
                })
              }
            >
              Delete note
            </button>
          </div>
          {delivery && (
            <p className="note-delivery" role="status">
              {delivery.status === "accepted"
                ? "Change confirmed by the server."
                : delivery.message}
            </p>
          )}
          <small className="muted">
            {!enabled
              ? "Reconnect to save."
              : dirty
                ? "Unsaved draft — kept while switching notes or tabs."
                : "Saved to the table."}
          </small>
        </>
      ) : (
        <p className="muted">The owner and GM can edit this note.</p>
      )}
    </form>
  );
}

export function NotesPanel({
  active,
  notes,
  member,
  enabled,
  send,
  deliveries,
}: {
  active: boolean;
  notes: Note[];
  member: Member;
  enabled: boolean;
  send: (command: CommandInput) => boolean;
  deliveries: CommandDelivery[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const selected =
    notes.find((note) => note.id === selectedId) ??
    (selectedId === null ? notes[0] : undefined);
  useEffect(() => {
    const visible = new Set(notes.map((note) => note.id));
    setDrafts((previous) =>
      Object.keys(previous).some((id) => !visible.has(id))
        ? Object.fromEntries(
            Object.entries(previous).filter(([id]) => visible.has(id)),
          )
        : previous,
    );
  }, [notes]);
  function create() {
    const id = crypto.randomUUID();
    if (
      send({
        type: "note.add",
        note: { id, title: "Untitled note", body: "", visibility: "gm" },
      })
    )
      setSelectedId(id);
  }
  return (
    <section
      className="notes-panel"
      style={{ display: active ? "flex" : "none" }}
      aria-label="Table notes"
    >
      <div className="notes-heading">
        <span className="eyebrow">YOUR VISIBLE NOTES · {notes.length}</span>
        <button
          onClick={create}
          disabled={!enabled}
          aria-label="New private note"
        >
          <Plus size={15} /> New
        </button>
      </div>
      {notes.length > 0 && (
        <div className="notes-list">
          {notes.map((note) => (
            <button
              key={note.id}
              className={selected?.id === note.id ? "active" : ""}
              onClick={() => setSelectedId(note.id)}
            >
              <strong>{note.title}</strong>
              <small>
                {note.visibility === "public" ? "Shared" : "Private"}
                {note.ownerId === member.id ? " · Yours" : ""}
              </small>
            </button>
          ))}
        </div>
      )}
      {selected ? (
        <NoteEditor
          key={selected.id}
          note={selected}
          member={member}
          enabled={enabled}
          send={send}
          deliveries={deliveries}
          draft={drafts[selected.id] ?? draftOf(selected)}
          change={(draft) =>
            setDrafts((previous) => ({ ...previous, [selected.id]: draft }))
          }
        />
      ) : (
        <p className="muted notes-empty">
          {selectedId
            ? "This note is unavailable. Choose another or create a private note."
            : "A place for secrets, clues, and things worth remembering. New notes are private to their owner and the GM."}
        </p>
      )}
    </section>
  );
}
