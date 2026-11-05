import { Worker } from "node:worker_threads";
import { z } from "zod";
import { MAX_CAMPAIGN_ASSETS } from "@tableloom/core/assets";
import type { CampaignTransfer } from "./campaign-transfer-format.js";
import { StoreError } from "./store.js";
import {
  imageInspectionMetadataSchema,
  imageInspectionReplySchema,
  MAX_PREFLIGHT_IMAGE_PIXELS,
  MAX_PREFLIGHT_IMAGE_INPUT_BYTES,
  IMAGE_INSPECTION_TIMEOUT_MS,
} from "./campaign-image-contract.js";

function createWorker(): Worker {
  const source = import.meta.url.endsWith(".ts");
  const url = new URL(
    source ? "./campaign-image-worker.ts" : "./campaign-image-worker.js",
    import.meta.url,
  );
  const options = {
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
    },
  };
  // Source tests/dev use the installed loader. Production uses only the compiled
  // fixed worker entry and never needs tsx or arbitrary paths from a request.
  return source
    ? new Worker(
        `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(url.href)}, ${JSON.stringify(import.meta.url)})).catch(() => process.exit(1));`,
        { ...options, eval: true },
      )
    : new Worker(url, options);
}

export class CampaignImageInspector {
  private closed = false;
  private active: { abort: AbortController; done: Promise<void> } | undefined;
  constructor(
    private options: { timeoutMs?: number; workerFactory?: () => Worker } = {},
  ) {}
  get busy() {
    return this.active !== undefined;
  }
  assertAvailable() {
    if (this.closed)
      throw new StoreError("Campaign image inspection is closed.", 409);
    if (this.busy)
      throw new StoreError(
        "Campaign image inspection is busy. Retry after the current check finishes.",
        409,
      );
  }
  async close() {
    this.closed = true;
    const active = this.active;
    active?.abort.abort();
    await active?.done;
  }
  async inspect(
    images: CampaignTransfer["records"]["campaign_assets"],
    signal?: AbortSignal,
  ) {
    this.assertAvailable();
    if (signal?.aborted)
      throw new StoreError("Campaign image inspection was cancelled.", 409);
    const metadata = z
      .array(imageInspectionMetadataSchema)
      .max(MAX_CAMPAIGN_ASSETS)
      .parse(
        images.map((image) => ({
          id: image.id,
          width: image.width,
          height: image.height,
          byteLength: image.byte_length,
          sha256: image.sha256,
        })),
      );
    const pixels = metadata.reduce(
      (n, image) => n + image.width * image.height,
      0,
    );
    if (
      pixels > MAX_PREFLIGHT_IMAGE_PIXELS ||
      metadata.reduce((n, image) => n + image.byteLength, 0) >
        MAX_PREFLIGHT_IMAGE_INPUT_BYTES
    )
      throw new StoreError(
        "Campaign images exceed preflight work limits. Use a whole-instance backup.",
        400,
      );
    if (!images.length)
      return { checked: 0, pixels: 0, pixelLimit: MAX_PREFLIGHT_IMAGE_PIXELS };
    const job = {
      images: images.map((image, i) => {
        const meta = metadata[i]!;
        if (image.bytes.length !== 4 * Math.ceil(meta.byteLength / 3))
          throw new StoreError("Campaign contains an invalid PNG image.", 400);
        return {
          metadata: meta,
          bytes: Uint8Array.from(Buffer.from(image.bytes, "base64")),
        };
      }),
    };
    const abort = new AbortController(),
      onAbort = () => abort.abort();
    let completed!: () => void;
    const done = new Promise<void>((resolve) => {
      completed = resolve;
    });
    this.active = { abort, done };
    signal?.addEventListener("abort", onAbort, { once: true });
    let worker: Worker | undefined,
      cleanup = () => {};
    try {
      worker = (this.options.workerFactory ?? createWorker)();
      const current = worker;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new StoreError(
                "Campaign image inspection timed out. Use a smaller campaign or whole-instance backup.",
                409,
              ),
            ),
          this.options.timeoutMs ?? IMAGE_INSPECTION_TIMEOUT_MS,
        );
        const cancelled = () =>
          reject(
            new StoreError("Campaign image inspection was cancelled.", 409),
          );
        cleanup = () => {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", cancelled);
        };
        abort.signal.addEventListener("abort", cancelled, { once: true });
        current.once("message", (raw: unknown) => {
          const result = imageInspectionReplySchema.safeParse(raw);
          if (
            !result.success ||
            result.data.status !== "ok" ||
            result.data.count !== images.length ||
            result.data.pixels !== pixels
          )
            reject(
              new StoreError(
                "Campaign contains an invalid or noncanonical PNG image.",
                400,
              ),
            );
          else resolve();
        });
        current.once("error", () =>
          reject(
            new StoreError(
              "Campaign image inspection could not complete. Retry the check.",
              409,
            ),
          ),
        );
        current.once("exit", () =>
          reject(
            new StoreError(
              "Campaign image inspection ended before completing.",
              409,
            ),
          ),
        );
        if (abort.signal.aborted) {
          cancelled();
          return;
        }
        // Each Uint8Array owns a new buffer containing only its image, not a Node
        // Buffer pool that might include unrelated credentials or request data.
        current.postMessage(
          job,
          job.images.map((image) => image.bytes.buffer),
        );
      });
      return {
        checked: images.length,
        pixels,
        pixelLimit: MAX_PREFLIGHT_IMAGE_PIXELS,
      };
    } finally {
      cleanup();
      signal?.removeEventListener("abort", onAbort);
      try {
        if (worker) await worker.terminate();
      } finally {
        this.active = undefined;
        completed();
      }
    }
  }
}
