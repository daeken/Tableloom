import { z } from "zod";
import { pointSchema, tokenSchema, drawingSchema } from "@tableloom/core";
export const payloadSchema = z.union([
  z
    .object({
      kind: z.literal("move"),
      objectType: z.literal("token"),
      before: pointSchema,
      after: pointSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("move-many"),
      objectType: z.literal("token"),
      moves: z
        .array(
          z
            .object({
              objectId: z.uuid(),
              before: pointSchema,
              after: pointSchema,
            })
            .strict(),
        )
        .min(2)
        .max(100),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["create", "delete"]),
      objectType: z.literal("token"),
      object: tokenSchema,
    })
    .strict(),
  z
    .object({
      kind: z.enum(["create", "delete"]),
      objectType: z.literal("drawing"),
      object: drawingSchema,
    })
    .strict(),
]);
export type Payload = z.infer<typeof payloadSchema>;
export const targetsSchema = z
  .array(
    z
      .object({
        objectId: z.uuid(),
        expectedVersion: z.number().int().positive(),
        previousId: z.uuid().nullable(),
      })
      .strict(),
  )
  .min(1)
  .max(100)
  .refine(
    (targets) =>
      new Set(targets.map((target) => target.objectId)).size === targets.length,
    "Duplicate history targets.",
  );
export type Target = z.infer<typeof targetsSchema>[number];
export const rowSchema = z.object({
  sequence: z.number().int().positive(),
  id: z.uuid(),
  campaign_id: z.uuid(),
  scene_id: z.uuid(),
  actor_id: z.uuid(),
  state: z.enum(["done", "undone"]),
  version: z.number().int().positive(),
  targets_json: z.string(),
  payload_json: z.string(),
});
export type Entry = z.infer<typeof rowSchema> & {
  payload: Payload;
  targets: Target[];
};
export function entryOf(row: unknown): Entry {
  const entry = rowSchema.parse(row),
    payload = payloadSchema.parse(JSON.parse(entry.payload_json)),
    targets = targetsSchema.parse(JSON.parse(entry.targets_json));
  if (payload.kind === "move-many") {
    if (
      payload.moves.length !== targets.length ||
      new Set(payload.moves.map((move) => move.objectId)).size !==
        targets.length ||
      payload.moves.some(
        (move) => !targets.some((target) => target.objectId === move.objectId),
      )
    )
      throw new Error("Scene history targets are inconsistent.");
  } else if (
    targets.length !== 1 ||
    (payload.kind !== "move" && payload.object.id !== targets[0]!.objectId)
  )
    throw new Error("Scene history target is inconsistent.");
  return { ...entry, payload, targets };
}
export const expectsPresent = (entry: Entry) =>
  entry.payload.kind === "move" ||
  entry.payload.kind === "move-many" ||
  (entry.payload.kind === "create"
    ? entry.state === "done"
    : entry.state === "undone");
