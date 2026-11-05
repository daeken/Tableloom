import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { sanitizePng } from "./png.js";
import {
  pngFixture,
  pngChunk,
  pngSignature,
  indexedMapFixture,
} from "./png-fixture.js";
const palette = (entries = 3) =>
  pngChunk(
    "PLTE",
    Buffer.from(Array.from({ length: entries * 3 }, (_, i) => (i * 29) % 256)),
  );
const transparency = (...values: number[]) =>
  pngChunk("tRNS", Buffer.from(values));
const indexed = (
  depth: number,
  width: number,
  raw: number[],
  extra = palette(depth === 1 ? 2 : 3),
) =>
  pngFixture(width, raw.length / (Math.ceil((width * depth) / 8) + 1), {
    color: 3,
    depth,
    raw: Buffer.from(raw),
    extra,
  });

test("indexed/grayscale packed depths and grayscale-alpha preserve exact image/transparency data while stripping metadata", () => {
  for (const [depth, width, row] of [
    [1, 17, [0, 0x55, 0x55, 0x7f]],
    [2, 5, [0, 0x18, 0xbf]],
    [4, 3, [0, 0x01, 0x2f]],
    [8, 3, [0, 0, 1, 2]],
  ] as const) {
    const colors = depth === 1 ? 2 : 3;
    for (const color of [0, 3]) {
      const extra = Buffer.concat([
        ...(color === 3 ? [palette(colors)] : []),
        color === 3 ? transparency(0) : transparency(0, 1),
      ]);
      const clean = pngFixture(width, 1, {
        color,
        depth,
        raw: Buffer.from(row),
        extra,
      });
      const withNotes = pngFixture(width, 1, {
        color,
        depth,
        raw: Buffer.from(row),
        extra: Buffer.concat([
          extra,
          pngChunk("tEXt", Buffer.from("GM\0Private notes")),
        ]),
      });
      assert.deepEqual(sanitizePng(withNotes), {
        width,
        height: 1,
        bytes: clean,
      });
    }
  }
  const alpha = pngFixture(3, 1, {
    color: 4,
    raw: Buffer.from([0, 0, 0, 128, 128, 255, 255]),
  });
  assert.deepEqual(sanitizePng(alpha).bytes, alpha);
  const rgb = pngFixture(1, 1, {
    color: 2,
    raw: Buffer.from([0, 20, 40, 60]),
    extra: transparency(0, 20, 0, 40, 0, 60),
  });
  assert.deepEqual(sanitizePng(rgb).bytes, rgb);
  const map = indexedMapFixture();
  assert.deepEqual(sanitizePng(map), { width: 320, height: 240, bytes: map });
  // Suggested truecolor palettes are not needed to decode the image.
  const suggested = pngFixture(1, 1, { color: 2, extra: palette() });
  assert.deepEqual(
    sanitizePng(suggested).bytes,
    pngFixture(1, 1, { color: 2 }),
  );
});

test("all indexed PNG filters reconstruct palette indices before range checks, including previous rows, wraparound, packed samples and unused padding", () => {
  // Independently specified encodings of rows [0,1,2] and [2,1,0].
  const rows = [
    [0, 0, 1, 2, 0, 2, 1, 0],
    [1, 0, 1, 1, 1, 2, 255, 255],
    [2, 0, 1, 2, 2, 2, 0, 254],
    [3, 0, 1, 2, 3, 2, 0, 255],
    [4, 0, 1, 1, 4, 2, 255, 254],
  ];
  // Final decoded sample becomes 3, which the three-entry palette cannot supply.
  const badLast = [3, 2, 1, 2, 1];
  for (let filter = 0; filter <= 4; filter++) {
    const valid = indexed(8, 3, rows[filter]!);
    assert.deepEqual(sanitizePng(valid).bytes, valid);
    const bad = [...rows[filter]!];
    bad[7] = badLast[filter]!;
    assert.throws(() => sanitizePng(indexed(8, 3, bad)));
  }
  // The second Sub-filtered packed byte must be unfiltered before indexing.
  const packed = indexed(4, 3, [1, 0x01, 0x2e]);
  assert.equal(sanitizePng(packed).width, 3);
  assert.throws(() => sanitizePng(indexed(4, 3, [1, 0x01, 0x3e])));
  // Unused low bits may contain values outside the palette; actual pixels may not.
  assert.equal(sanitizePng(indexed(2, 5, [0, 0x18, 0xbf])).width, 5);
  assert.throws(() => sanitizePng(indexed(2, 5, [0, 0x18, 0xff])));
  assert.throws(() => sanitizePng(indexed(1, 1, [0, 0x80], palette(1))));
});

