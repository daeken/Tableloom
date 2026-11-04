import { z } from "zod";
import { defineSystem } from "@tableloom/module-sdk";

// Provisional document envelope only. Published mechanics await source PDFs.
export const system = defineSystem({
  manifest: {
    id: "kids-on-bikes",
    name: "Kids on Bikes",
    version: "0.1.0",
    sdkVersion: 1,
    status: "scaffold",
    description: "Small towns. Big mysteries. Unlikely heroes.",
    accent: "#d4a95f",
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
