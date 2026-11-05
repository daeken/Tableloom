import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { Member } from "@tableloom/core/access";
import {
  CampaignExportClient,
  emptyCampaignExport,
  exportRequest,
} from "./campaign-export-client.js";

export function CampaignExportDialog({
  member,
  close,
}: {
  member: Member;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    save = useRef<HTMLAnchorElement>(null),
    [view, setView] = useState(emptyCampaignExport),
    [client] = useState(
      () => new CampaignExportClient(member, exportRequest, setView),
    ),
    [downloadUrl, setDownloadUrl] = useState("");
  useEffect(() => {
    const element = dialog.current,
      trigger = document.activeElement;
    element?.showModal();
    client.start();
    void client.review();
    return () => {
      client.stop();
      element?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, [client]);
  useEffect(() => {
    if (!view.artifact) {
      setDownloadUrl("");
      return;
    }
    const url = URL.createObjectURL(view.artifact.blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [view.artifact]);
  useEffect(() => {
    if (downloadUrl) save.current?.focus();
  }, [downloadUrl]);
  return createPortal(
    <dialog
      ref={dialog}
      className="join-card invite-dialog access-management campaign-export-dialog"
      aria-labelledby="campaign-export-title"
      aria-describedby="campaign-export-privacy"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <button
        autoFocus
        type="button"
        className="dialog-close"
        aria-label="Close export"
        onClick={close}
      >
        <X size={18} />
      </button>
      <h1 id="campaign-export-title">Export a private campaign file</h1>
      <p id="campaign-export-privacy">
        This file includes every scene, unrevealed maps and images, private
        notes and chat, character records, owned content, dice and editing
        history. Keep it private; it is not a player handout. Secrets written in
        notes or other records remain in the file.
      </p>
      {view.campaign && (
        <section
          aria-label="Campaign to export"
          className="campaign-export-summary"
        >
          <h2>{view.campaign.name}</h2>
          <p>
            Game system: {view.campaign.system.id} ·{" "}
            {view.campaign.system.version}
          </p>
          <p>
            {view.campaign.contentPacks.length} selected content{" "}
            {view.campaign.contentPacks.length === 1 ? "pack" : "packs"}
          </p>
        </section>
      )}
      <p>
        Includes this campaign’s content and ownership labels, without sign-in
        sessions, invitation codes or the host key. Importing requires
        compatible game modules and a separate ownership review. Files are
        unencrypted and limited to 32 MiB. Use a whole-instance backup for
        server recovery.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void client.download();
        }}
      >
        <label className="campaign-export-consent">
          <input
            type="checkbox"
            required
            checked={view.acknowledged}
            disabled={!!view.busy || !view.campaign}
            onChange={(event) => client.acknowledge(event.target.checked)}
          />
          <span>
            I understand this file includes private and unrevealed campaign
            content.
          </span>
        </label>
        <div className="access-actions">
          <button
            className="join-button"
            disabled={!!view.busy || !view.campaign || !view.acknowledged}
          >
            Prepare private file
          </button>
          <button
            type="button"
            disabled={!!view.busy}
            onClick={() => void client.review()}
          >
            Review latest campaign
          </button>
        </div>
      </form>
      {view.busy && (
        <p role="status">
          {view.busy === "review"
            ? "Loading campaign review…"
            : "Preparing private file…"}
        </p>
      )}
      {view.error && (
        <p role="alert" className="inline-error">
          {view.error}
        </p>
      )}
      {view.artifact && downloadUrl && (
        <div className="campaign-export-download">
          <p role="status">
            Private file ready ({(view.artifact.bytes / 1024).toFixed(1)} KiB).
            Save it to your device.
          </p>
          <a
            ref={save}
            className="join-button"
            href={downloadUrl}
            download={view.artifact.filename}
          >
            Save private campaign file
          </a>
          <p>
            If your browser opens the file instead, use its save option. Closing
            this review discards the prepared download.
          </p>
        </div>
      )}
      <button type="button" onClick={close}>
        Close export review
      </button>
    </dialog>,
    document.body,
  );
}
