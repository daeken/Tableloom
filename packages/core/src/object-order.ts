import { z } from "zod";
const orderSchema = (limit: number) =>
  z
    .array(z.uuid())
    .max(limit)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "Order contains duplicate IDs.",
    );
export const drawingOrderSchema = orderSchema(2000);
export const tokenOrderSchema = orderSchema(200);
export const orderDirectionSchema = z.enum(["front", "back"]);
export function objectOrderMatches(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
/** Array order is back to front. Only the chosen object's relative position changes. */
export function reorderedObjects<T extends { id: string }>(
  objects: readonly T[],
  id: string,
  direction: "front" | "back",
): T[] {
  const object = objects.find((d) => d.id === id);
  if (!object) throw new Error("That scene object is unavailable.");
  const rest = objects.filter((d) => d.id !== id);
  return direction === "front" ? [...rest, object] : [object, ...rest];
}

export const drawingLayerSchema = z.enum(["below-tokens", "above-tokens"]);
export type DrawingLayer = z.infer<typeof drawingLayerSchema>;
export const drawingLayersSchema = z.array(drawingLayerSchema).max(2000);
export function drawingLayerOf(drawing: {
  id: string;
  layer?: DrawingLayer | undefined;
}): DrawingLayer {
  return drawing.layer ?? "below-tokens";
}
export function drawingLayersOf(
  drawings: readonly { id: string; layer?: DrawingLayer | undefined }[],
): DrawingLayer[] {
  return drawings.map(drawingLayerOf);
}
/** Visible back-to-front drawing order, with the token stratum between these groups. */
export function layeredDrawings<
  T extends { id: string; layer?: DrawingLayer | undefined },
>(drawings: readonly T[]): T[] {
  return [
    ...drawings.filter((d) => drawingLayerOf(d) === "below-tokens"),
    ...drawings.filter((d) => drawingLayerOf(d) === "above-tokens"),
  ];
}

export const tokenLayerSchema = z.enum(["between-drawings", "above-drawings"]);
export type TokenLayer = z.infer<typeof tokenLayerSchema>;
export const tokenLayersSchema = z.array(tokenLayerSchema).max(200);
export function tokenLayerOf(token: {
  id: string;
  layer?: TokenLayer | undefined;
}): TokenLayer {
  return token.layer ?? "between-drawings";
}
export function tokenLayersOf(
  tokens: readonly { id: string; layer?: TokenLayer | undefined }[],
): TokenLayer[] {
  return tokens.map(tokenLayerOf);
}
/** Visible back-to-front token order, with upper drawings between these groups. */
export function layeredTokens<
  T extends { id: string; layer?: TokenLayer | undefined },
>(tokens: readonly T[]): T[] {
  return [
    ...tokens.filter((d) => tokenLayerOf(d) === "between-drawings"),
    ...tokens.filter((d) => tokenLayerOf(d) === "above-drawings"),
  ];
}
