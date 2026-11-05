import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { imageInspectionJobSchema } from "./campaign-image-contract.js";
import { sanitizePng } from "./png.js";

if (!parentPort)
  throw new Error("Image inspection must run in its fixed worker.");
const port = parentPort;
port.once("message", (raw: unknown) => {
  try {
    const job = imageInspectionJobSchema.parse(raw);
    let pixels = 0;
    for (const { metadata, bytes: input } of job.images) {
      const bytes = Buffer.from(
        input.buffer,
        input.byteOffset,
        input.byteLength,
      );
      // Check the first IHDR dimensions before decompression: declared work budgets
      // must not be bypassed by a small declared size and a large encoded raster.
      if (
        bytes.length !== metadata.byteLength ||
        bytes.length < 33 ||
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.readUInt32BE(8) !== 13 ||
        !bytes.subarray(12, 16).equals(Buffer.from("IHDR")) ||
        bytes.readUInt32BE(16) !== metadata.width ||
        bytes.readUInt32BE(20) !== metadata.height ||
        createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
      )
        throw new Error("Invalid image envelope");
      const checked = sanitizePng(bytes);
      if (
        checked.width !== metadata.width ||
        checked.height !== metadata.height ||
        !checked.bytes.equals(bytes)
      )
        throw new Error("Noncanonical image");
      pixels += checked.width * checked.height;
    }
    port.postMessage({ status: "ok", count: job.images.length, pixels });
  } catch {
    // Never send decoder errors, image bytes or private names to the parent/logs.
    port.postMessage({ status: "invalid" });
  }
});
