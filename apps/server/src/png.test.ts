import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { sanitizePng } from "./png.js";
import { pngFixture, pngChunk, pngSignature } from "./png-fixture.js";

test("bounded static RGB/RGBA PNGs retain exact image chunks while ancillary text is stripped", () => {
  for (const color of [2, 6]) {
    const plain = pngFixture(32, 24, { color }),
      extra = pngChunk("tEXt", Buffer.from("Description\0Private map notes")),
      input = pngFixture(32, 24, { color, extra }),
      result = sanitizePng(input);
    assert.deepEqual(result, { bytes: plain, width: 32, height: 24 });
    assert.ok(!result.bytes.includes(Buffer.from("Private map notes")));
  }
  for (let filter = 0; filter <= 4; filter++) {
    const raw = Buffer.alloc(9);
    raw[0] = filter;
    assert.equal(sanitizePng(pngFixture(2, 1, { raw })).width, 2);
  }
});

test("PNG parser rejects signatures, CRCs, truncation, extra bytes, mode/animation/transparency and chunk-order violations", () => {
  const good = pngFixture(),
    crc = Buffer.from(good);
  crc[29] = crc[29]! ^ 1;
  const badType = Buffer.from(good);
  badType[12] = 0xc9;
  for (const input of [
    Buffer.from("<svg onload='alert(1)'/>"),
    Buffer.from("<html>"),
    good.subarray(1),
    good.subarray(0, -1),
    good.subarray(0, -12),
    Buffer.concat([good, Buffer.from("junk")]),
    crc,
    badType,
    pngFixture(2, 2, { depth: 16 }),
    pngFixture(2, 2, { color: 3 }),
    pngFixture(2, 2, { interlace: 1 }),
    ...["acTL", "fcTL", "fdAT", "tRNS", "ABCD"].map((kind) =>
      pngFixture(2, 2, { extra: pngChunk(kind, Buffer.alloc(8)) }),
    ),
    Buffer.concat([
      pngSignature,
      pngChunk("IDAT", Buffer.alloc(0)),
      good.subarray(8),
    ]),
    Buffer.concat([
      good.subarray(0, 33),
      good.subarray(8, 33),
      good.subarray(33),
    ]),
    Buffer.concat([
      good.subarray(0, -12),
      pngChunk("tEXt", Buffer.from("key\0value")),
      good.subarray(33, -12),
      good.subarray(-12),
    ]),
    pngFixture(2, 2, { extra: pngChunk("PLTE", Buffer.alloc(1)) }),
    pngFixture(2, 2, {
      extra: Buffer.concat(
        Array.from({ length: 1024 }, () =>
          pngChunk("tEXt", Buffer.from("key\0value")),
        ),
      ),
    }),
  ])
    assert.throws(() => sanitizePng(input));
});

test("PNG dimensions, pixel count, compressed input and decompressed rows stay bounded", () => {
  for (const input of [
    pngFixture(2, 1, { raw: Buffer.from([0, 1]) }),
    pngFixture(2, 1, { raw: Buffer.alloc(1000) }),
    pngFixture(2, 1, { raw: Buffer.from([5, 1, 1, 1, 1, 1, 1, 1, 1]) }),
    pngFixture(2, 1, {
      packed: Buffer.concat([
        deflateSync(Buffer.alloc(9)),
        Buffer.from("junk"),
      ]),
    }),
    pngFixture(2, 1, { packed: Buffer.from("bad zlib") }),
    Buffer.alloc(5 * 1024 * 1024 + 1),
  ])
    assert.throws(() => sanitizePng(input));
  const good = pngFixture(1, 1),
    header = Buffer.from(good.subarray(16, 29));
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
          good.subarray(33),
        ]),
      ),
    );
  }
});
