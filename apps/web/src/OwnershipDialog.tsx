import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { CommandInput, TableView } from "@tableloom/core";
import { membersSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import { accessRequest } from "./useAccess.js";

type Subject = {
  id: string;
  label: string;
  ownerId: string | null;
  kind: "object" | "note";
  version: number | null;
  private: boolean;
};
type Review = { subject: Subject; recipient: Member };

export function OwnershipDialog({
  state,
  enabled,
  send,
  error,
  clearError,
  close,
}: {
  state: TableView;
  enabled: boolean;
  send: (command: CommandInput) => boolean;
  error: string;
  clearError: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [notice, setNotice] = useState("");
  const reads = useRef(0);
  const submitted = useRef<Review | null>(null);
  useEffect(() => {
    if (error && submitted.current) {
      submitted.current = null;
      setNotice("");
    }
  }, [error]);
  async function loadMembers() {
    const sequence = ++reads.current;
    setLoading(true);
    setLoadError("");
    try {
      const result = await accessRequest("/api/access/members", membersSchema);
      if (sequence === reads.current) setMembers(result);
    } catch (err) {
      if (sequence === reads.current)
        setLoadError(
          err instanceof Error ? err.message : "Unable to load members.",
        );
    } finally {
      if (sequence === reads.current) setLoading(false);
    }
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    void loadMembers();
    return () => {
      ++reads.current;
      element?.close();
    };
  }, []);
  const subjects: Subject[] = [
    ...state.tokens.map((token): Subject => ({
      id: token.id,
      label: `Token: ${token.name}`,
      ownerId: token.ownerId,
      kind: "object",
      version: null,
      private: false,
    })),
    ...state.drawings.map((drawing): Subject => ({
      id: drawing.id,
      label: `Drawing: ${drawing.kind === "rectangle" ? "Room" : "Stroke"}`,
      ownerId: drawing.ownerId,
      kind: "object",
      version: null,
      private: false,
    })),
    ...state.notes.map((note): Subject => ({
      id: note.id,
      label: `Note: ${note.title}`,
      ownerId: note.ownerId,
      kind: "note",
      version: note.version,
      private: note.visibility === "gm",
    })),
  ];
  const selected = subjects.find((subject) => subject.id === selectedId);
  const recipient = members.find((member) => member.id === recipientId);
  const reviewed =
    review && subjects.find((subject) => subject.id === review.subject.id);
  const stale = Boolean(
    review &&
    (!reviewed ||
      reviewed.ownerId !== review.subject.ownerId ||
      reviewed.version !== review.subject.version),
  );
  const ownerLabel = (id: string | null) =>
    id === null
      ? "Legacy object · GM control"
      : (members.find((member) => member.id === id)?.name ??
        `Former member · ${id.slice(0, 8)}`);
  useEffect(() => {
    const sent = submitted.current;
    if (!sent) return;
    const current = subjects.find((subject) => subject.id === sent.subject.id);
    if (
      current?.ownerId === sent.recipient.id &&
      (current.kind !== "note" || current.version !== sent.subject.version)
    ) {
      submitted.current = null;
      setReview(null);
      setNotice(`Ownership transferred to ${sent.recipient.name}.`);
    }
  }, [state]);
  function resetReview() {
    setReview(null);
    setNotice("");
    submitted.current = null;
    clearError();
  }
  function transfer() {
    if (!review || stale || !enabled) return;
    clearError();
    const { subject, recipient } = review;
    const command: CommandInput =
      subject.kind === "note"
        ? {
            type: "note.assign",
            noteId: subject.id,
            expectedVersion: subject.version!,
            ownerId: recipient.id,
            ...(subject.private
              ? { acknowledgePrivateAccess: true as const }
              : {}),
          }
        : {
            type: "object.assign",
            objectId: subject.id,
            expectedOwnerId: subject.ownerId,
            ownerId: recipient.id,
          };
    if (send(command)) {
      submitted.current = review;
      setNotice("Transfer requested. Waiting for the table to confirm.");
    }
  }
  return (
    <dialog
      ref={dialog}
      className="join-card invite-dialog access-management ownership-dialog"
      onCancel={close}
      aria-labelledby="ownership-title"
    >
      <button
        className="dialog-close"
        onClick={close}
        aria-label="Close ownership management"
      >
        <X size={17} />
      </button>
      <span className="eyebrow">GM CONTROLS</span>
      <h1 id="ownership-title">Pass the reins.</h1>
      <p>
        Assign a token, drawing, or saved note to a current member. The GM keeps
        access. Dice results keep their original attribution.
      </p>
      <label htmlFor="ownership-object">Object or note</label>
      <select
        id="ownership-object"
        value={selectedId}
        onChange={(event) => {
          setSelectedId(event.target.value);
          resetReview();
        }}
      >
        <option value="">Choose something to transfer</option>
        {subjects.map((subject) => (
          <option key={subject.id} value={subject.id}>
            {subject.label} · {subject.id.slice(0, 8)}
          </option>
        ))}
      </select>
      {selected && (
        <p>
          Current owner: <strong>{ownerLabel(selected.ownerId)}</strong>.{" "}
          {selected.private
            ? "Private to owner and GM."
            : "Visible to the table."}
        </p>
      )}
      <label htmlFor="ownership-recipient">New owner</label>
      <select
        id="ownership-recipient"
        value={recipientId}
        disabled={loading || Boolean(loadError)}
        onChange={(event) => {
          setRecipientId(event.target.value);
          resetReview();
        }}
      >
        <option value="">Choose a member</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.name} ·{" "}
            {member.role === "gm" ? "GM" : member.id.slice(0, 8)}
          </option>
        ))}
      </select>
      <button
        className="join-button"
        disabled={
          !enabled ||
          loading ||
          Boolean(loadError) ||
          !selected ||
          !recipient ||
          selected.ownerId === recipient.id
        }
        onClick={() => {
          if (selected && recipient) {
            resetReview();
            setReview({ subject: selected, recipient });
          }
        }}
      >
        Review transfer
      </button>
      {review && (
        <section
          className="ownership-review"
          aria-label="Review ownership transfer"
        >
          <h2>Transfer to {review.recipient.name}?</h2>
          <p>{review.subject.label}</p>
          {review.subject.private ? (
            <p>
              <strong>This transfers private access.</strong>{" "}
              {review.recipient.name} will receive the saved title and full note
              text and can edit/delete it. The previous player owner will lose
              access and unsaved drafts. The GM keeps access. Previously read
              content cannot be recalled. Visibility stays private.
            </p>
          ) : (
            <p>
              The new owner can{" "}
              {review.subject.kind === "note"
                ? "edit and delete this note"
                : "control and delete this object"}
              . Other members keep their existing read access.
            </p>
          )}
          {review.subject.kind === "note" && (
            <p>
              Only saved content is transferred. Save any draft before
              continuing.
            </p>
          )}
          {stale && (
            <p role="alert">
              This item changed. Review the latest version before transferring.
            </p>
          )}
          <button
            className="join-button"
            disabled={!enabled || stale || Boolean(submitted.current && !error)}
            onClick={transfer}
          >
            {review.subject.private
              ? "Confirm private note transfer"
              : "Confirm ownership transfer"}
          </button>
          <button className="access-switch" onClick={resetReview}>
            Cancel transfer
          </button>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      {(loadError || error) && (
        <p className="inline-error" role="alert">
          {loadError || error}
        </p>
      )}
      <button
        className="access-switch"
        disabled={loading}
        onClick={() => {
          resetReview();
          void loadMembers();
        }}
      >
        {loading ? "Loading members…" : "Refresh member list"}
      </button>
    </dialog>
  );
}
