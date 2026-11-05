import { z } from "zod";
import { defineSystem } from "@tableloom/module-sdk";

const manifest = {
  version: "0.0.0",
  sdkVersion: 1 as const,
  status: "playtest" as const,
  description:
    "Synthetic authoring fixture only. Contains no RPG rules or game content.",
  accent: "#405f4d",
};
export const dossier = defineSystem({
  manifest: { ...manifest, id: "preview-dossier", name: "Synthetic dossier" },
  documentVersion: 1,
  documentSchema: z
    .object({ alias: z.string().max(100), notes: z.string().max(2000) })
    .strict(),
  createDocument: () => ({ alias: "Sample", notes: "  synthetic   preview  " }),
});
export const checklist = defineSystem({
  manifest: {
    ...manifest,
    id: "preview-checklist",
    name: "Synthetic checklist",
  },
  documentVersion: 1,
  documentSchema: z
    .object({
      heading: z.string().max(100),
      entries: z
        .array(
          z.object({ label: z.string().max(100), done: z.boolean() }).strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  createDocument: () => ({
    heading: "Example list",
    entries: [
      { label: "Bring a blank page", done: false },
      { label: "Pack a pencil", done: false },
    ],
  }),
});
export const previewKinds = ["dossier", "checklist"] as const;
export const previewKindSchema = z.enum(previewKinds);
export const previewRoleSchema = z.enum(["owner", "reader", "gm"]);
export const previewSessionSchema = z
  .object({ fixture: previewKindSchema, role: previewRoleSchema })
  .strict();
