import { useEffect, useRef, useState } from "react";
import {
  assetSchema,
  assetPageSchema,
  MAX_ASSET_BYTES,
} from "@tableloom/core/assets";
import type { Asset } from "@tableloom/core/assets";
import { z } from "zod";
import { accessRequest } from "./useAccess.js";

export function AssetLibraryDialog({
  campaignId,
  close,
}: {
  campaignId: string;
  close: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    requests = useRef<AbortController[]>([]),
    alive = useRef(true),
    sequence = useRef(0),
    [assets, setAssets] = useState<Asset[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [usage, setUsage] = useState({ count: 0, bytes: 0 }),
    [file, setFile] = useState<File | null>(null),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [preview, setPreview] = useState<Asset | null>(null),
    [remove, setRemove] = useState<Asset | null>(null);
  const root = `/api/campaigns/${campaignId}/assets`;
  async function load(after?: string) {
    const generation = ++sequence.current,
      controller = new AbortController();
    requests.current.push(controller);
    setLoading(true);
    try {
      const response = await fetch(
        `${root}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        },
      );
      const json: unknown = await response.json();
      if (!response.ok)
        throw new Error(z.object({ error: z.string() }).parse(json).error);
      const page = assetPageSchema.parse(json);
      if (alive.current && generation === sequence.current) {
        setAssets((previous) =>
          after
            ? [
                ...new Map(
                  [...previous, ...page.assets].map((a) => [a.id, a]),
                ).values(),
              ]
            : page.assets,
        );
        setCursor(page.nextCursor);
        setUsage({ count: page.totalCount, bytes: page.usedBytes });
      }
    } catch (err) {
      if (
        alive.current &&
        !controller.signal.aborted &&
        generation === sequence.current
      )
        setError(err instanceof Error ? err.message : "Unable to load assets.");
    } finally {
      requests.current = requests.current.filter((c) => c !== controller);
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
      requests.current.forEach((c) => c.abort());
      element?.close();
    };
  }, [campaignId]);
  async function upload() {
    if (!file || busy || file.size > MAX_ASSET_BYTES || !name.trim()) return;
    const controller = new AbortController();
    requests.current.push(controller);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `${root}?name=${encodeURIComponent(name.trim())}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type":
              file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name)
                ? "image/jpeg"
                : "image/png",
          },
          body: file,
          signal: controller.signal,
        },
      );
      const json: unknown = await response.json();
      if (!response.ok)
        throw new Error(z.object({ error: z.string() }).parse(json).error);
      const asset = assetSchema.parse(json);
      if (alive.current) {
        setPreview(asset);
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
        setName("");
        setMessage(
          "Uploaded privately. Only this campaign’s GMs can access it.",
        );
        await load();
      }
    } catch (err) {
      if (alive.current && !controller.signal.aborted)
        setError(
          err instanceof Error
            ? `${err.message} Refresh the library before retrying an unconfirmed upload.`
            : "Unable to confirm upload. Refresh before retrying.",
        );
    } finally {
      requests.current = requests.current.filter((c) => c !== controller);
      if (alive.current) setBusy(false);
    }
  }
  async function deleteAsset() {
    if (!remove || busy) return;
    const selected = remove;
    setBusy(true);
    setError("");
    try {
      await accessRequest(
        `${root}/${selected.id}/delete`,
        z.object({ ok: z.literal(true) }),
        {},
      );
      if (alive.current) {
        setRemove(null);
        if (preview?.id === selected.id) setPreview(null);
        setMessage("Private asset removed.");
        await load();
      }
    } catch (err) {
      if (alive.current)
        setError(
          err instanceof Error
            ? err.message
            : "Unable to confirm removal. Refresh the library.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="join-card invite-dialog asset-library"
      aria-labelledby="asset-library-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) close();
      }}
    >
      <span className="eyebrow">PRIVATE GM LIBRARY</span>
      <h1 id="asset-library-title">Maps & images</h1>
      <p>
        Your asset library is GM-only. Use Scene map to place an image, then
        reveal the background when your group is ready.
      </p>
      <p>
        {usage.count}/200 images · {(usage.bytes / 1024 / 1024).toFixed(1)}/100
        MiB stored
      </p>
      <label htmlFor="asset-file">PNG or JPEG image (up to 5 MiB)</label>
      <input
        ref={fileInput}
        id="asset-file"
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        disabled={busy}
        onChange={(event) => {
          const selected = event.target.files?.[0] ?? null;
          setFile(selected);
          setName(selected?.name.slice(0, 120) ?? "");
          setError(
            selected && selected.size > MAX_ASSET_BYTES
              ? "Choose an image no larger than 5 MiB."
              : "",
          );
        }}
      />
      <label htmlFor="asset-name">Image name</label>
      <input
        id="asset-name"
        value={name}
        maxLength={120}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
      <p className="asset-help">
        Static PNGs: RGB/RGBA, indexed color, or grayscale, including 16-bit and
        interlaced images, with transparency. JPEGs are converted to PNG with
        orientation applied and metadata removed; CMYK is unsupported. Both the
        upload and saved PNG must fit 5 MiB, up to 8192 pixels per side and 16
        megapixels. Large 16-bit or interlaced PNGs may need smaller dimensions
        to fit the image memory limit.
      </p>
      <div className="selection-delete-actions">
        <button
          disabled={busy || loading}
          onClick={() => {
            setError("");
            setPreview(null);
            void load();
          }}
        >
          Refresh library
        </button>
        <button
          className="token-size-confirm"
          disabled={
            busy || !file || file.size > MAX_ASSET_BYTES || !name.trim()
          }
          onClick={() => void upload()}
        >
          {busy ? "Saving…" : "Upload privately"}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {preview && (
        <figure className="asset-preview">
          <figcaption>
            {preview.name} · {preview.width} × {preview.height}
          </figcaption>
          <img
            key={preview.id}
            src={`${root}/${preview.id}/content`}
            alt={preview.name}
            onError={() => {
              setPreview(null);
              setError(
                "Preview unavailable. Refresh the library and check your access.",
              );
            }}
          />
        </figure>
      )}
      {loading && <p role="status">Loading private assets…</p>}
      {!loading && !assets.length && <p>Your private library is empty.</p>}
      <ul className="asset-list">
        {assets.map((asset) => (
          <li key={asset.id}>
            <span>
              <strong>{asset.name}</strong>
              <small>
                {asset.width} × {asset.height} ·{" "}
                {(asset.byteLength / 1024).toFixed(1)} KiB
              </small>
            </span>
            <button
              disabled={busy}
              aria-label={`Preview ${asset.name}`}
              onClick={() => {
                setError("");
                setPreview(asset);
              }}
            >
              Preview
            </button>
            <button
              disabled={busy}
              aria-label={`Remove ${asset.name}`}
              onClick={() => setRemove(asset)}
            >
              Remove…
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button disabled={busy || loading} onClick={() => void load(cursor)}>
          Load more assets
        </button>
      )}
      {remove && (
        <div className="asset-remove" role="alert">
          <p>
            Permanently remove “{remove.name}”? This private upload has no Undo
            or trash recovery.
          </p>
          <button disabled={busy} onClick={() => setRemove(null)}>
            Keep asset
          </button>
          <button disabled={busy} onClick={() => void deleteAsset()}>
            Remove permanently
          </button>
        </div>
      )}
      <div className="selection-delete-actions">
        <button autoFocus disabled={busy} onClick={close}>
          Close library
        </button>
      </div>
    </dialog>
  );
}
