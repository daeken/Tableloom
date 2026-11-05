import { useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
import { accessRequest } from "../../apps/web/src/useAccess.js";
import { ModuleDocumentsPanel } from "../../apps/web/src/ModuleDocumentsPanel.js";
import { previewKinds } from "./shared.js";
import { previewBrowsers } from "./definitions-client.js";
import "../../apps/web/src/style.css";
import "./style.css";

function Preview() {
  const [kind, setKind] = useState<(typeof previewKinds)[number]>("dossier"),
    [role, setRole] = useState("owner");
  const [session, setSession] = useState<{
      kind: typeof kind;
      member: Member;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function connect() {
    setSession(null);
    setBusy(true);
    setError("");
    try {
      const result = await accessRequest(
        "/api/preview/session",
        z.object({ member: memberSchema }).strict(),
        { fixture: kind, role },
      );
      setSession({ kind, member: result.member });
    } catch {
      setError(
        "The preview session could not open. Check that the preview server is running.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="preview-page">
      <h1>Module authoring preview</h1>
      <p>
        Temporary synthetic modules, with no RPG rules or published game
        content. Uses the real record editor and server API. All data is
        discarded on normal exit.
      </p>
      <div className="preview-controls">
        <label htmlFor="preview-example">Example</label>
        <select
          id="preview-example"
          value={kind}
          disabled={busy}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="dossier">
            Dossier — text fields and normalization
          </option>
          <option value="checklist">
            Checklist — nested entries and a toggle action
          </option>
        </select>
        <label htmlFor="preview-role">View as</label>
        <select
          id="preview-role"
          value={role}
          disabled={busy}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="owner">Owner</option>
          <option value="reader">Other player</option>
          <option value="gm">GM</option>
        </select>
        <button type="button" disabled={busy} onClick={() => void connect()}>
          Open preview session
        </button>
      </div>
      <p>
        Changing the example or role replaces the session and discards local
        drafts. Each fresh example starts with three sample records: the owner
        can see two, the other player one shared record, and the GM all three.
      </p>
      <p>
        Try editing and saving before using an action, opening a second tab to
        test conflicts, or running the deliberately failing dossier action.
        Refresh after an action failure to confirm the saved data stayed intact.
      </p>
      {busy && <p role="status">Opening session…</p>}
      {error && <p role="alert">{error}</p>}
      {session && (
        <>
          <p role="status">
            Active: {previewBrowsers[session.kind].manifest.name} ·{" "}
            {session.member.name}
          </p>
          <ModuleDocumentsPanel
            key={`${session.kind}:${session.member.id}:${session.member.tableId}`}
            member={session.member}
            module={previewBrowsers[session.kind]}
            enabled
            active
          />
        </>
      )}
    </main>
  );
}
createRoot(document.querySelector("#root")!).render(<Preview />);
