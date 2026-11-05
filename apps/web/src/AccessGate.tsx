import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowUpRight, Layers2 } from "lucide-react";
import { accessStatusSchema } from "@tableloom/core/access";
import type { AccessStatus } from "@tableloom/core/access";
import { accessRequest } from "./useAccess.js";

export function AccessGate({
  access,
  connectionError,
  refresh,
  accept,
}: {
  access: AccessStatus | null;
  connectionError: string;
  refresh: () => Promise<void>;
  accept: (status: AccessStatus) => void;
}) {
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [recover, setRecover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null),
    nameInput = useRef<HTMLInputElement>(null),
    credentialInput = useRef<HTMLInputElement>(null);
  const mode = access?.setupRequired ? "setup" : recover ? "recover" : "join";
  const ready = Boolean(access);
  useEffect(() => {
    if (!ready) heading.current?.focus();
    else if (mode === "recover") credentialInput.current?.focus();
    else nameInput.current?.focus();
  }, [mode, ready]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await accessRequest(
        `/api/access/${mode}`,
        accessStatusSchema,
        mode === "join"
          ? { name, code: credential.trim() }
          : { ...(mode === "setup" ? { name } : {}), key: credential.trim() },
      );
      setCredential("");
      accept(result);
    } catch (err) {
      setCredential("");
      setError(err instanceof Error ? err.message : "Unable to sign in.");
      credentialInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="access-page" aria-label="Table access">
      <form className="join-card" onSubmit={submit} aria-label="Table access">
        <span className="brand-mark">
          <Layers2 size={27} />
        </span>
        <span className="eyebrow">WELCOME TO TABLELOOM</span>
        <h1 ref={heading} tabIndex={-1}>
          {!access ? (
            "Finding your table…"
          ) : mode === "setup" ? (
            <>
              Make this
              <br />
              table yours.
            </>
          ) : mode === "recover" ? (
            <>
              Welcome back,
              <br />
              storyteller.
            </>
          ) : (
            <>
              There's a place
              <br />
              for you here.
            </>
          )}
        </h1>
        {!access ? (
          <>
            <p role={connectionError ? "alert" : "status"}>
              {connectionError || "Checking your seat at the table."}
            </p>
            {connectionError && (
              <button
                type="button"
                className="join-button"
                onClick={() => void refresh()}
              >
                Try again
              </button>
            )}
          </>
        ) : (
          <>
            <p>
              {mode === "setup"
                ? "Set up the host using the private key saved on your server."
                : mode === "recover"
                  ? "Use your server's private host key to return to your existing host account."
                  : "Enter a new-player invitation or a return code from your host. A return code restores your original name and ownership."}
            </p>
            {mode !== "recover" && (
              <>
                <label htmlFor="access-name">What should we call you?</label>
                <input
                  id="access-name"
                  ref={nameInput}
                  maxLength={32}
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Your name"
                  autoComplete="nickname"
                />
              </>
            )}
            <label className="credential-label" htmlFor="access-code">
              {mode === "join" ? "Invitation code" : "Private host key"}
            </label>
            <input
              id="access-code"
              ref={credentialInput}
              type="password"
              required
              maxLength={512}
              autoComplete="off"
              aria-describedby={error ? "access-error" : undefined}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={
                mode === "join" ? "Code from your host" : "Key from your server"
              }
            />
            {error && (
              <p id="access-error" className="inline-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="join-button" disabled={busy}>
              {busy
                ? "Checking your seat…"
                : mode === "setup"
                  ? "Create your table"
                  : mode === "recover"
                    ? "Return as host"
                    : "Take a seat"}
              <ArrowUpRight size={18} />
            </button>
            {!access.setupRequired && (
              <button
                type="button"
                className="access-switch"
                onClick={() => {
                  setRecover(!recover);
                  setCredential("");
                  setError("");
                }}
              >
                {recover ? "Join with an invitation instead" : "I'm the host"}
              </button>
            )}
            <small>
              {mode === "join"
                ? "Returning player? Ask the host for a return code for your existing seat. Your name here is used only for new-player invitations."
                : "Find the key in your server's data/host-key file, or use the key configured by the server owner."}
            </small>
          </>
        )}
      </form>
    </main>
  );
}
