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
    "Upload a valid static, non-interlaced PNG: RGB/RGBA or grayscale-alpha at 8 bits, grayscale/indexed at 1, 2, 4 or 8 bits, within the image limits.",
    400,
  );
/** Validate bounded image data; keep decoding-critical palette/transparency, discard other metadata.
 * Mode, palette, transparency and row reconstruction contracts: https://www.w3.org/TR/png-3/ (§7, §9, §11).
 */
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
    color = 0,
    depth = 0,
    dataStarted = false,
    dataEnded = false,
    ended = false,
    paletteEntries = 0,
    transparency = false;
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
      color = body[9]!;
      depth = body[8]!;
      const validMode = [0, 3].includes(color)
        ? [1, 2, 4, 8].includes(depth)
        : [2, 4, 6].includes(color) && depth === 8;
      if (
        !width ||
        !height ||
        width > MAX_ASSET_DIMENSION ||
        height > MAX_ASSET_DIMENSION ||
        width * height > MAX_ASSET_PIXELS ||
        !validMode ||
        body[10] !== 0 ||
        body[11] !== 0 ||
        body[12] !== 0
      )
        throw invalid();
      channels = color === 2 ? 3 : color === 6 ? 4 : color === 4 ? 2 : 1;
      kept.push(input.subarray(offset, end));
    } else if (kind === "IDAT") {
      if (dataEnded || (color === 3 && !paletteEntries)) throw invalid();
      dataStarted = true;
      compressed.push(body);
      kept.push(input.subarray(offset, end));
    } else if (kind === "IEND") {
      if (length !== 0 || !dataStarted || end !== input.length) throw invalid();
      kept.push(input.subarray(offset, end));
      ended = true;
    } else if (kind === "PLTE") {
      if (
        paletteEntries ||
        dataStarted ||
        transparency ||
        [0, 4].includes(color) ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0
      )
        throw invalid();
      paletteEntries = length / 3;
      if (color === 3) {
        if (paletteEntries > 2 ** depth) throw invalid();
        kept.push(input.subarray(offset, end));
      } // Optional suggested truecolor palettes can be discarded.
    } else if (kind === "tRNS") {
      if (transparency || dataStarted) throw invalid();
      if (color === 3) {
        if (!paletteEntries || !length || length > paletteEntries)
          throw invalid();
      } else if (color === 0 || color === 2) {
        if (length !== (color === 0 ? 2 : 6)) throw invalid();
        for (let sample = 0; sample < length; sample += 2)
          if (body.readUInt16BE(sample) >= 2 ** depth) throw invalid();
      } else throw invalid();
      transparency = true;
      kept.push(input.subarray(offset, end));
    } else if (
      ["acTL", "fcTL", "fdAT"].includes(kind) ||
      kind[0] === kind[0]!.toUpperCase()
    )
      throw invalid();
    offset = end;
  }
  if (!ended) throw invalid();
  const packed = Buffer.concat(compressed),
    stride = Math.ceil((width * channels * depth) / 8) + 1,
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
    for (let row = 0; row < height; row++) {
      const start = row * stride,
        filter = decoded.buffer[start]!;
      if (filter > 4) throw invalid();
      if (color !== 3) continue;
      // Indexed samples must refer to real palette entries, even after filtering.
      // Reverse in the bounded inflate buffer; original compressed bytes stay intact.
      for (let byte = 1; byte < stride; byte++) {
        const left = byte > 1 ? decoded.buffer[start + byte - 1]! : 0,
          up = row > 0 ? decoded.buffer[start - stride + byte]! : 0,
          upperLeft =
            row > 0 && byte > 1
              ? decoded.buffer[start - stride + byte - 1]!
              : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = Math.floor((left + up) / 2);
        else if (filter === 4) {
          const p = left + up - upperLeft,
            a = Math.abs(p - left),
            b = Math.abs(p - up),
            c = Math.abs(p - upperLeft);
          predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft;
        }
        decoded.buffer[start + byte] =
          (decoded.buffer[start + byte]! + predictor) & 255;
      }
      for (let pixel = 0; pixel < width; pixel++) {
        const bit = pixel * depth,
          value =
            (decoded.buffer[start + 1 + Math.floor(bit / 8)]! >>
              (8 - depth - (bit % 8))) &
            ((1 << depth) - 1);
        if (value >= paletteEntries) throw invalid();
      }
    }
  } catch {
    throw invalid();
  }
  return { bytes: Buffer.concat(kept), width, height };
}