test("palette/transparency cardinality, ordering, color modes and sample values reject malformed or unsupported inputs", () => {
  const valid = indexed(8, 1, [0, 0]);
  const afterData = (chunk: Buffer) =>
    Buffer.concat([valid.subarray(0, -12), chunk, valid.subarray(-12)]);
  for (const input of [
    indexed(8, 1, [0, 0], Buffer.alloc(0)),
    indexed(1, 1, [0, 0], palette(3)),
    indexed(8, 1, [0, 0], palette(257)),
    indexed(8, 1, [0, 0], pngChunk("PLTE", Buffer.alloc(0))),
    indexed(8, 1, [0, 0], pngChunk("PLTE", Buffer.alloc(4))),
    indexed(8, 1, [0, 0], Buffer.concat([palette(), palette()])),
    indexed(8, 1, [0, 0], Buffer.concat([transparency(0), palette()])),
    indexed(8, 1, [0, 0], Buffer.concat([palette(), transparency()])),
    indexed(8, 1, [0, 0], Buffer.concat([palette(), transparency(0, 1, 2, 3)])),
    indexed(
      8,
      1,
      [0, 0],
      Buffer.concat([palette(), transparency(0), transparency(0)]),
    ),
    afterData(palette()),
    afterData(transparency(0)),
    ...[0, 4].map((color) =>
      pngFixture(1, 1, {
        color,
        raw: Buffer.alloc(color === 0 ? 2 : 3),
        extra: palette(),
      }),
    ),
    ...[4, 6].map((color) =>
      pngFixture(1, 1, { color, extra: transparency(0, 0) }),
    ),
    pngFixture(1, 1, {
      color: 0,
      depth: 2,
      raw: Buffer.from([0, 0]),
      extra: transparency(0, 4),
    }),
    pngFixture(1, 1, {
      color: 0,
      raw: Buffer.from([0, 0]),
      extra: transparency(1, 0),
    }),
    pngFixture(1, 1, {
      color: 0,
      raw: Buffer.from([0, 0]),
      extra: transparency(0),
    }),
    pngFixture(1, 1, { color: 2, extra: transparency(0, 0, 0, 0, 1, 0) }),
    pngFixture(1, 1, {
      color: 2,
      extra: Buffer.concat([transparency(0, 0, 0, 0, 0, 0), palette()]),
    }),
    ...[0, 2, 4, 6].map((color) => pngFixture(1, 1, { color, depth: 16 })),
    ...[0, 3, 4].map((color) => pngFixture(1, 1, { color, depth: 3 })),
    ...[2, 4, 6].map((color) => pngFixture(1, 1, { color, depth: 4 })),
    indexed(8, 1, [5, 0]),
    pngFixture(1, 1, { color: 3, interlace: 1, extra: palette() }),
  ])
    assert.throws(() => sanitizePng(input));
});

test("packed PNG scanline sizing, exact inflate/consumed input, chunk CRCs and shared image limits remain bounded", () => {
  const base = pngFixture(1, 1),
    header = Buffer.from(base.subarray(16, 29));
  header[8] = 1;
  header[9] = 0;
  for (const [width, height] of [
    [0, 1],
    [8193, 1],
    [8192, 8192],
  ]) {
    header.writeUInt32BE(width!);
    header.writeUInt32BE(height!, 4);
    assert.throws(() =>
      sanitizePng(
        Buffer.concat([
          pngSignature,
          pngChunk("IHDR", header),
          base.subarray(33),
        ]),
      ),
    );
  }
  for (const raw of [
    Buffer.alloc(1),
    Buffer.alloc(3),
    Buffer.alloc(1024 * 1024),
  ])
    assert.throws(() =>
      sanitizePng(pngFixture(1, 1, { color: 0, depth: 1, raw })),
    );
  assert.throws(() =>
    sanitizePng(
      pngFixture(1, 1, {
        color: 0,
        depth: 1,
        packed: Buffer.concat([
          deflateSync(Buffer.alloc(2)),
          Buffer.from("tail"),
        ]),
      }),
    ),
  );
  const large = pngFixture(8192, 2048, {
    color: 0,
    depth: 1,
    raw: Buffer.alloc(1025 * 2048),
  });
  assert.equal(sanitizePng(large).height, 2048); // exact 16-Mpixel cap, with compact scanlines
  const corrupt = Buffer.from(indexedMapFixture());
  corrupt[40] = corrupt[40]! ^ 1;
  assert.throws(() => sanitizePng(corrupt));
});
