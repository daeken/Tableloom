import { z } from "zod";
import { inflateSync, crc32 } from "node:zlib";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DIMENSION,
  MAX_ASSET_PIXELS,
} from "@tableloom/core/assets";
import { StoreError } from "./store.js";
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const invalid = () =>
  new StoreError(
    "Upload a valid static, non-interlaced 8-bit RGB or RGBA PNG within the image limits.",
    400,
  );
/** Validate complete structure/checksums and bounded pixel data; discard ancillary metadata. */
export function sanitizePng(input: Buffer) {
  if (
    input.length > MAX_ASSET_BYTES ||
    input.length < 45 ||
    !input.subarray(0, 8).equals(signature)
  )
    throw invalid();
  let offset = 8,
    count = 0,
    width = 0,
    height = 0,
    channels = 0,
    dataStarted = false,
    dataEnded = false,
    ended = false,
    palette = false;
  const kept: Buffer[] = [signature],
    compressed: Buffer[] = [];
  while (offset < input.length) {
    if (++count > 1024 || offset + 12 > input.length) throw invalid();
    const length = input.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > input.length) throw invalid();
    const kind = input.toString("ascii", offset + 4, offset + 8),
      body = input.subarray(offset + 8, end - 4);
    if (
      !input
        .subarray(offset + 4, offset + 8)
        .every(
          (byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122),
        ) ||
      (input[offset + 6]! & 32) !== 0 ||
      crc32(input.subarray(offset + 4, end - 4)) !== input.readUInt32BE(end - 4)
    )
      throw invalid();
    if (count === 1 && kind !== "IHDR") throw invalid();
    if (dataStarted && kind !== "IDAT") dataEnded = true;
    if (kind === "IHDR") {
      if (count !== 1 || length !== 13) throw invalid();
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (
        !width ||
        !height ||
        width > MAX_ASSET_DIMENSION ||
        height > MAX_ASSET_DIMENSION ||
        width * height > MAX_ASSET_PIXELS ||
        body[8] !== 8 ||
        ![2, 6].includes(body[9]!) ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        body[12] !== 0
      )
        throw invalid();
      channels = body[9] === 2 ? 3 : 4;
      kept.push(input.subarray(offset, end));
    } else if (kind === "IDAT") {
      if (dataEnded) throw invalid();
      dataStarted = true;
      compressed.push(body);
      kept.push(input.subarray(offset, end));
    } else if (kind === "IEND") {
      if (length !== 0 || !dataStarted || end !== input.length) throw invalid();
      kept.push(input.subarray(offset, end));
      ended = true;
    } else if (kind === "PLTE") {
      if (
        palette ||
        dataStarted ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0
      )
        throw invalid();
      palette = true; // Optional suggested palette is unnecessary for RGB/RGBA decoding.
    } else if (
      ["acTL", "fcTL", "fdAT", "tRNS"].includes(kind) ||
      kind[0] === kind[0]!.toUpperCase()
    )
      throw invalid();
    offset = end;
  }
  if (!ended) throw invalid();
  const packed = Buffer.concat(compressed),
    stride = width * channels + 1,
    expected = stride * height;
  try {
    const raw: unknown = inflateSync(packed, {
      maxOutputLength: expected + 1,
      info: true,
    });
    const decoded = z
      .object({
        buffer: z.instanceof(Buffer),
        engine: z.object({ bytesWritten: z.number().int().nonnegative() }),
      })
      .parse(raw);
    if (
      decoded.buffer.length !== expected ||
      decoded.engine.bytesWritten !== packed.length
    )
      throw invalid();
    for (let row = 0; row < height; row++)
      if (decoded.buffer[row * stride]! > 4) throw invalid();
  } catch {
    throw invalid();
  }
  return { bytes: Buffer.concat(kept), width, height };
}
