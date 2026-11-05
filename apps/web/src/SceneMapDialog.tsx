import { useEffect, useRef, useState } from "react";
import {
  backgroundStateSchema,
  backgroundMapSchema,
} from "@tableloom/core/scene-map";
import type { BackgroundState } from "@tableloom/core/scene-map";
import { assetPageSchema } from "@tableloom/core/assets";
import type { Asset } from "@tableloom/core/assets";
import { contextKey } from "@tableloom/core/campaigns";
import type { CommandContext } from "@tableloom/core/campaigns";
import { accessRequest } from "./useAccess.js";
export function SceneMapDialog({
  context,
  version,
  enabled,
  close,
}: {
  context: CommandContext;
  version: number | null;
  enabled: boolean;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    alive = useRef(true),
    sequence = useRef(0),
    [state, setState] = useState<BackgroundState | null>(null),
    [assets, setAssets] = useState<Asset[]>([]),
    [assetId, setAssetId] = useState(""),
    [x, setX] = useState("0"),
    [y, setY] = useState("0"),
    [width, setWidth] = useState("600"),
    [ack, setAck] = useState(false),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const root = `/api/campaigns/${context.campaignId}/scene-map`;
  async function load() {
    const generation = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const current = await accessRequest(root, backgroundStateSchema);
      if (contextKey(current.context) !== contextKey(context))
        throw new Error("The active scene changed. Reopen map settings.");
      const all: Asset[] = [];
      let cursor: string | null = null;
      do {
        const page: ReturnType<typeof assetPageSchema.parse> =
          await accessRequest(
            `/api/campaigns/${context.campaignId}/assets?limit=50${cursor ? `&after=${cursor}` : ""}`,
            assetPageSchema,
          );
        all.push(...page.assets);
        cursor = page.nextCursor;
        if (all.length > 200)
          throw new Error("The asset library changed. Reload settings.");
      } while (cursor);
      if (alive.current && generation === sequence.current) {
        setState(current);
        setAssets(all);
        setAssetId(current.map?.assetId ?? all[0]?.id ?? "");
        setX(String(current.map?.position.x ?? 0));
        setY(String(current.map?.position.y ?? 0));
        setWidth(String(current.map?.width ?? 600));
        setAck(false);
        setRemove(false);
      }
    } catch (err) {
      if (alive.current && generation === sequence.current)
        setError(
          err instanceof Error ? err.message : "Unable to load map settings.",
        );
    } finally {
      if (alive.current && generation === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    void load();
    return () => {
      alive.current = false;
      ++sequence.current;
      element?.close();
    };
  }, [contextKey(context)]);
  const asset = assets.find((a) => a.id === assetId),
    stale = state && state.version !== version,
    candidate = asset
      ? backgroundMapSchema.safeParse({
          assetId,
          imageId: assetId,
          position: { x: Number(x), y: Number(y) },
          width: Number(width),
          height: (Number(width) * asset.height) / asset.width,
          visibility: "gm",
        })
      : null,
    changed =
      !state?.map ||
      state.map.assetId !== assetId ||
      state.map.position.x !== Number(x) ||
      state.map.position.y !== Number(y) ||
      state.map.width !== Number(width),
    disabled = !enabled || busy || loading || !state || Boolean(stale);
  async function save(
    action: "set" | "visibility" | "remove",
    fields: Record<string, unknown> = {},
  ) {
    if (disabled || !state) return;
    setBusy(true);
    setError("");
    try {
      await accessRequest(`${root}/${action}`, backgroundStateSchema, {
        context,
        expectedVersion: state.version,
        ...fields,
      });
      if (alive.current) close();
    } catch (err) {
      if (alive.current)
        setError(
          err instanceof Error
            ? `${err.message} Reload settings before retrying an unconfirmed change.`
            : "Unable to confirm change. Reload map settings.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="join-card invite-dialog scene-map-dialog"
      aria-labelledby="scene-map-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <span className="eyebrow">BACKGROUND MAP</span>
      <h1 id="scene-map-title">Set the scene</h1>
      <p>
        One map sits below drawings and tokens. A new image starts GM-only;
        reveal it when your group is ready. Map changes have no Undo yet.
      </p>
      {state && (
        <p role="status">
          {state.map
            ? state.map.visibility === "gm"
              ? "Current map: GM-only"
              : "Current map: revealed to the campaign"
            : "No background map"}
        </p>
      )}
      <label htmlFor="scene-map-asset">Image from Map assets</label>
      <select
        id="scene-map-asset"
        value={assetId}
        disabled={disabled}
        onChange={(e) => setAssetId(e.target.value)}
      >
        <option value="">Choose an image</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.width} × {a.height})
          </option>
        ))}
      </select>
      {!loading && !assets.length && <p>Upload a PNG in Map assets first.</p>}
      <div className="map-fields">
        <label>
          X
          <input
            type="number"
            step="any"
            value={x}
            disabled={disabled}
            onChange={(e) => setX(e.target.value)}
          />
        </label>
        <label>
          Y
          <input
            type="number"
            step="any"
            value={y}
            disabled={disabled}
            onChange={(e) => setY(e.target.value)}
          />
        </label>
        <label>
          Width
          <input
            type="number"
            step="any"
            min="1"
            max="20000"
            value={width}
            disabled={disabled}
            onChange={(e) => setWidth(e.target.value)}
          />
        </label>
      </div>
      <p>
        Canvas units; image proportions stay fixed. Saving a revealed image’s
        position/size updates it for everyone. Changing the image starts
        private.
      </p>
      {asset && !candidate?.success && (
        <p className="form-error" role="alert">
          Choose a width of at least 1 and keep the whole map within −10,000 to
          10,000.
        </p>
      )}
      {stale && (
        <p className="form-error" role="alert">
          This map changed elsewhere. Reload settings before saving.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading map settings…</p>}
      <div className="selection-delete-actions">
        <button disabled={busy} onClick={() => void load()}>
          Reload settings
        </button>
        <button
          className="token-size-confirm"
          disabled={disabled || !candidate?.success || !changed}
          onClick={() =>
            void save("set", {
              assetId,
              position: { x: Number(x), y: Number(y) },
              width: Number(width),
            })
          }
        >
          Save map
        </button>
      </div>
      {state?.map && changed && (
        <p>
          Save or reload your draft before changing map visibility or removing
          it.
        </p>
      )}
      {state?.map?.visibility === "gm" && (
        <>
          <label className="map-reveal-check">
            <input
              type="checkbox"
              checked={ack}
              disabled={disabled || changed}
              onChange={(e) => setAck(e.target.checked)}
            />
            Reveal this map to everyone in the campaign
          </label>
          <button
            className="map-action"
            disabled={disabled || changed || !ack}
            onClick={() =>
              void save("visibility", {
                visibility: "public",
                acknowledgeReveal: true,
              })
            }
          >
            Reveal map
          </button>
        </>
      )}
      {state?.map?.visibility === "public" && (
        <>
          <p>
            Hiding stops future access; players may already have seen or saved
            this image.
          </p>
          <button
            className="map-action"
            disabled={disabled || changed}
            onClick={() => void save("visibility", { visibility: "gm" })}
          >
            Hide map from players
          </button>
        </>
      )}
      {state?.map && (
        <>
          <button
            className="map-action"
            disabled={disabled || changed}
            onClick={() => setRemove(true)}
          >
            Remove map…
          </button>
          {remove && (
            <p>
              Remove this scene’s map? The uploaded asset stays in the private
              library.{" "}
              <button disabled={disabled} onClick={() => void save("remove")}>
                Remove background
              </button>
              <button disabled={busy} onClick={() => setRemove(false)}>
                Keep map
              </button>
            </p>
          )}
        </>
      )}
      <div className="selection-delete-actions">
        <button autoFocus disabled={busy} onClick={close}>
          Close settings
        </button>
      </div>
    </dialog>
  );
}
