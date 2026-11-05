import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { serverCanary } from "./definitions-server.js";
import { verifyModulePreview, verifyNormalStartupIsolation } from "./verify.js";

const directory = fileURLToPath(
  new URL("../../node_modules/.cache/tableloom-modules/", import.meta.url),
);
const files = await readdir(directory, { recursive: true });
assert.ok(files.includes("index.html"));
for (const file of files.filter((f) => f.endsWith(".js"))) {
  const source = await readFile(`${directory}/${file}`, "utf8");
  assert.ok(
    !source.includes(serverCanary),
    `Server-only preview content in ${file}`,
  );
  assert.ok(
    !source.includes("node:sqlite"),
    `Server persistence imported by ${file}`,
  );
}
await verifyNormalStartupIsolation();
console.log(
  JSON.stringify(
    {
      modulePreview: "passed",
      browserBoundary: "passed",
      examples: await verifyModulePreview(),
    },
    null,
    2,
  ),
);
