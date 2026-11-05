import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { randomFillSync } from "node:crypto";
import { encode, decode } from "jpeg-js";
import { sanitizeJpeg } from "./jpeg.js";
import { sanitizePng } from "./png.js";
import {
  jpegFixture,
  jpegSegment,
  orientationSegment,
  progressiveJpegFixture,
  grayscaleJpegFixture,
} from "./jpeg-fixture.js";
function pngPixels(png: Buffer) {
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20),
    parts: Buffer[] = [];
  for (let i = 8; i < png.length;) {
    const length = png.readUInt32BE(i);
    if (png.toString("ascii", i + 4, i + 8) === "IDAT")
      parts.push(png.subarray(i + 8, i + 8 + length));
    i += length + 12;
  }
  const raw = inflateSync(Buffer.concat(parts)),
    pixels: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(
      y * (width * 3 + 1) + 1,
      (y + 1) * (width * 3 + 1),
    );
    assert.equal(raw[y * (width * 3 + 1)], 1);
    for (let i = 3; i < row.length; i++) row[i] = (row[i]! + row[i - 3]!) & 255;
    for (let x = 0; x < width; x++)
      pixels.push([...row.subarray(x * 3, x * 3 + 3)]);
  }
  return { width, height, pixels };
}
function replaceSegment(
  input: Buffer,
  marker: number,
  update: (body: Buffer) => Buffer,
) {
  let offset = 2;
  while (offset < input.length) {
    const kind = input[offset + 1]!,
      length = input.readUInt16BE(offset + 2);
    if (kind === marker)
      return Buffer.concat([
        input.subarray(0, offset),
        jpegSegment(
          marker,
          update(Buffer.from(input.subarray(offset + 4, offset + 2 + length))),
        ),
        input.subarray(offset + 2 + length),
      ]);
    offset += length + 2;
  }
  throw new Error("Missing fixture marker");
}
test("baseline/progressive/grayscale JPEGs normalize to bounded metadata-free PNG with exact decoded RGB samples", () => {
  for (const input of [
    jpegFixture(24, 16),
    progressiveJpegFixture(),
    grayscaleJpegFixture(),
  ]) {
    const result = sanitizeJpeg(input),
      expected = decode(input, { useTArray: true }),
      actual = pngPixels(result.bytes);
    assert.equal(result.width, expected.width);
    assert.equal(result.height, expected.height);
    assert.deepEqual(
      actual.pixels,
      Array.from({ length: expected.width * expected.height }, (_, i) => [
        ...expected.data.subarray(i * 4, i * 4 + 3),
      ]),
    );
    assert.deepEqual(sanitizePng(result.bytes), result);
    for (const secret of [
      "Exif",
      "Synthetic private GPS",
      "ICC_PROFILE",
      "Comment",
    ])
      assert.ok(!result.bytes.includes(Buffer.from(secret)));
  }
  // Explicit Adobe RGB is interpreted without a YCbCr transform; discard conflicting JFIF metadata.
  const noJfif = replaceSegment(jpegFixture(24, 16), 0xe0, () =>
      Buffer.alloc(0),
    ),
    adobe = jpegSegment(
      0xee,
      Buffer.concat([
        Buffer.from("Adobe"),
        Buffer.from([0, 100, 0, 0, 0, 0, 0]),
      ]),
    ),
    rgb = Buffer.concat([noJfif.subarray(0, 2), adobe, noJfif.subarray(2)]),
    rgbDecoded = decode(rgb, { useTArray: true, colorTransform: false });
  assert.deepEqual(
    pngPixels(sanitizeJpeg(rgb).bytes).pixels,
    Array.from({ length: 24 * 16 }, (_, i) => [
      ...rgbDecoded.data.subarray(i * 4, i * 4 + 3),
    ]),
  );
  const source = jpegFixture(24, 16),
    metadata = Buffer.concat([
      source.subarray(0, 2),
      jpegSegment(0xe2, Buffer.from("ICC_PROFILE\0Private profile")),
      jpegSegment(0xfe, Buffer.from("Comment private notes")),
      source.subarray(2),
    ]);
  assert.deepEqual(sanitizeJpeg(metadata), sanitizeJpeg(source));
});
test("EXIF orientations 1–8 in both byte orders apply exact rotations/reflections once, including swapped dimensions", () => {
  const source = Buffer.from(
      encode(
        {
          width: 3,
          height: 2,
          data: Buffer.from([
            230, 20, 20, 255, 20, 230, 20, 255, 20, 20, 230, 255, 20, 230, 230,
            255, 230, 20, 230, 255, 230, 230, 20, 255,
          ]),
        },
        100,
      ).data,
    ),
    decoded = decode(source, { useTArray: true }),
    original = Array.from({ length: 6 }, (_, i) => [
      ...decoded.data.subarray(i * 4, i * 4 + 3),
    ]),
    orders = [
      [0, 1, 2, 3, 4, 5],
      [2, 1, 0, 5, 4, 3],
      [5, 4, 3, 2, 1, 0],
      [3, 4, 5, 0, 1, 2],
      [0, 3, 1, 4, 2, 5],
      [3, 0, 4, 1, 5, 2],
      [5, 2, 4, 1, 3, 0],
      [2, 5, 1, 4, 0, 3],
    ];
  for (let orientation = 1; orientation <= 8; orientation++)
    for (const little of [false, true]) {
      const input = Buffer.concat([
          source.subarray(0, 2),
          orientationSegment(orientation, little),
          source.subarray(2),
        ]),
        result = sanitizeJpeg(input),
        pixels = pngPixels(result.bytes);
      assert.deepEqual(
        pixels.pixels,
        orders[orientation - 1]!.map((i) => original[i]),
      );
      assert.equal(result.width, orientation >= 5 ? 2 : 3);
      assert.equal(result.height, orientation >= 5 ? 3 : 2);
    }
});
test("JPEG framing, tables, scans, dimensions, sample/component modes, metadata and compressed input are checked before normalization", () => {
  const valid = jpegFixture(24, 16),
    withHeader = (fn: (body: Buffer) => Buffer) =>
      replaceSegment(valid, 0xc0, fn);
  const malformed = [
    Buffer.from("<svg/>"),
    valid.subarray(1),
    valid.subarray(0, -1),
    Buffer.concat([valid, Buffer.from("tail")]),
    Buffer.alloc(5 * 1024 * 1024 + 1),
    Buffer.concat([
      valid.subarray(0, 2),
      Buffer.from([255, 216]),
      valid.subarray(2),
    ]),
    replaceSegment(valid, 0xe1, (b) => {
      b[6] = 0xc9;
      b[7] = 0xc9;
      return b;
    }),
    replaceSegment(valid, 0xe1, (b) => {
      b[5] = 1;
      return b;
    }),
    replaceSegment(valid, 0xe1, (b) => {
      b.writeUInt16LE(9, 24);
      return b;
    }),
    replaceSegment(valid, 0xe1, (b) => {
      b.writeUInt32LE(0xfffffff0, 10);
      return b;
    }),
    withHeader((b) => {
      b[0] = 12;
      return b;
    }),
    withHeader((b) => {
      b[5] = 4;
      return b;
    }),
    withHeader((b) => {
      b[7] = 0x51;
      return b;
    }),
    withHeader((b) => {
      b[9] = b[6]!;
      return b;
    }),
    withHeader((b) => {
      b.writeUInt16BE(8193, 3);
      return b;
    }),
    withHeader((b) => {
      b.writeUInt16BE(8192, 3);
      b.writeUInt16BE(8192, 1);
      return b;
    }),
    withHeader((b) => {
      b.writeUInt16BE(0, 3);
      return b;
    }),
    replaceSegment(valid, 0xdb, (b) => {
      b[1] = 0;
      return b;
    }),
    replaceSegment(valid, 0xc4, (b) => {
      b[1] = 255;
      return b;
    }),
    replaceSegment(valid, 0xda, (b) => {
      b[1] = 99;
      return b;
    }),
    replaceSegment(valid, 0xda, (b) => {
      b[b.length - 2] = 1;
      return b;
    }),
    Buffer.concat([
      valid.subarray(0, 2),
      orientationSegment(9),
      valid.subarray(2),
    ]), // duplicate EXIF / invalid orientation
    Buffer.concat([
      valid.subarray(0, 2),
      jpegSegment(0xe1, Buffer.from("Exif\0\0bad")),
      valid.subarray(2),
    ]),
    Buffer.concat([
      valid.subarray(0, 2),
      jpegSegment(
        0xee,
        Buffer.concat([
          Buffer.from("Adobe"),
          Buffer.alloc(6),
          Buffer.from([2]),
        ]),
      ),
      valid.subarray(2),
    ]),
    Buffer.concat([
      valid.subarray(0, 2),
      ...Array.from({ length: 2048 }, () => jpegSegment(0xfe, Buffer.alloc(0))),
      valid.subarray(2),
    ]),
  ];
  for (const input of malformed) assert.throws(() => sanitizeJpeg(input));
  // Truncate entropy but preserve EOI: the decoder must still reject incomplete data.
  const scan = valid.indexOf(Buffer.from([255, 218])),
    entropy = scan + 2 + valid.readUInt16BE(scan + 2);
  assert.throws(() =>
    sanitizeJpeg(
      Buffer.concat([valid.subarray(0, entropy + 1), Buffer.from([255, 217])]),
    ),
  );
});
test("normalization rejects JPEGs whose lossless PNG exceeds the independent stored-byte cap", () => {
  const width = 1536,
    height = 1536,
    data = randomFillSync(Buffer.alloc(width * height * 4));
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const input = Buffer.from(encode({ width, height, data }, 60).data);
  assert.ok(input.length < 5 * 1024 * 1024);
  assert.throws(() => sanitizeJpeg(input), /larger than 5 MiB when normalized/);
});

test("JPEG decoder allocation limits reject a large declared frame before reading short entropy and do not poison later uploads", () => {
  const source = jpegFixture(24, 16),
    large = replaceSegment(source, 0xc0, (b) => {
      b.writeUInt16BE(2048, 1);
      b.writeUInt16BE(8192, 3);
      return b;
    });
  assert.throws(() => sanitizeJpeg(large), /too much decoder memory/);
  assert.equal(sanitizeJpeg(source).width, 24);
});
