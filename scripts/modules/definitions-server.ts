import { z } from "zod";
import {
  defineContentInstances,
  defineDocumentAction,
  defineServerSystem,
} from "@tableloom/module-sdk/server";
import { defineContentPack } from "@tableloom/module-sdk/content";
import {
  previewContentPins,
  paperDefinition,
  paperInstance,
  kitDefinition,
  kitInstance,
  dossier,
  checklist,
} from "./shared.js";

export const serverCanary = "PREVIEW_SERVER_ONLY_CANARY";
export const paperPack = defineContentPack(dossier, {
  ...previewContentPins.dossier,
  dataSchema: paperDefinition,
  instances: defineContentInstances(paperDefinition, {
    schemaVersion: 1,
    dataSchema: paperInstance,
    create: (definition) => ({ inscription: definition.text, folded: false }),
  }),
  definitions: [
    {
      id: "blank",
      name: "Blank paper",
      kind: "example",
      visibility: "public",
      sources: [],
      data: { text: "A blank synthetic page" },
    },
    {
      id: "private",
      name: "Private paper",
      kind: "example",
      visibility: "gm",
      sources: [],
      data: { text: serverCanary },
    },
  ],
});
export const kitPack = defineContentPack(checklist, {
  ...previewContentPins.checklist,
  dataSchema: kitDefinition,
  instances: defineContentInstances(kitDefinition, {
    schemaVersion: 1,
    dataSchema: kitInstance,
    create: (definition) => ({
      packed: definition.parts.map((label) => ({ label, checked: false })),
    }),
  }),
  definitions: [
    {
      id: "blank",
      name: "Stationery kit",
      kind: "example",
      visibility: "public",
      sources: [],
      data: { parts: ["Blank page", "Pencil"] },
    },
    {
      id: "private",
      name: "Private kit",
      kind: "example",
      visibility: "gm",
      sources: [],
      data: { parts: [serverCanary] },
    },
  ],
});
export const dossierServer = defineServerSystem({
  ...dossier,
  contentPacks: [paperPack],
  documentActions: [
    defineDocumentAction(dossier, {
      id: "notes.normalize",
      inputSchema: z.null(),
      run: ({ data }) => ({
        ...data,
        notes: data.notes.replace(/\s+/g, " ").trim(),
      }),
    }),
    defineDocumentAction(dossier, {
      id: "example.fail",
      inputSchema: z.null(),
      run: ({ data }) => {
        data.notes = "Never save this mutation";
        throw new Error(serverCanary);
      },
    }),
  ],
});
export const checklistServer = defineServerSystem({
  ...checklist,
  contentPacks: [kitPack],
  documentActions: [
    defineDocumentAction(checklist, {
      id: "entry.toggle",
      inputSchema: z
        .object({ index: z.number().int().min(0).max(19) })
        .strict(),
      run: ({ data, input }) => {
        if (!data.entries[input.index]) throw new Error("No such entry");
        return {
          ...data,
          entries: data.entries.map((entry, i) =>
            i === input.index ? { ...entry, done: !entry.done } : entry,
          ),
        };
      },
    }),
  ],
});
export const previewServers = {
  dossier: dossierServer,
  checklist: checklistServer,
};
