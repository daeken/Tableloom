import type { ComponentType, ReactNode } from "react";
import { documentData } from "./document-data.js";
import type { DocumentData } from "./document-data.js";
import type { ModuleManifest, SystemDefinition } from "./index.js";
import { z } from "zod";
import { contentIdSchema, contentVersionSchema } from "./content.js";

export interface InstanceEditorProps<T> {
  data: T;
  onChange: (data: T) => void;
  readOnly: boolean;
}
export interface BrowserContent {
  id: string;
  version: string;
  schemaVersion: number;
  parseDefinition: (data: unknown) => DocumentData;
  parseInstance: (data: unknown) => DocumentData;
  renderDefinition: (data: DocumentData) => ReactNode;
  renderInstance: (props: InstanceEditorProps<DocumentData>) => ReactNode;
}
/** Schemas and controls only: never import pack definitions or factories in the browser. */
export function defineBrowserContent<Definition, Instance>(options: {
  id: string;
  version: string;
  schemaVersion: number;
  definitionSchema: z.ZodType<Definition>;
  instanceSchema: z.ZodType<Instance>;
  Definition: ComponentType<{ data: Definition }>;
  Instance: ComponentType<InstanceEditorProps<Instance>>;
}): BrowserContent {
  contentIdSchema.parse(options.id);
  contentVersionSchema.parse(options.version);
  z.number().int().positive().parse(options.schemaVersion);
  const Definition = options.Definition,
    Instance = options.Instance;
  return {
    id: options.id,
    version: options.version,
    schemaVersion: options.schemaVersion,
    parseDefinition: (value) =>
      documentData(options.definitionSchema.parse(documentData(value))),
    parseInstance: (value) =>
      documentData(options.instanceSchema.parse(documentData(value))),
    renderDefinition: (data) => (
      <Definition data={options.definitionSchema.parse(data)} />
    ),
    renderInstance: ({ data, onChange, readOnly }) => (
      <Instance
        data={options.instanceSchema.parse(data)}
        readOnly={readOnly}
        onChange={(value) => onChange(documentData(value))}
      />
    ),
  };
}

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
  content?: readonly BrowserContent[];
}
/** Browser-only adapter: preserves module field types without prescribing their shape. */
export function defineBrowserSystem<T>(
  system: SystemDefinition<T>,
  Sheet: ComponentType<DocumentSheetProps<T>>,
  content: readonly BrowserContent[] = [],
): BrowserSystem {
  if (
    new Set(content.map((c) => `${c.id}@${c.version}`)).size !== content.length
  )
    throw new Error("Duplicate browser content registration.");
  return {
    manifest: system.manifest,
    documentVersion: system.documentVersion,
    content,
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
