import { crc32, deflateSync } from "node:zlib";
export const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function pngChunk(kind: string, data: Buffer) {
  const type = Buffer.from(kind),
    header = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, crc]);
}
export function pngFixture(
  width = 32,
  height = 24,
  options: {
    depth?: number;
    color?: number;
    interlace?: number;
    extra?: Buffer;
    raw?: Buffer;
    packed?: Buffer;
  } = {},
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = options.depth ?? 8;
  header[9] = options.color ?? 6;
  header[12] = options.interlace ?? 0;
  const channels = header[9] === 2 ? 3 : 4;
  const raw = options.raw ?? Buffer.alloc((width * channels + 1) * height);
  if (!options.raw)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const offset = y * (width * channels + 1) + 1 + x * channels,
          wall = x === 4 || x === width - 5 || y === 4 || y === height - 5;
        raw[offset] = wall ? 64 : 234;
        raw[offset + 1] = wall ? 95 : 231;
        raw[offset + 2] = wall ? 77 : 221;
        if (channels === 4) raw[offset + 3] = 255;
      }
  return Buffer.concat([
    pngSignature,
    pngChunk("IHDR", header),
    options.extra ?? Buffer.alloc(0),
    pngChunk("IDAT", options.packed ?? deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** Synthetic packed-index courtyard, with transparent exterior and an implicit opaque final palette entry. */
export function indexedMapFixture(width = 320, height = 240) {
  const rowBytes = Math.ceil(width / 4),
    raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const inside = x >= 20 && x < width - 20 && y >= 20 && y < height - 20,
        wall =
          inside && (x < 24 || x >= width - 24 || y < 24 || y >= height - 24),
        index = wall ? 2 : inside ? 1 : 0;
      raw[y * (rowBytes + 1) + 1 + Math.floor(x / 4)]! |=
        index << (6 - (x % 4) * 2);
    }
  return pngFixture(width, height, {
    color: 3,
    depth: 2,
    raw,
    extra: Buffer.concat([
      pngChunk("PLTE", Buffer.from([0, 0, 0, 218, 224, 206, 64, 95, 77])),
      pngChunk("tRNS", Buffer.from([0, 255])),
    ]),
  });
}
