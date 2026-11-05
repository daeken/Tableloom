import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { X } from "lucide-react";
import {
  campaignListSchema,
  campaignMembershipSchema,
} from "@tableloom/core/campaigns";
import type { Campaign } from "@tableloom/core/campaigns";
import { accessStatusSchema } from "@tableloom/core/access";
import type { Member, AccessStatus } from "@tableloom/core/access";
import type { ModuleManifest } from "@tableloom/module-sdk";
import { accessRequest } from "./useAccess.js";
import type { z } from "zod";
import { CampaignExportDialog } from "./CampaignExportDialog.js";

const CampaignImportReviewDialog = lazy(() =>
  import("./CampaignImportReviewDialog.js").then((module) => ({
    default: module.CampaignImportReviewDialog,
  })),
);

type Listing = z.infer<typeof campaignListSchema>;
export function CampaignDialog({
  member,
  modules,
  accept,
  close,
}: {
  member: Member;
  modules: ModuleManifest[];
  accept: (status: AccessStatus) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    reads = useRef(0);
  const [campaigns, setCampaigns] = useState<Listing>([]);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [systemId, setSystemId] = useState(modules[0]!.id);
  const [code, setCode] = useState("");
  async function load() {
    const sequence = ++reads.current;
    const list = await accessRequest("/api/campaigns", campaignListSchema);
    if (sequence === reads.current) setCampaigns(list);
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let active = true;
    void load()
      .catch((err: unknown) => {
        if (active)
          setError(
            err instanceof Error ? err.message : "Unable to load campaigns.",
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
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update campaigns.",
      );
    } finally {
      setBusy(false);
    }
  }
  function edit(campaign: Campaign) {
    setEditing(campaign);
    setName(campaign.name);
    setDescription(campaign.description);
    setSystemId(campaign.system.id);
    setError("");
    setNotice("");
  }
  function newForm() {
    setEditing(null);
    setName("");
    setDescription("");
    setSystemId(modules[0]!.id);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    await act(async () => {
      const module = modules.find((module) => module.id === systemId)!;
      const settings = {
        name,
        description,
        system: { id: module.id, version: module.version },
        contentPacks: editing?.contentPacks ?? [],
      };
      if (editing) {
        await accessRequest(
          `/api/campaigns/${editing.id}/settings`,
          campaignMembershipSchema,
          { expectedVersion: editing.version, settings },
        );
        setNotice("Campaign settings saved.");
      } else {
        await accessRequest(
          "/api/campaigns",
          campaignMembershipSchema,
          settings,
        );
        setNotice(
          "Campaign created. Open it from the list to invite your players.",
        );
      }
      newForm();
      await load();
    });
  }
  return (
    <dialog
      ref={dialog}
      className="join-card invite-dialog access-management campaign-dialog"
      onCancel={close}
      aria-labelledby="campaign-title"
    >
      <button
        className="dialog-close"
        onClick={close}
        aria-label="Close campaigns"
      >
        <X size={17} />
      </button>
      <span className="eyebrow">YOUR STORIES</span>
      <h1 id="campaign-title">Choose a campaign.</h1>
      <p>
        Each campaign has its own players, battlefield, notes, and dice history.
        Save drafts before changing campaigns.
      </p>
      <ul className="access-list campaign-list">
        {campaigns.map((campaign) => (
          <li key={campaign.id}>
            <strong>{campaign.name}</strong>
            <small>
              {modules.find((module) => module.id === campaign.system.id)
                ?.name ?? campaign.system.id}{" "}
              · {campaign.role === "gm" ? "GM" : "Player"}
            </small>
            {campaign.id === member.tableId ? (
              <span className="eyebrow">CURRENT CAMPAIGN</span>
            ) : (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    accept(
                      await accessRequest(
                        `/api/campaigns/${campaign.id}/select`,
                        accessStatusSchema,
                        {},
                      ),
                    );
                    close();
                  })
                }
              >
                Open campaign
              </button>
            )}
            {campaign.id === member.tableId && campaign.role === "gm" && (
              <div className="access-actions">
                <button disabled={busy} onClick={() => edit(campaign)}>
                  Edit settings
                </button>
                <button disabled={busy} onClick={() => setExportOpen(true)}>
                  Export campaign…
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {member.role === "gm" && (
        <section className="access-section">
          <h2>Review a campaign file</h2>
          <p>
            Import reviews are available to the server host and make no saved
            changes.
          </p>
          <button disabled={busy} onClick={() => setImportOpen(true)}>
            Review campaign import…
          </button>
        </section>
      )}
      {member.role === "gm" && (
        <form className="campaign-form" onSubmit={(event) => void save(event)}>
          <h2>{editing ? "Edit this campaign" : "Create a campaign"}</h2>
          <label htmlFor="campaign-name">Campaign name</label>
          <input
            id="campaign-name"
            disabled={busy}
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <label htmlFor="campaign-description">Description</label>
          <textarea
            id="campaign-description"
            disabled={busy}
            maxLength={2000}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <label htmlFor="campaign-system">Game system</label>
          <select
            id="campaign-system"
            disabled={busy}
            value={systemId}
            onChange={(event) => setSystemId(event.target.value)}
          >
            {modules.map((module) => (
              <option key={module.id} value={module.id}>
                {module.name}
              </option>
            ))}
          </select>
          <button className="join-button" disabled={busy || !name.trim()}>
            {editing ? "Save campaign settings" : "Create campaign"}
          </button>
          {editing && (
            <div className="access-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    edit(
                      await accessRequest(
                        `/api/campaigns/${editing.id}`,
                        campaignMembershipSchema,
                      ),
                    );
                  })
                }
              >
                Discard draft &amp; reload settings
              </button>
              <button type="button" disabled={busy} onClick={newForm}>
                Cancel edit
              </button>
            </div>
          )}
        </form>
      )}
      <form
        className="campaign-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            try {
              accept(
                await accessRequest("/api/access/join", accessStatusSchema, {
                  name: member.name,
                  code: code.trim(),
                  keepIdentity: true,
                }),
              );
              close();
            } finally {
              setCode("");
            }
          });
        }}
      >
        <h2>Join another campaign</h2>
        <p>Use an invitation from its GM to keep your existing identity.</p>
        <label htmlFor="campaign-code">One-use invitation or return code</label>
        <input
          id="campaign-code"
          disabled={busy}
          type="password"
          autoComplete="off"
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        <button className="join-button" disabled={busy || !code.trim()}>
          Join campaign
        </button>
      </form>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}{" "}
          {editing &&
            "Your settings draft is kept here. Reload it explicitly if it is out of date."}
        </p>
      )}
      {importOpen && member.role === "gm" && (
        <Suspense fallback={<p role="status">Loading import review…</p>}>
          <CampaignImportReviewDialog close={() => setImportOpen(false)} />
        </Suspense>
      )}
      {exportOpen && member.role === "gm" && (
        <CampaignExportDialog
          member={member}
          close={() => setExportOpen(false)}
        />
      )}
      <button
        className="access-switch"
        disabled={busy}
        onClick={() => void act(load)}
      >
        {busy ? "Updating…" : "Refresh campaign list"}
      </button>
    </dialog>
  );
}
