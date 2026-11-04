import { z } from "zod";
import { defineSystem } from "@tableloom/module-sdk";

// Provisional document envelope only. Published mechanics await source PDFs.
export const system = defineSystem({
  manifest: {
    id: "cyberpunk-red",
    name: "Cyberpunk RED",
    version: "0.1.0",
    sdkVersion: 1,
    status: "scaffold",
    description: "Street stories. Human stakes. Neon nights.",
    accent: "#db695f",
  },
  documentVersion: 1,
  documentSchema: z
    .object({
      name: z.string().max(100),
      notes: z.string().max(10000),
    })
    .strict(),
  createDocument: () => ({ name: "", notes: "" }),
});
export const manifest = system.manifest;
