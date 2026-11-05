import { crc32, deflateSync } from "node:zlib";
import { decode } from "jpeg-js";
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_DIMENSION,
  MAX_ASSET_PIXELS,
} from "@tableloom/core/assets";
import { StoreError } from "./store.js";
const invalid = () =>
  new StoreError(
    "Upload a valid 8-bit grayscale or RGB/YCbCr JPEG within the image limits. CMYK, arithmetic and lossless JPEG are unsupported.",
    400,
  );
const MAX_MARKERS = 2048,
  MAX_SCANS = 64,
  MAX_DECODER_MIB = 128;
function exifOrientation(body: Buffer) {
  const tiff = body.subarray(6);
  if (tiff.length < 8) throw invalid();
  const order = tiff.subarray(0, 2).equals(Buffer.from("II"))
    ? "II"
    : tiff.subarray(0, 2).equals(Buffer.from("MM"))
      ? "MM"
      : null;
  if (order === null) throw invalid();
  const short = (offset: number) =>
      order === "II" ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset),
    long = (offset: number) =>
      order === "II" ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  if (short(2) !== 42) throw invalid();
  const offset = long(4);
  if (offset < 8 || offset + 2 > tiff.length) throw invalid();
  const count = short(offset);
  if (count > 256 || offset + 2 + count * 12 + 4 > tiff.length) throw invalid();
  let orientation: number | undefined;
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (short(entry) !== 0x112) continue;
    if (
      orientation !== undefined ||
      short(entry + 2) !== 3 ||
      long(entry + 4) !== 1
    )
      throw invalid();
    orientation = short(entry + 8);
    if (orientation < 1 || orientation > 8) throw invalid();
  }
  // Other directories, thumbnails, text and GPS metadata are never followed or copied.
  return orientation ?? 1;
}
/** Bounded framing/table/scan checks precede allocations in the pinned decoder.
 * JPEG syntax: ITU T.81; orientation: CIPA DC-008 §4.6.4 (IFD0 Orientation).
 */
