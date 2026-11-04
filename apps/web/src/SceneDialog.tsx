import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  sceneListSchema,
  sceneSchema,
  campaignMembershipSchema,
} from "@tableloom/core/campaigns";
import type { Scene, CommandContext } from "@tableloom/core/campaigns";
import { accessRequest } from "./useAccess.js";

export function SceneDialog({
  context,
  enabled,
  close,
}: {
  context: CommandContext;
  enabled: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    reads = useRef(0);
  const [scenes, setScenes] = useState<Scene[]>([]),
    [name, setName] = useState("");
  const [review, setReview] = useState<{
    scene: Scene;
    generation: number;
  } | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  async function load() {
    const sequence = ++reads.current;
    const list = await accessRequest(
      `/api/campaigns/${context.campaignId}/scenes`,
      sceneListSchema,
    );
    if (sequence === reads.current) setScenes(list);
  }
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let active = true;
    void load()
      .catch((err: unknown) => {
        if (active)
          setError(
            err instanceof Error ? err.message : "Unable to load scenes.",
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
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update scenes.");
    } finally {
      setBusy(false);
    }
  }
  const stale = review !== null && review.generation !== context.generation;
  return (
    <dialog
      ref={dialog}
      className="join-card invite-dialog access-management campaign-dialog"
      onCancel={close}
      aria-labelledby="scene-title"
    >
      <button
        className="dialog-close"
        onClick={close}
        aria-label="Close scenes"
      >
        <X size={17} />
      </button>
      <span className="eyebrow">GM CONTROLS</span>
      <h1 id="scene-title">Set the scene.</h1>
      <p>
        Only the GM sees this list. Showing a scene changes the battlefield for
        everyone in this campaign. Notes and rolls stay with the campaign.
      </p>
      <ul className="access-list campaign-list">
        {scenes.map((scene) => (
          <li key={scene.id}>
            <strong>{scene.name}</strong>
            {scene.id === context.sceneId ? (
              <small>Currently shown to the table</small>
            ) : (
              <button
                disabled={busy || !enabled}
                onClick={() =>
                  setReview({ scene, generation: context.generation })
                }
              >
                Show this scene…
              </button>
            )}
          </li>
        ))}
      </ul>
      {review && (
        <section className="ownership-review" aria-label="Review scene change">
          <h2>Show {review.scene.name}?</h2>
          <p>
            Everyone will move to this battlefield. The current scene’s drawings
            and tokens are kept for when you return.
          </p>
          {stale && (
            <p role="alert">
              The campaign changed. Choose the scene again before confirming.
            </p>
          )}
          <button
            className="join-button"
            disabled={busy || stale || !enabled}
            onClick={() =>
              void act(async () => {
                await accessRequest(
                  `/api/campaigns/${context.campaignId}/activate`,
                  campaignMembershipSchema,
                  {
                    sceneId: review.scene.id,
                    expectedVersion: review.generation,
                  },
                );
                setReview(null);
                await load();
              })
            }
          >
            Show scene to everyone
          </button>
          <button
            className="access-switch"
            disabled={busy || !enabled}
            onClick={() => setReview(null)}
          >
            Keep current scene
          </button>
        </section>
      )}
      <form
        className="campaign-form"
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            await accessRequest(
              `/api/campaigns/${context.campaignId}/scenes`,
              sceneSchema,
              { name },
            );
            setName("");
            await load();
          });
        }}
      >
        <h2>Create a scene</h2>
        <label htmlFor="scene-name">Scene name</label>
        <input
          id="scene-name"
          disabled={busy || !enabled}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="join-button"
          disabled={busy || !name.trim() || !enabled}
        >
          Create empty scene
        </button>
        <small>New scenes stay offstage until you choose to show them.</small>
      </form>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="access-switch"
        disabled={busy || !enabled}
        onClick={() => void act(load)}
      >
        {busy ? "Updating…" : "Refresh scene list"}
      </button>
    </dialog>
  );
}
