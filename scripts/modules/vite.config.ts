import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(
      new URL("../../node_modules/.cache/tableloom-modules/", import.meta.url),
    ),
    emptyOutDir: true,
  },
});
