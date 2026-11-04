import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { invitationSchema } from "@tableloom/core/access";
import { accessRequest } from "./useAccess.js";
import type { z } from "zod";

export function InviteDialog({ close }: { close: () => void }) {
  const [invitation, setInvitation] = useState<z.infer<
    typeof invitationSchema
  > | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function create() {
    setBusy(true);
    setError("");
    try {
      setInvitation(
        await accessRequest("/api/access/invitations", invitationSchema, {}),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to create an invitation.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(
        `Join my Tableloom table: ${location.origin}\nInvitation code: ${invitation.token}`,
      );
      setCopied(true);
    } catch {
      setError("Copy the table address and code below to send to your player.");
    }
  }
  return (
    <dialog
      className="join-card invite-dialog"
      ref={dialog}
      onCancel={close}
      aria-labelledby="invite-title"
    >
      <button
        className="dialog-close"
        onClick={close}
        aria-label="Close invitation"
      >
        <X size={17} />
      </button>
      <span className="eyebrow">GOOD COMPANY</span>
      <h1 id="invite-title">
        Save them
        <br />a seat.
      </h1>
      <p>
        Each invitation admits one player to this table. Create another for each
        friend.
      </p>
      {invitation ? (
        <>
          <label htmlFor="invite-address">Table address</label>
          <input id="invite-address" readOnly value={location.origin} />
          <label className="credential-label" htmlFor="invite-code">
            One-use invitation code
          </label>
          <input id="invite-code" readOnly value={invitation.token} />
          <small>
            Expires {new Date(invitation.expiresAt).toLocaleString()}. Treat
            this code like a private key.
          </small>
          <button className="join-button" onClick={() => void copy()}>
            {copied ? "Invitation copied" : "Copy invitation"}
          </button>
        </>
      ) : (
        <button
          className="join-button"
          disabled={busy}
          onClick={() => void create()}
        >
          {busy ? "Saving a seat…" : "Create an invitation"}
        </button>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
