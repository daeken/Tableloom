import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createModulePreview } from "./preview-app.js";

const directory = await mkdtemp(join(tmpdir(), "tableloom-module-preview-"));
let preview: Awaited<ReturnType<typeof createModulePreview>> | undefined;
try {
  preview = await createModulePreview(
    join(directory, "preview.sqlite"),
    fileURLToPath(
      new URL("../../node_modules/.cache/tableloom-modules/", import.meta.url),
    ),
  );
  const url = await preview.app.listen({ host: "127.0.0.1", port: 4350 });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await preview?.app.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void close());
  console.log(
    `Module preview: ${url}\nSynthetic data only; temporary database is removed on normal exit. Stop with Ctrl+C.`,
  );
} catch (error) {
  await preview?.app.close();
  await rm(directory, { recursive: true, force: true });
  throw error;
}
