import { useId } from "react";
import type { z } from "zod";
import {
  defineBrowserContent,
  defineBrowserSystem,
} from "@tableloom/module-sdk/browser";
import type { DocumentSheetProps } from "@tableloom/module-sdk/browser";
import type { InstanceEditorProps } from "@tableloom/module-sdk/browser";
import {
  previewContentPins,
  paperDefinition,
  paperInstance,
  kitDefinition,
  kitInstance,
  dossier,
  checklist,
} from "./shared.js";

function DossierSheet({
  data,
  onChange,
  readOnly,
  actionsEnabled,
  runAction,
}: DocumentSheetProps<z.infer<typeof dossier.documentSchema>>) {
  const id = useId();
  return (
    <div className="example-fields">
      <label htmlFor={`${id}-alias`}>Alias</label>
      <input
        id={`${id}-alias`}
        maxLength={100}
        readOnly={readOnly}
        value={data.alias}
        onChange={(e) => onChange({ ...data, alias: e.target.value })}
      />
      <label htmlFor={`${id}-notes`}>Dossier notes</label>
      <textarea
        id={`${id}-notes`}
        readOnly={readOnly}
        maxLength={2000}
        value={data.notes}
        onChange={(e) => onChange({ ...data, notes: e.target.value })}
      />
      <button
        type="button"
        disabled={!actionsEnabled}
        onClick={() => void runAction("notes.normalize", null)}
      >
        Normalize notes on server
      </button>
      <button
        type="button"
        disabled={!actionsEnabled}
        onClick={() => void runAction("example.fail", null)}
      >
        Try failing action
      </button>
    </div>
  );
}
function ChecklistSheet({
  data,
  onChange,
  readOnly,
  actionsEnabled,
  runAction,
}: DocumentSheetProps<z.infer<typeof checklist.documentSchema>>) {
  const id = useId();
  return (
    <div className="example-fields">
      <label htmlFor={`${id}-heading`}>Checklist heading</label>
      <input
        id={`${id}-heading`}
        maxLength={100}
        readOnly={readOnly}
        value={data.heading}
        onChange={(e) => onChange({ ...data, heading: e.target.value })}
      />
      {data.entries.map((entry, i) => (
        <label className="example-check" key={i}>
          <input
            type="checkbox"
            disabled={readOnly}
            checked={entry.done}
            onChange={(e) =>
              onChange({
                ...data,
                entries: data.entries.map((value, n) =>
                  n === i ? { ...value, done: e.target.checked } : value,
                ),
              })
            }
          />
          {entry.label}
        </label>
      ))}
      <button
        type="button"
        disabled={!actionsEnabled}
        onClick={() => void runAction("entry.toggle", { index: 0 })}
      >
        Toggle first entry on server
      </button>
    </div>
  );
}
function PaperEditor({
  data,
  onChange,
  readOnly,
}: InstanceEditorProps<z.infer<typeof paperInstance>>) {
  const id = useId();
  return (
    <div className="example-fields">
      <label htmlFor={id}>Inscription</label>
      <textarea
        id={id}
        readOnly={readOnly}
        maxLength={500}
        value={data.inscription}
        onChange={(e) => onChange({ ...data, inscription: e.target.value })}
      />
      <label className="example-check">
        <input
          type="checkbox"
          disabled={readOnly}
          checked={data.folded}
          onChange={(e) => onChange({ ...data, folded: e.target.checked })}
        />
        Folded
      </label>
    </div>
  );
}
function KitEditor({
  data,
  onChange,
  readOnly,
}: InstanceEditorProps<z.infer<typeof kitInstance>>) {
  return (
    <div className="example-fields">
      {data.packed.map((part, i) => (
        <label className="example-check" key={i}>
          <input
            type="checkbox"
            disabled={readOnly}
            checked={part.checked}
            onChange={(e) =>
              onChange({
                packed: data.packed.map((p, n) =>
                  n === i ? { ...p, checked: e.target.checked } : p,
                ),
              })
            }
          />
          {part.label}
        </label>
      ))}
    </div>
  );
}
const paperBrowser = defineBrowserContent({
  ...previewContentPins.dossier,
  schemaVersion: 1,
  definitionSchema: paperDefinition,
  instanceSchema: paperInstance,
  Definition: ({ data }) => <p>{data.text}</p>,
  Instance: PaperEditor,
});
const kitBrowser = defineBrowserContent({
  ...previewContentPins.checklist,
  schemaVersion: 1,
  definitionSchema: kitDefinition,
  instanceSchema: kitInstance,
  Definition: ({ data }) => (
    <ul>
      {data.parts.map((part, i) => (
        <li key={i}>{part}</li>
      ))}
    </ul>
  ),
  Instance: KitEditor,
});
export const previewBrowsers = {
  dossier: defineBrowserSystem(dossier, DossierSheet, [paperBrowser]),
  checklist: defineBrowserSystem(checklist, ChecklistSheet, [kitBrowser]),
};