function preflight(input: Buffer) {
  if (
    input.length > MAX_ASSET_BYTES ||
    input.length < 4 ||
    input.readUInt16BE(0) !== 0xffd8
  )
    throw invalid();
  let offset = 2,
    markers = 0,
    scans = 0,
    width = 0,
    height = 0,
    kind = 0,
    orientation = 1,
    exif = false,
    adobe: number | undefined,
    jfif = false,
    ended = false;
  const components = new Map<
      number,
      { quant: number; coefficients: number[] }
    >(),
    quantization = new Set<number>(),
    huffman = new Set<number>();
  while (offset < input.length) {
    if (++markers > MAX_MARKERS || input[offset++] !== 0xff) throw invalid();
    while (input[offset] === 0xff) offset++;
    const marker = input[offset++];
    if (marker === 0xd9) {
      if (
        offset !== input.length ||
        !scans ||
        !components.size ||
        [...components.values()].some((c) => c.coefficients[0] === -1)
      )
        throw invalid();
      ended = true;
      break;
    }
    if (
      marker === undefined ||
      !(
        [0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd, 0xda, 0xfe].includes(marker) ||
        (marker >= 0xe0 && marker <= 0xef)
      ) ||
      offset + 2 > input.length
    )
      throw invalid();
    const length = input.readUInt16BE(offset),
      end = offset + length;
    if (length < 2 || end > input.length) throw invalid();
    const body = input.subarray(offset + 2, end);
    offset = end;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (kind || body.length < 6 || body[0] !== 8) throw invalid();
      height = body.readUInt16BE(1);
      width = body.readUInt16BE(3);
      kind = marker;
      const count = body[5]!;
      if (
        !width ||
        !height ||
        width > MAX_ASSET_DIMENSION ||
        height > MAX_ASSET_DIMENSION ||
        width * height > MAX_ASSET_PIXELS ||
        ![1, 3].includes(count) ||
        body.length !== 6 + count * 3
      )
        throw invalid();
      let blocks = 0;
      for (let i = 0; i < count; i++) {
        const id = body[6 + i * 3]!,
          sampling = body[7 + i * 3]!,
          quant = body[8 + i * 3]!,
          h = sampling >> 4,
          v = sampling & 15;
        if (components.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || quant > 3)
          throw invalid();
        blocks += h * v;
        components.set(id, { quant, coefficients: Array<number>(64).fill(-1) });
      }
      if (blocks > 10) throw invalid();
    } else if (marker === 0xdb) {
      let i = 0;
      while (i < body.length) {
        const info = body[i++]!,
          precision = info >> 4,
          id = info & 15,
          bytes = precision === 0 ? 1 : 2;
        if (precision > 1 || id > 3 || i + 64 * bytes > body.length)
          throw invalid();
        for (let j = 0; j < 64; j++)
          if ((bytes === 1 ? body[i + j] : body.readUInt16BE(i + j * 2)) === 0)
            throw invalid();
        quantization.add(id);
        i += 64 * bytes;
      }
      if (!i) throw invalid();
    } else if (marker === 0xc4) {
      let i = 0;
      while (i < body.length) {
        const info = body[i++]!;
        if (info >> 4 > 1 || (info & 15) > 3 || i + 16 > body.length)
          throw invalid();
        let count = 0,
          slots = 1;
        for (let j = 0; j < 16; j++) {
          const n = body[i + j]!;
          slots = slots * 2 - n;
          count += n;
          if (slots < 0) throw invalid();
        }
        i += 16;
        if (!count || count > 256 || i + count > body.length) throw invalid();
        for (let j = 0; j < count; j++) {
          const value = body[i + j]!;
          if (info >> 4 === 0 ? value > 11 : (value & 15) > 10) throw invalid();
        }
        huffman.add(info);
        i += count;
      }
      if (!i) throw invalid();
    } else if (marker === 0xdd) {
      if (body.length !== 2) throw invalid();
    } else if (
      marker === 0xe1 &&
      body.subarray(0, 4).equals(Buffer.from("Exif"))
    ) {
      if (!body.subarray(0, 6).equals(Buffer.from("Exif\0\0")) || exif)
        throw invalid();
      exif = true;
      orientation = exifOrientation(body);
    } else if (
      marker === 0xee &&
      body.subarray(0, 5).equals(Buffer.from("Adobe"))
    ) {
      if (
        adobe !== undefined ||
        body.length !== 12 ||
        ![0, 1].includes(body[11]!)
      )
        throw invalid();
      adobe = body[11]!;
    } else if (
      marker === 0xe0 &&
      body.subarray(0, 5).equals(Buffer.from("JFIF\0"))
    ) {
      if (
        jfif ||
        body.length < 14 ||
        body.length !== 14 + 3 * body[12]! * body[13]!
      )
        throw invalid();
      jfif = true;
    } else if (marker === 0xda) {
      if (!kind || ++scans > MAX_SCANS || body.length < 4) throw invalid();
      const count = body[0]!;
      if (!count || count > components.size || body.length !== 4 + count * 2)
        throw invalid();
      const ss = body[1 + count * 2]!,
        se = body[2 + count * 2]!,
        successive = body[3 + count * 2]!,
        ah = successive >> 4,
        al = successive & 15;
      if (
        kind === 0xc2
          ? ss > se ||
            se > 63 ||
            (ss === 0 ? se !== 0 : count !== 1) ||
            ah > 13 ||
            al > 13 ||
            (ah !== 0 && al !== ah - 1)
          : ss !== 0 || se !== 63 || successive !== 0
      )
        throw invalid();
      const selected = new Set<number>();
      for (let i = 0; i < count; i++) {
        const id = body[1 + i * 2]!,
          tables = body[2 + i * 2]!,
          component = components.get(id);
        if (
          !component ||
          selected.has(id) ||
          tables >> 4 > 3 ||
          (tables & 15) > 3 ||
          !quantization.has(component.quant)
        )
          throw invalid();
        if (
          (kind !== 0xc2 || (ss === 0 && ah === 0)) &&
          !huffman.has(tables >> 4)
        )
          throw invalid();
        if ((kind !== 0xc2 || ss > 0) && !huffman.has(16 + (tables & 15)))
          throw invalid();
        selected.add(id);
        for (let coefficient = ss; coefficient <= se; coefficient++) {
          if (
            ah === 0
              ? component.coefficients[coefficient] !== -1
              : component.coefficients[coefficient] !== ah
          )
            throw invalid();
          component.coefficients[coefficient] = al;
        }
      }
      const start = offset;
      // Entropy bytes are bounded by the upload. FF00 is stuffing; RST markers stay inside a scan.
      while (offset < input.length) {
        if (input[offset] !== 0xff) {
          offset++;
          continue;
        }
        if (input[offset + 1] === 0) {
          offset += 2;
          continue;
        }
        let next = offset + 1;
        while (input[next] === 0xff) next++;
        const code = input[next];
        if (code !== undefined && code >= 0xd0 && code <= 0xd7) {
          offset = next + 1;
          continue;
        }
        break;
      }
      if (offset === start || offset >= input.length) throw invalid();
    }
  }
  if (!ended || (jfif && adobe === 0)) throw invalid();
  const rgb = [...components.keys()].join(",") === "82,71,66";
  return {
    width,
    height,
    orientation,
    colorTransform: adobe === undefined ? jfif || !rgb : adobe === 1,
  };
}
function chunk(type: string, data: Buffer) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
/** Convert decoded pixels to opaque, metadata-free PNG, applying EXIF orientation exactly once. */
export function sanitizeJpeg(input: Buffer) {
  try {
    const header = preflight(input),
      image = decode(input, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: false,
        maxResolutionInMP: MAX_ASSET_PIXELS / 1_000_000,
        maxMemoryUsageInMB: MAX_DECODER_MIB,
        colorTransform: header.colorTransform,
      });
    if (
      image.width !== header.width ||
      image.height !== header.height ||
      image.data.length !== image.width * image.height * 4
    )
      throw invalid();
    const swapped = header.orientation >= 5,
      width = swapped ? image.height : image.width,
      height = swapped ? image.width : image.height,
      stride = width * 3 + 1,
      raw = Buffer.alloc(stride * height);
    const previous = [0, 0, 0];
    for (let y = 0; y < height; y++) {
      raw[y * stride] = 1; // Sub-filter RGB samples to keep normalized photo storage compact.
      for (let x = 0; x < width; x++) {
        let sx = x,
          sy = y;
        switch (header.orientation) {
          case 2:
            sx = image.width - 1 - x;
            break;
          case 3:
            sx = image.width - 1 - x;
            sy = image.height - 1 - y;
            break;
          case 4:
            sy = image.height - 1 - y;
            break;
          case 5:
            sx = y;
            sy = x;
            break;
          case 6:
            sx = y;
            sy = image.height - 1 - x;
            break;
          case 7:
            sx = image.width - 1 - y;
            sy = image.height - 1 - x;
            break;
          case 8:
            sx = image.width - 1 - y;
            sy = x;
            break;
        }
        const source = (sy * image.width + sx) * 4,
          target = y * stride + 1 + x * 3;
        for (let c = 0; c < 3; c++) {
          // Read the previous reconstructed output byte from a small running RGB cache.
          raw[target + c] = image.data[source + c]!;
          if (x > 0) raw[target + c] = (raw[target + c]! - previous[c]!) & 255;
          previous[c] = image.data[source + c]!;
        }
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const packed = deflateSync(raw, { maxOutputLength: MAX_ASSET_BYTES - 57 }),
      bytes = Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", ihdr),
        chunk("IDAT", packed),
        chunk("IEND", Buffer.alloc(0)),
      ]);
    if (bytes.length > MAX_ASSET_BYTES) throw invalid();
    return { bytes, width, height };
  } catch (error) {
    if (error instanceof Error && error.message.includes("maxMemoryUsageInMB"))
      throw new StoreError(
        "This JPEG needs too much decoder memory. Reduce its dimensions and try again.",
        400,
      );
    if (
      error instanceof Error &&
      /maxOutputLength|larger than/.test(error.message)
    )
      throw new StoreError(
        "This JPEG becomes larger than 5 MiB when normalized. Reduce its dimensions and try again.",
        400,
      );
    throw invalid();
  }
}
