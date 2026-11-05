import { pngFixture, pngChunk } from "./png-fixture.js";
// Independent fixture construction follows the specification's tiled pass-number image.
const tile = [
  [1, 6, 4, 6, 2, 6, 4, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
  [5, 6, 5, 6, 5, 6, 5, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
  [3, 6, 4, 6, 3, 6, 4, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
  [5, 6, 5, 6, 5, 6, 5, 6],
  [7, 7, 7, 7, 7, 7, 7, 7],
];
export function pngPassFixture({
  width = 17,
  height = 13,
  color = 6,
  depth = 16,
  interlace = 1,
  filter = () => 0,
  sample = (x, y, c) => (x * 193 + y * 521 + c * 12347) % 2 ** depth,
  extra = Buffer.alloc(0),
}: {
  width?: number;
  height?: number;
  color?: number;
  depth?: number;
  interlace?: number;
  filter?: (pass: number, row: number) => number;
  sample?: (x: number, y: number, channel: number) => number;
  extra?: Buffer;
} = {}) {
  const channels =
      color === 0 || color === 3 ? 1 : color === 2 ? 3 : color === 4 ? 2 : 4,
    bpp = Math.ceil((channels * depth) / 8),
    parts: Buffer[] = [];
  for (
    let pass = interlace === 1 ? 1 : 0;
    pass <= (interlace === 1 ? 7 : 0);
    pass++
  ) {
    let previous: Buffer | null = null,
      passRow = 0;
    for (let y = 0; y < height; y++) {
      const columns: number[] = [];
      for (let x = 0; x < width; x++)
        if (pass === 0 || tile[y % 8]![x % 8] === pass) columns.push(x);
      if (!columns.length) continue;
      const row = Buffer.alloc(
        Math.ceil((columns.length * channels * depth) / 8),
      );
      for (let i = 0; i < columns.length; i++)
        for (let c = 0; c < channels; c++) {
          const value = sample(columns[i]!, y, c),
            bit = (i * channels + c) * depth;
          if (!Number.isInteger(value) || value < 0 || value >= 2 ** depth)
            throw new Error("Invalid fixture sample");
          if (depth === 16) row.writeUInt16BE(value, bit / 8);
          else if (depth === 8) row[bit / 8] = value;
          else row[Math.floor(bit / 8)]! |= value << (8 - depth - (bit % 8));
        }
      const kind = filter(pass, passRow++),
        encoded = Buffer.alloc(row.length + 1);
      encoded[0] = kind;
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0,
          b = previous?.[i] ?? 0,
          c = i >= bpp ? (previous?.[i - bpp] ?? 0) : 0;
        const p = a + b - c,
          paeth = [a, b, c].sort(
            (one, two) => Math.abs(p - one) - Math.abs(p - two),
          )[0]!;
        const prediction = [0, a, b, Math.floor((a + b) / 2), paeth][kind] ?? 0;
        encoded[i + 1] = (row[i]! - prediction) & 255;
      }
      parts.push(encoded);
      previous = row;
    }
  }
  return pngFixture(width, height, {
    color,
    depth,
    interlace,
    raw: Buffer.concat(parts),
    extra,
  });
}
export function advancedMapFixture(width = 320, height = 240) {
  return pngPassFixture({
    width,
    height,
    color: 6,
    depth: 16,
    interlace: 1,
    filter: (pass, row) => (pass + row) % 5,
    sample: (x, y, c) => {
      const inside = x >= 20 && x < width - 20 && y >= 20 && y < height - 20,
        wall =
          inside && (x < 25 || x >= width - 25 || y < 25 || y >= height - 25);
      if (c === 3) return inside ? 65535 : 0;
      return (
        (wall ? [64, 95, 77] : [218, 224, 206])[c]! * 257 +
        (inside && !wall ? (x + y) % 17 : 0)
      );
    },
  });
}
export const indexedPassFixture = (width = 17, height = 13, depth = 2) =>
  pngPassFixture({
    width,
    height,
    color: 3,
    depth,
    interlace: 1,
    filter: (pass, row) => (pass + row) % 5,
    sample: (x, y) => (x + y) % Math.min(3, 2 ** depth),
    extra: Buffer.concat([
      pngChunk(
        "PLTE",
        Buffer.from([
          0,
          0,
          0,
          218,
          224,
          206,
          ...(depth === 1 ? [] : [64, 95, 77]),
        ]),
      ),
      pngChunk("tRNS", Buffer.from([0, 255])),
    ]),
  });
