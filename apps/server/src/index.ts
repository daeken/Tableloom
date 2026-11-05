import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadHostKey } from "./host-key.js";
import { assertDataDirectoryReady } from "./storage-readiness.js";

const dataDir = resolve(process.env.DATA_DIR ?? "data");
assertDataDirectoryReady(dataDir);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const app = await createApp({
  databasePath: resolve(dataDir, "tableloom.sqlite"),
  webRoot: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  logger: true,
  hostKey: loadHostKey(dataDir, process.env.TABLELOOM_HOST_KEY),
  ...(process.env.PUBLIC_ORIGIN
    ? { publicOrigin: process.env.PUBLIC_ORIGIN }
    : {}),
});
if (!process.env.TABLELOOM_HOST_KEY)
  app.log.info(
    { path: resolve(dataDir, "host-key") },
    "Use the private host-key file to set up or recover the host.",
  );
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "127.0.0.1",
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close();
  });
}
