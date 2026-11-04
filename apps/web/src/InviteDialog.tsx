import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { z } from "zod";
import {
  invitationSchema,
  invitationsSchema,
  membersSchema,
} from "@tableloom/core/access";
import { accessRequest } from "./useAccess.js";

type Grant = z.infer<typeof invitationSchema>;
type Members = z.infer<typeof membersSchema>;
type Invitations = z.infer<typeof invitationsSchema>;

export function InviteDialog({ close }: { close: () => void }) {
  const [invitation, setInvitation] = useState<{
    grant: Grant;
    label: string;
  } | null>(null);
  const [members, setMembers] = useState<Members>([]);
  const [pending, setPending] = useState<Invitations>([]);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const reads = useRef(0);
  async function load() {
    const sequence = ++reads.current;
    const [people, codes] = await Promise.all([
      accessRequest("/api/access/members", membersSchema),
      accessRequest("/api/access/invitations", invitationsSchema),
    ]);
    if (sequence !== reads.current) return;
    setMembers(people);
    setPending(codes);
    setInvitation((current) =>
      current && codes.some((code) => code.id === current.grant.id)
        ? current
        : null,
    );
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let active = true;
    // All controls stay disabled until this initial read settles.
    void load()
      .catch((err: unknown) => {
        if (active)
          setError(
            err instanceof Error ? err.message : "Unable to load table access.",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      ++reads.current;
      element?.close();
    };
  }, []);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update table access.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function create(member?: Members[number]) {
    const grant = await accessRequest(
      member
        ? `/api/access/members/${member.id}/recovery`
        : "/api/access/invitations",
      invitationSchema,
      {},
    );
    setInvitation({
      grant,
      label: member
        ? `Return as ${member.name} · ${member.id.slice(0, 8)}`
        : "New player invitation",
    });
    setCopied(false);
  }
  async function copy() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(
        `Join my Tableloom table: ${location.origin}\n${invitation.label}\nOne-use code: ${invitation.grant.token}`,
      );
      setCopied(true);
    } catch {
      setError("Copy the table address and code below to send to your player.");
    }
  }
  const ok = z.object({ ok: z.literal(true) });
  return (
    <dialog
      className="join-card invite-dialog access-management"
      ref={dialog}
      onCancel={close}
      aria-labelledby="invite-title"
    >
      <button
        className="dialog-close"
        onClick={close}
        aria-label="Close table access"
      >
        <X size={17} />
      </button>
      <span className="eyebrow">GOOD COMPANY</span>
      <h1 id="invite-title">Your table's people.</h1>
      <p>
        Invite someone new, or restore an existing player's seat to keep their
        notes and objects.
      </p>
      <button
        className="join-button"
        disabled={busy}
        onClick={() => void act(() => create())}
      >
        Invite a new player
      </button>
      {invitation && (
        <section className="issued-code" aria-label="New one-use code">
          <h2>{invitation.label}</h2>
          <label htmlFor="invite-address">Table address</label>
          <input id="invite-address" readOnly value={location.origin} />
          <label className="credential-label" htmlFor="invite-code">
            One-use code
          </label>
          <input id="invite-code" readOnly value={invitation.grant.token} />
          <small>
            Expires {new Date(invitation.grant.expiresAt).toLocaleString()}.
            Share privately. This code is shown only here.
          </small>
          <button className="join-button" onClick={() => void copy()}>
            {copied ? "Code copied" : "Copy invitation"}
          </button>
        </section>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <section className="access-section" aria-labelledby="members-title">
        <h2 id="members-title">Members</h2>
        <p>
          A return code preserves the selected identity and name. Using it signs
          out that player's other sessions. Creating another replaces their
          previous return code.
        </p>
        <ul className="access-list">
          {members.map((member) => (
            <li key={member.id}>
              <div>
                <strong>{member.name}</strong>{" "}
                <small>
                  {member.role === "gm" ? "Host" : member.id.slice(0, 8)}
                </small>
              </div>
              {member.role === "player" && (
                <div className="access-actions">
                  <button
                    disabled={busy}
                    onClick={() => void act(() => create(member))}
                  >
                    Create return code
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => setRemoveId(member.id)}
                  >
                    Remove…
                  </button>
                </div>
              )}
              {removeId === member.id && (
                <div className="remove-confirm">
                  <p>
                    Remove {member.name}? Their sessions and return codes will
                    stop working. Their objects and notes stay under GM control;
                    a new invitation creates a different identity.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await accessRequest(
                          `/api/access/members/${member.id}/remove`,
                          ok,
                          {},
                        );
                        setRemoveId(null);
                      })
                    }
                  >
                    Remove player
                  </button>
                  <button disabled={busy} onClick={() => setRemoveId(null)}>
                    Keep player
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="access-section" aria-labelledby="pending-title">
        <h2 id="pending-title">Unused codes</h2>
        <small>
          Saved codes cannot be displayed again. Revoke any that should no
          longer work.
        </small>
        <ul className="access-list">
          {pending.map((code) => (
            <li key={code.id}>
              <strong>
                {code.memberId
                  ? `Return: ${members.find((m) => m.id === code.memberId)?.name ?? "Player"}`
                  : "New player"}{" "}
                · {code.id.slice(0, 8)}
              </strong>
              <small>Expires {new Date(code.expiresAt).toLocaleString()}</small>
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await accessRequest(
                      `/api/access/invitations/${code.id}/revoke`,
                      ok,
                      {},
                    );
                  })
                }
              >
                Revoke code
              </button>
            </li>
          ))}
        </ul>
        {!busy && pending.length === 0 && <p>No unused codes.</p>}
        <button disabled={busy} onClick={() => void act(async () => {})}>
          {busy ? "Updating…" : "Refresh members and codes"}
        </button>
      </section>
    </dialog>
  );
}
