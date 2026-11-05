import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { CampaignImageInspector } from "./campaign-image-inspection.js";
import { MAX_PREFLIGHT_IMAGE_PIXELS } from "./campaign-image-contract.js";
import type { CampaignTransfer } from "./campaign-transfer-format.js";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { StoreError } from "./store.js";
import { pngFixture, pngChunk, indexedMapFixture } from "./png-fixture.js";
import { indexedPassFixture } from "./png-pass-fixture.js";

function image(
  bytes = pngFixture(),
  width = 32,
  height = 24,
): CampaignTransfer["records"]["campaign_assets"][number] {
  return {
    id: randomUUID(),
    campaign_id: DEFAULT_CAMPAIGN_ID,
    name: "PRIVATE IMAGE CANARY",
    byte_length: bytes.length,
    width,
    height,
    created_at: new Date(0).toISOString(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.toString("base64"),
  };
}
const status = (code: number) => (error: unknown) =>
  error instanceof StoreError &&
  error.statusCode === code &&
  !error.message.includes("PRIVATE IMAGE CANARY");

test("image worker accepts canonical RGBA, palette, 16-bit and Adam7 PNGs and preserves source bytes", async () => {
  const inspector = new CampaignImageInspector();
  try {
    const images = [
        image(),
        image(indexedMapFixture(16, 12), 16, 12),
        image(
          pngFixture(3, 2, { depth: 16, raw: Buffer.alloc((3 * 8 + 1) * 2) }),
          3,
          2,
        ),
        image(indexedPassFixture(17, 13), 17, 13),
      ],
      before = JSON.stringify(images);
    const checked = await inspector.inspect(images);
    assert.equal(checked.checked, images.length);
    assert.equal(checked.pixels, 32 * 24 + 16 * 12 + 3 * 2 + 17 * 13);
    assert.equal(checked.pixelLimit, MAX_PREFLIGHT_IMAGE_PIXELS);
    assert.equal(JSON.stringify(images), before);
    assert.equal(inspector.busy, false);
    assert.deepEqual(await inspector.inspect([]), {
      checked: 0,
      pixels: 0,
      pixelLimit: MAX_PREFLIGHT_IMAGE_PIXELS,
    });
  } finally {
    await inspector.close();
  }
});

test("image worker rejects corrupt IDAT/CRC, dimension lies, ancillary payloads and trailing bytes even with matching archive hashes", async () => {
  const inspector = new CampaignImageInspector();
  try {
    const corruptCrc = pngFixture();
    corruptCrc[30] = corruptCrc[30]! ^ 1;
    for (const invalid of [
      image(pngFixture(32, 24, { packed: Buffer.from([0x78, 0x9c, 0]) })),
      image(corruptCrc),
      image(pngFixture(), 31, 24),
      image(
        pngFixture(32, 24, {
          extra: pngChunk("tEXt", Buffer.from("private\0PRIVATE IMAGE CANARY")),
        }),
      ),
      image(Buffer.concat([pngFixture(), Buffer.from("trailing bytes")])),
    ]) {
      await assert.rejects(inspector.inspect([invalid]), status(400));
      assert.equal(inspector.busy, false);
    }
    assert.equal((await inspector.inspect([image()])).checked, 1);
  } finally {
    await inspector.close();
  }
});

test("image work budgets reject excessive aggregate pixels before allocating a worker", async () => {
  let created = false;
  const inspector = new CampaignImageInspector({
    workerFactory: () => {
      created = true;
      throw new Error("Must not allocate");
    },
  });
  try {
    const images = Array.from({ length: 5 }, () =>
      image(pngFixture(), 8192, 2048),
    );
    await assert.rejects(
      inspector.inspect(images),
      (error: unknown) =>
        status(400)(error) &&
        error instanceof Error &&
        error.message.includes("work limits"),
    );
    assert.equal(created, false);
    assert.equal(inspector.busy, false);
  } finally {
    await inspector.close();
  }
});

test("busy, timeout, cancellation and shutdown wait for worker termination and release the slot", async () => {
  let terminated = false;
  const inspector = new CampaignImageInspector({
    timeoutMs: 100,
    workerFactory: () => {
      const worker = new Worker(
        "require('node:worker_threads').parentPort.on('message', () => {});",
        { eval: true, execArgv: [] },
      );
      worker.once("exit", () => {
        terminated = true;
      });
      return worker;
    },
  });
  try {
    const timedOut = assert.rejects(
      inspector.inspect([image()]),
      (error: unknown) =>
        status(409)(error) &&
        error instanceof Error &&
        error.message.includes("timed out"),
    );
    assert.equal(inspector.busy, true);
    await assert.rejects(inspector.inspect([image()]), status(409));
    await timedOut;
    assert.equal(terminated, true);
    assert.equal(inspector.busy, false);
    terminated = false;
    const abort = new AbortController(),
      cancelled = assert.rejects(
        inspector.inspect([image()], abort.signal),
        status(409),
      );
    abort.abort();
    await cancelled;
    assert.equal(terminated, true);
    assert.equal(inspector.busy, false);
    terminated = false;
    const closed = assert.rejects(inspector.inspect([image()]), status(409));
    await inspector.close();
    await closed;
    assert.equal(terminated, true);
    assert.equal(inspector.busy, false);
    await assert.rejects(inspector.inspect([image()]), status(409));
  } finally {
    await inspector.close();
  }
});

test("a crashing worker yields a generic error without leaking its exception and leaves no busy slot", async () => {
  const inspector = new CampaignImageInspector({
    workerFactory: () =>
      new Worker("throw new Error('PRIVATE IMAGE CANARY');", {
        eval: true,
        execArgv: [],
      }),
  });
  try {
    await assert.rejects(inspector.inspect([image()]), status(409));
    assert.equal(inspector.busy, false);
  } finally {
    await inspector.close();
  }
});
