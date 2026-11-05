import type { ComponentType, ReactNode } from "react";
import { documentData } from "./document-data.js";
import type { DocumentData } from "./document-data.js";
import type { ModuleManifest, SystemDefinition } from "./index.js";

export interface DocumentSheetProps<T> {
  data: T;
  onChange: (data: T) => void;
  readOnly: boolean;
  actionsEnabled: boolean;
  runAction: (action: string, input: DocumentData) => Promise<boolean>;
}
export interface BrowserSystem {
  manifest: ModuleManifest;
  documentVersion: number;
  parse: (data: unknown) => DocumentData;
  renderSheet: (props: DocumentSheetProps<DocumentData>) => ReactNode;
}
/** Browser-only adapter: preserves module field types without prescribing their shape. */
export function defineBrowserSystem<T>(
  system: SystemDefinition<T>,
  Sheet: ComponentType<DocumentSheetProps<T>>,
): BrowserSystem {
  return {
    manifest: system.manifest,
    documentVersion: system.documentVersion,
    parse: (value) =>
      documentData(system.documentSchema.parse(documentData(value))),
    renderSheet: ({ data, onChange, readOnly, actionsEnabled, runAction }) => (
      <Sheet
        data={system.documentSchema.parse(data)}
        readOnly={readOnly}
        actionsEnabled={actionsEnabled}
        runAction={runAction}
        onChange={(value) => onChange(documentData(value))}
      />
    ),
  };
}
