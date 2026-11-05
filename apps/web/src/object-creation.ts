import {
  drawingInputSchema,
  pointSchema,
  tokenInputSchema,
} from "@tableloom/core";
import type { CommandInput, SceneTextStyle, TableView } from "@tableloom/core";
import { textPlacement } from "./text-placement.js";

export type CreationKind = "token" | "rectangle" | "text";
export interface CreationDraft {
  kind: CreationKind;
  x: string;
  y: string;
  width: string;
  height: string;
  name: string;
  text: string;
  color: string;
  textStyle: SceneTextStyle;
}
function number(value: string) {
  if (!value.trim() || !Number.isFinite(Number(value)))
    throw new Error("Enter a finite number in each coordinate and size field.");
  return Number(value);
}
/** Explicit coordinates never snap, clamp, or depend on the current camera. */
export function objectCreationCommand(
  draft: CreationDraft,
  id: string,
): CommandInput {
  const position = pointSchema.parse({
    x: number(draft.x),
    y: number(draft.y),
  });
  if (draft.kind === "token")
    return {
      type: "token.add",
      token: tokenInputSchema.parse({
        id,
        name: draft.name,
        color: draft.color,
        position,
      }),
    };
  if (draft.kind === "text") {
    const drawing = textPlacement(
      draft.text,
      position,
      draft.color,
      id,
      draft.textStyle,
    );
    if (
      drawing.points[0]!.x !== position.x ||
      drawing.points[0]!.y !== position.y
    )
      throw new Error(
        "The label must fit inside the canvas coordinate limits.",
      );
    return { type: "drawing.add", drawing };
  }
  const width = number(draft.width),
    height = number(draft.height);
  if (width <= 0 || height <= 0)
    throw new Error("Room width and height must be greater than zero.");
  return {
    type: "drawing.add",
    drawing: drawingInputSchema.parse({
      id,
      kind: "rectangle",
      color: draft.color,
      points: [position, { x: position.x + width, y: position.y + height }],
    }),
  };
}
export function creationAvailable(
  kind: CreationKind,
  state: Pick<TableView, "tokens" | "drawings">,
  enabled: boolean,
  pending: boolean,
) {
  return (
    enabled &&
    !pending &&
    (kind === "token"
      ? state.tokens.length < 200
      : state.drawings.length < 2000)
  );
}
