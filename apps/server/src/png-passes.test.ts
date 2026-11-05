import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import { MAX_PNG_INFLATE_BYTES } from "@tableloom/core/assets";
import { sanitizePng } from "./png.js";
import { pngFixture, pngChunk, pngSignature } from "./png-fixture.js";
import {
  pngPassFixture,
  advancedMapFixture,
  indexedPassFixture,
} from "./png-pass-fixture.js";
function replaceRaw(input: Buffer, update: (raw: Buffer) => Buffer) {
  let offset = 8;
  const before: Buffer[] = [pngSignature],
    compressed: Buffer[] = [];
  while (offset < input.length) {
    const length = input.readUInt32BE(offset),
      kind = input.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT")
      compressed.push(input.subarray(offset + 8, offset + 8 + length));
    else if (kind !== "IEND")
      before.push(input.subarray(offset, offset + 12 + length));
    offset += 12 + length;
  }
  return Buffer.concat([
    ...before,
    pngChunk(
      "IDAT",
      deflateSync(update(inflateSync(Buffer.concat(compressed)))),
    ),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
test("16-bit grayscale/RGB/alpha and all legal Adam7 modes retain exact sample, alpha, transparency and compressed data", () => {
  for (const color of [0, 2, 4, 6])
    for (const interlace of [0, 1]) {
      const extra =
          color === 0
            ? pngChunk("tRNS", Buffer.from([0x12, 0x34]))
            : color === 2
              ? pngChunk(
                  "tRNS",
                  Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]),
                )
              : Buffer.alloc(0),
        plain = pngPassFixture({
          color,
          interlace,
          depth: 16,
          extra,
          filter: (p, r) => (p + r) % 5,
        }),
        noted = Buffer.concat([
          plain.subarray(0, 33),
          pngChunk("tEXt", Buffer.from("GM\0Private high precision notes")),
          plain.subarray(33),
        ]);
      assert.deepEqual(sanitizePng(noted), {
        width: 17,
        height: 13,
        bytes: plain,
      });
      assert.equal(plain[24], 16);
      assert.equal(plain[28], interlace);
    }
  for (const depth of [1, 2, 4, 8]) {
    const indexed = indexedPassFixture(17, 13, depth);
    assert.deepEqual(sanitizePng(indexed).bytes, indexed);
    const gray = pngPassFixture({
      color: 0,
      depth,
      interlace: 1,
      filter: (p, r) => (p + r) % 5,
    });
    assert.deepEqual(sanitizePng(gray).bytes, gray);
  }
  for (const color of [2, 4, 6]) {
    const input = pngPassFixture({
      color,
      depth: 8,
      interlace: 1,
      filter: (p, r) => (p + r) % 5,
    });
    assert.deepEqual(sanitizePng(input).bytes, input);
  }
  assert.deepEqual(
    sanitizePng(advancedMapFixture()).bytes,
    advancedMapFixture(),
  );
});
test("tiny/odd Adam7 dimensions skip empty passes exactly; no nonexistent pass filter bytes are accepted", () => {
  for (let width = 1; width <= 9; width++)
    for (let height = 1; height <= 9; height++) {
      const input = indexedPassFixture(width, height, 2);
      assert.deepEqual(sanitizePng(input), { width, height, bytes: input });
    }
  const one = pngFixture(1, 1, {
    color: 0,
    depth: 16,
    interlace: 1,
    raw: Buffer.from([0, 0x12, 0x34]),
  });
  assert.equal(sanitizePng(one).width, 1);
  assert.throws(() =>
    sanitizePng(
      replaceRaw(one, (raw) => Buffer.concat([raw, Buffer.from([0])])),
    ),
  );
  assert.throws(() =>
    sanitizePng(replaceRaw(one, (raw) => raw.subarray(0, -1))),
  );
});
test("Adam7 indexed filtering resets previous rows at each pass and validates late-pass indices, padding and filter bytes", () => {
  // Independently specified 9×9 indexed pass dimensions; each first Up row decodes to 2.
  const sizes = [
      [2, 2],
      [1, 2],
      [3, 1],
      [2, 3],
      [5, 2],
      [4, 5],
      [9, 4],
    ],
    rows: Buffer[] = [];
  for (const [width, height] of sizes)
    for (let row = 0; row < height!; row++)
      rows.push(
        Buffer.from([2, ...Array<number>(width!).fill(row === 0 ? 2 : 0)]),
      );
  const raw = Buffer.concat(rows);
  assert.equal(raw.length, 100);
  const palette = pngChunk(
      "PLTE",
      Buffer.from([0, 0, 0, 255, 255, 255, 64, 95, 77]),
    ),
    input = pngFixture(9, 9, {
      color: 3,
      depth: 8,
      interlace: 1,
      raw,
      extra: palette,
    });
  assert.deepEqual(sanitizePng(input).bytes, input);
  assert.throws(() =>
    sanitizePng(
      replaceRaw(input, (b) => {
        b[b.length - 1] = 1;
        return b;
      }),
    ),
  ); // final pass decoded index 3
  assert.throws(() =>
    sanitizePng(
      replaceRaw(input, (b) => {
        b[90] = 5;
        return b;
      }),
    ),
  ); // final pass filter
  // One real 2-bit index plus six ignored padding bits in the only nonempty pass.
  const padded = pngFixture(1, 1, {
    color: 3,
    depth: 2,
    interlace: 1,
    raw: Buffer.from([0, 0xbf]),
    extra: palette,
  });
  assert.equal(sanitizePng(padded).width, 1);
  assert.throws(() =>
    sanitizePng(
      replaceRaw(padded, (b) => {
        b[1] = 0xff;
        return b;
      }),
    ),
  );
});
test("PNG inflate budget is fixed before inflation for deep/interlaced images, preserving the old RGBA8 maximum", () => {
  assert.equal(MAX_PNG_INFLATE_BYTES, 64 * 1024 * 1024 + 8192);
  const tiny = Buffer.alloc(2);
  for (const [width, height, color, depth, interlace] of [
    [8192, 2048, 6, 16, 0],
    [8192, 2048, 2, 16, 1],
    [2048, 8192, 6, 8, 1],
  ])
    assert.throws(
      () =>
        sanitizePng(
          pngFixture(width!, height!, {
            color: color!,
            depth: depth!,
            interlace: interlace!,
            raw: tiny,
          }),
        ),
      /decoded scanline budget/,
    );
  // 16-Mpixel RGBA8 at the old worst-case row count still fits exactly.
  const input = pngFixture(2048, 8192, {
    raw: Buffer.alloc(MAX_PNG_INFLATE_BYTES),
  });
  assert.equal(sanitizePng(input).height, 8192);
  const valid = pngPassFixture();
  for (const update of [
    (raw: Buffer) => raw.subarray(0, -1),
    (raw: Buffer) => Buffer.concat([raw, Buffer.from([0])]),
    (raw: Buffer) => {
      raw[0] = 5;
      return raw;
    },
  ])
    assert.throws(() => sanitizePng(replaceRaw(valid, update)));
});
test("unsupported PNG depth/interlace combinations, animation, trailing zlib streams and corrupt 16-bit transparency reject", () => {
  for (const [color, depth, interlace] of [
    [3, 16, 1],
    [0, 3, 1],
    [2, 4, 1],
    [6, 8, 2],
  ])
    assert.throws(() =>
      sanitizePng(
        pngFixture(1, 1, {
          color: color!,
          depth: depth!,
          interlace: interlace!,
        }),
      ),
    );
  const rgb = pngPassFixture({
    width: 1,
    height: 1,
    color: 2,
    depth: 16,
    interlace: 1,
    sample: () => 65535,
    extra: pngChunk("tRNS", Buffer.alloc(6, 255)),
  });
  assert.deepEqual(sanitizePng(rgb).bytes, rgb);
  const alpha = pngPassFixture({
    color: 6,
    depth: 16,
    extra: pngChunk("tRNS", Buffer.alloc(6)),
  });
  assert.throws(() => sanitizePng(alpha));
  const animated = pngPassFixture({ extra: pngChunk("acTL", Buffer.alloc(8)) });
  assert.throws(() => sanitizePng(animated));
  const packed = Buffer.concat([
    deflateSync(Buffer.from([0, 0, 0])),
    deflateSync(Buffer.from([0, 0, 0])),
  ]);
  assert.throws(() =>
    sanitizePng(
      pngFixture(1, 1, { color: 0, depth: 16, interlace: 1, packed }),
    ),
  );
});
