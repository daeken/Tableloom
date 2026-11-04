import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  documentData,
  MAX_DOCUMENT_BYTES,
  defineSystem,
} from "@tableloom/module-sdk";
import { defineServerSystem } from "@tableloom/module-sdk/server";
import { documentCreateSchema, documentSchema } from "./documents.js";
import { manifest } from "@tableloom/cyberpunk-red";

test("module payloads round-trip bounded JSON without prototype pollution or reference sharing", () => {
  const shared = { text: "A note 🧵", values: [null, true, 2.5] };
  const value = { first: shared, second: shared };
  const parsed = documentData(value);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(value)));
  assert.notEqual(parsed, value);
  const pollution = documentData(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.hasOwn(pollution as object, "__proto__"), true);
  assert.equal("polluted" in {}, false);
  assert.equal(
    documentData("a".repeat(MAX_DOCUMENT_BYTES - 2)),
    "a".repeat(MAX_DOCUMENT_BYTES - 2),
  );
  assert.throws(() => documentData("a".repeat(MAX_DOCUMENT_BYTES - 1)));
  assert.throws(() => documentData(["a".repeat(40000), "b".repeat(40000)]));
});

test("module JSON rejects cycles, depth/work/size overflow, sparse arrays, accessors, symbols, and non-JSON values", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  let deep: unknown = null;
  for (let i = 0; i < 22; i++) deep = { value: deep };
  let invoked = false;
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  const hidden = Object.defineProperty({}, "secret", { value: 1 });
  const symbol = { [Symbol("hidden")]: 1 };
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => 1,
    new Date(),
    new Map(),
    new Set(),
    cycle,
    deep,
    Array(2),
    Array(10001).fill(1),
    accessor,
    hidden,
    symbol,
  ])
    assert.throws(() => documentData(value));
  assert.equal(invoked, false);
  assert.throws(() => documentData({ missing: undefined }));
});

test("document contracts reject spoofed metadata and schema hooks stay in the server SDK", () => {
  const create = {
    title: "Test",
    system: { id: manifest.id, version: manifest.version },
  };
  assert.equal(documentCreateSchema.parse(create).visibility, "gm");
  for (const extra of [
    { ownerId: crypto.randomUUID() },
    { schemaVersion: 1 },
    { campaignId: crypto.randomUUID() },
    { role: "gm" },
    { version: 1 },
  ])
    assert.equal(
      documentCreateSchema.safeParse({ ...create, ...extra }).success,
      false,
    );
  assert.equal(
    documentSchema.safeParse({ ...create, data: undefined }).success,
    false,
  );
  const schema = z.object({ name: z.string() }).strict();
  const definition = {
    manifest,
    documentVersion: 2,
    documentSchema: schema,
    createDocument: () => ({ name: "" }),
  };
  assert.equal(
    defineServerSystem({
      ...definition,
      documentMigrations: [
        { from: 1, to: 2, outputSchema: schema, migrate: () => ({ name: "" }) },
      ],
    }).documentVersion,
    2,
  );
  assert.throws(() =>
    defineServerSystem({
      ...definition,
      documentMigrations: [
        { from: 1, to: 3, outputSchema: schema, migrate: () => ({ name: "" }) },
      ],
    }),
  );
  const step = {
    from: 1,
    to: 2,
    outputSchema: schema,
    migrate: () => ({ name: "" }),
  };
  assert.throws(() =>
    defineServerSystem({ ...definition, documentMigrations: [step, step] }),
  );
  assert.throws(() =>
    defineSystem({
      manifest,
      documentVersion: 1,
      documentSchema: z.date(),
      createDocument: () => new Date(),
    }),
  );
});
