import { z } from "zod";
import { defineSystem } from "@tableloom/module-sdk";

// Provisional document envelope only. Published mechanics await source PDFs.
export const system = defineSystem({
  manifest: {
    id: "kids-on-brooms",
    name: "Kids on Brooms",
    version: "0.1.0",
    sdkVersion: 1,
    status: "scaffold",
    description: "Strange magic. Shared secrets. Your story.",
    accent: "#aa8cd1",
  },
  documentSchema: z.object({
    name: z.string().max(100),
    notes: z.string().max(10000),
  }),
  createDocument: () => ({ name: "", notes: "" }),
});
export const manifest = system.manifest;
