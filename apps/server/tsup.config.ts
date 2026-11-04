import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  splitting: false,
  noExternal: [/^@tableloom\//],
  external: ["fastify", "@fastify/static", "@fastify/websocket", "zod"],
  removeNodeProtocol: false,
});
