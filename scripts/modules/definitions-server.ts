import { z } from "zod";
import {
  defineDocumentAction,
  defineServerSystem,
} from "@tableloom/module-sdk/server";
import { dossier, checklist } from "./shared.js";

export const serverCanary = "PREVIEW_SERVER_ONLY_CANARY";
export const dossierServer = defineServerSystem({
  ...dossier,
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
