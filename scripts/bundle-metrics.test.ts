import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { bundleAssetPath, initialJavaScript } from "./bundle-metrics.js";
test("initial bundle measurement follows all static imports, deduplicates shared/cyclic chunks and excludes dynamic code", () => {
  assert.deepEqual(
    initialJavaScript({
      "index.html": {
        file: "assets/index.js",
        isEntry: true,
        imports: ["shared", "react"],
        dynamicImports: ["canvas"],
        css: ["assets/style.css"],
      },
      other: { file: "assets/other.js", isEntry: true, imports: ["shared"] },
      shared: { file: "assets/shared.js", imports: ["react"] },
      react: { file: "assets/react.js", imports: ["shared"] },
      canvas: { file: "assets/canvas.js", isDynamicEntry: true },
    }),
    [
      "assets/index.js",
      "assets/other.js",
      "assets/react.js",
      "assets/shared.js",
    ],
  );
});
test("bundle measurement rejects malformed manifests, absent entries, missing static imports and escaping file paths", () => {
  for (const manifest of [
    null,
    [],
    {},
    { app: { file: "app.js" } },
    { app: { file: "app.js", isEntry: true, imports: "other" } },
    { app: { file: "app.js", isEntry: true, imports: ["missing"] } },
  ])
    assert.throws(() => initialJavaScript(manifest));
  const root = resolve("apps/web/dist");
  assert.equal(
    bundleAssetPath(root, "assets/index.js"),
    resolve(root, "assets/index.js"),
  );
  for (const file of [
    "..",
    "../source.js",
    ".",
    resolve(root, "../outside.js"),
  ])
    assert.throws(() => bundleAssetPath(root, file));
});
