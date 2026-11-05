import {
  drawingInputSchema,
  sceneTextSchema,
  DEFAULT_TEXT_STYLE,
  sceneTextStyleSchema,
} from "@tableloom/core";
import type { Point, SceneTextStyle } from "@tableloom/core";
/** Initial neutral label box; later transforms use saved corners rather than font measurements. */
export function textPlacement(
  text: string,
  anchor: Point,
  color: string,
  id: string,
  textStyle: SceneTextStyle = { ...DEFAULT_TEXT_STYLE },
) {
  const value = sceneTextSchema.parse(text),
    lines = value.split("\n"),
    width = Math.max(24, ...lines.map((line) => Array.from(line).length * 16)),
    height = Math.max(32, lines.length * 32),
    x = Math.max(-10000, Math.min(anchor.x, 10000 - width)),
    y = Math.max(-10000, Math.min(anchor.y, 10000 - height));
  return drawingInputSchema.parse({
    id,
    kind: "text",
    text: value,
    textStyle: sceneTextStyleSchema.parse(textStyle),
    color,
    points: [
      { x, y },
      { x: x + width, y: y + height },
    ],
  });
}
