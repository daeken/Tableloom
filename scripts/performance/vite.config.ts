import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(
      new URL(
        "../../node_modules/.cache/tableloom-performance/",
        import.meta.url,
      ),
    ),
    emptyOutDir: true,
  },
  preview: { host: "127.0.0.1", port: 4346, strictPort: true },
});
