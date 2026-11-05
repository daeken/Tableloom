import { z } from "zod";
export const drawingOrderSchema = z
  .array(z.uuid())
  .max(2000)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "Drawing order contains duplicate IDs.",
  );
export const drawingOrderDirectionSchema = z.enum(["front", "back"]);
export function drawingOrderMatches(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
/** Array order is back to front. Only the chosen object's relative position changes. */
export function reorderedDrawings<T extends { id: string }>(
  drawings: readonly T[],
  id: string,
  direction: "front" | "back",
): T[] {
  const object = drawings.find((d) => d.id === id);
  if (!object) throw new Error("That drawing is unavailable.");
  const rest = drawings.filter((d) => d.id !== id);
  return direction === "front" ? [...rest, object] : [object, ...rest];
}
