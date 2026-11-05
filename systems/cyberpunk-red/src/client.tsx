import { useId } from "react";
import { defineBrowserSystem } from "@tableloom/module-sdk/browser";
import type { DocumentSheetProps } from "@tableloom/module-sdk/browser";
import type { z } from "zod";
import { system } from "./index.js";

type Data = z.infer<typeof system.documentSchema>;
function CharacterSheet({
  data,
  onChange,
  readOnly,
}: DocumentSheetProps<Data>) {
  const id = useId();
  return (
    <fieldset className="module-sheet-fields">
      <legend>Character details</legend>
      <div>
        <label htmlFor={`${id}-name`}>Character name</label>
        <input
          id={`${id}-name`}
          readOnly={readOnly}
          maxLength={100}
          value={data.name}
          onChange={(event) => onChange({ ...data, name: event.target.value })}
        />
      </div>
      <div>
        <label htmlFor={`${id}-notes`}>Character notes</label>
        <textarea
          id={`${id}-notes`}
          readOnly={readOnly}
          rows={8}
          maxLength={10000}
          value={data.notes}
          onChange={(event) => onChange({ ...data, notes: event.target.value })}
        />
      </div>
    </fieldset>
  );
}
export const browserSystem = defineBrowserSystem(system, CharacterSheet);
