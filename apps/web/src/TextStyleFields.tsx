import type { SceneTextStyle } from "@tableloom/core";
/** Only built-in generic font families; no external font requests or arbitrary CSS. */
export function TextStyleFields({
  value,
  change,
  prefix,
  text,
  color,
}: {
  value: SceneTextStyle;
  change: (value: SceneTextStyle) => void;
  prefix: string;
  text: string;
  color: string;
}) {
  return (
    <>
      <fieldset className="text-style-fields">
        <legend>Text style</legend>
        <label htmlFor={`${prefix}-font`}>
          Font
          <select
            id={`${prefix}-font`}
            value={value.font}
            onChange={(e) =>
              change({
                ...value,
                font: e.target.value as SceneTextStyle["font"],
              })
            }
          >
            <option value="monospace">Monospace</option>
            <option value="sans-serif">Sans serif</option>
            <option value="serif">Serif</option>
          </select>
        </label>
        <label htmlFor={`${prefix}-weight`}>
          Weight
          <select
            id={`${prefix}-weight`}
            value={value.weight}
            onChange={(e) =>
              change({
                ...value,
                weight: e.target.value as SceneTextStyle["weight"],
              })
            }
          >
            <option value="normal">Normal</option>
            <option value="bold">Bold</option>
          </select>
        </label>
        <label htmlFor={`${prefix}-align`}>
          Line alignment
          <select
            id={`${prefix}-align`}
            value={value.align}
            onChange={(e) =>
              change({
                ...value,
                align: e.target.value as SceneTextStyle["align"],
              })
            }
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </label>
      </fieldset>
      <div
        className="text-style-preview"
        aria-label="Text style preview"
        style={{
          fontFamily: value.font,
          fontWeight: value.weight,
          textAlign: value.align,
          color,
        }}
      >
        {text || "Label preview"}
      </div>
    </>
  );
}
