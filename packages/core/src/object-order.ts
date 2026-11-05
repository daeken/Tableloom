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
