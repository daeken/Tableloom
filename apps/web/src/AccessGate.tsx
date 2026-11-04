import { useState } from "react";
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
  const mode = access?.setupRequired ? "setup" : recover ? "recover" : "join";
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
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="join-backdrop">
      <form className="join-card" onSubmit={submit} aria-label="Table access">
        <span className="brand-mark">
          <Layers2 size={27} />
        </span>
        <span className="eyebrow">WELCOME TO TABLELOOM</span>
        <h1>
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
            <p>{connectionError || "Checking your seat at the table."}</p>
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
                  : "Your host has a seat waiting. Enter your one-use invitation code to join."}
            </p>
            {mode !== "recover" && (
              <>
                <label htmlFor="access-name">What should we call you?</label>
                <input
                  id="access-name"
                  autoFocus
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
              type="password"
              required
              maxLength={512}
              autoComplete="off"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              placeholder={
                mode === "join" ? "Code from your host" : "Key from your server"
              }
            />
            {error && (
              <p className="inline-error" role="alert">
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
                ? "Your session stays in this browser. Keep your invitation private."
                : "Find the key in your server's data/host-key file, or use the key configured by the server owner."}
            </small>
          </>
        )}
      </form>
    </div>
  );
}
