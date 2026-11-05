import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { bundleAssetPath, initialJavaScript } from "./bundle-metrics.js";

const directory = fileURLToPath(new URL("../apps/web/dist/", import.meta.url)),
  initial = new Set(
    initialJavaScript(
      JSON.parse(
        await readFile(
          new URL("../apps/web/dist/.vite/manifest.json", import.meta.url),
          "utf8",
        ),
      ) as unknown,
    ),
  ),
  files = (await readdir(directory, { recursive: true }))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.endsWith(".js"))
    .sort();
for (const file of initial)
  if (!files.includes(file))
    throw new Error(`Missing initial build asset: ${file}`);
const metrics = await Promise.all(
  files.map(async (file) => {
    const bytes = await readFile(bundleAssetPath(directory, file));
    return { file, rawBytes: bytes.length, gzipBytes: gzipSync(bytes).length };
  }),
);
const summarize = (rows: typeof metrics) => ({
  files: rows.length,
  rawBytes: rows.reduce((sum, row) => sum + row.rawBytes, 0),
  gzipBytes: rows.reduce((sum, row) => sum + row.gzipBytes, 0),
});
const initialFiles = metrics.filter((row) => initial.has(row.file)),
  deferredFiles = metrics.filter((row) => !initial.has(row.file));
console.log(
  JSON.stringify(
    {
      note: "JavaScript bytes only. Gzip is a per-file estimate; the host/proxy controls transfer compression. Deferred files may load after sign-in or interaction.",
      initial: summarize(initialFiles),
      deferred: summarize(deferredFiles),
      total: summarize(metrics),
      initialFiles,
      deferredFiles,
    },
    null,
    2,
  ),
);
