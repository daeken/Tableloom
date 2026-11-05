import { z } from "zod";
import {
  pointSchema,
  tokenSchema,
  drawingSchema,
  translationSchema,
  tokenRadiusSchema,
  sceneTextSnapshotSchema,
  sameTextStyle,
} from "@tableloom/core";
const originalGeometrySchema = z.union([
  z
    .object({
      objectId: z.uuid(),
      objectType: z.literal("token"),
      position: pointSchema,
    })
    .strict(),
  z
    .object({
      objectId: z.uuid(),
      objectType: z.literal("drawing"),
      points: drawingSchema.shape.points,
    })
    .strict(),
]);
const deletedObjectSchema = z.union([
  z.object({ objectType: z.literal("token"), object: tokenSchema }).strict(),
  z
    .object({ objectType: z.literal("drawing"), object: drawingSchema })
    .strict(),
]);
const tokenGeometrySchema = z
  .object({ position: pointSchema, radius: tokenRadiusSchema })
  .strict();
const resizeChangeSchema = z.union([
  z
    .object({
      objectId: z.uuid(),
      objectType: z.literal("token"),
      before: tokenGeometrySchema,
      after: tokenGeometrySchema,
    })
    .strict(),
  z
    .object({
      objectId: z.uuid(),
      objectType: z.literal("drawing"),
      before: drawingSchema.shape.points,
      after: drawingSchema.shape.points,
    })
    .strict()
    .refine(
      (c) => c.before.length === c.after.length,
      "Resize history must preserve point count.",
    ),
]);
export const payloadSchema = z.union([
  z
    .object({
      kind: z.literal("text-update"),
      objectType: z.literal("drawing"),
      before: sceneTextSnapshotSchema,
      after: sceneTextSnapshotSchema,
    })
    .strict()
    .refine(
      (p) =>
        p.before.text !== p.after.text ||
        p.before.color !== p.after.color ||
        !sameTextStyle(p.before.textStyle, p.after.textStyle),
      "Text history must contain a change.",
    ),
  z
    .object({
      kind: z.literal("resize-many"),
      objectType: z.enum(["token", "drawing", "mixed"]),
      changes: z.array(resizeChangeSchema).min(2).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("token-resize"),
      objectType: z.literal("token"),
      before: tokenRadiusSchema,
      after: tokenRadiusSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("resize"),
      objectType: z.literal("drawing"),
      before: drawingSchema.shape.points,
      after: drawingSchema.shape.points,
    })
    .strict()
    .refine(
      (payload) => payload.before.length === payload.after.length,
      "Resize history must preserve point count.",
    ),
  z
    .object({
      kind: z.literal("delete-many"),
      objectType: z.enum(["token", "drawing", "mixed"]),
      objects: z.array(deletedObjectSchema).min(1).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("translate"),
      objectType: z.enum(["token", "drawing", "mixed"]),
      delta: translationSchema,
      originals: z.array(originalGeometrySchema).min(1).max(100),
    })
    .strict(),
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
  if (payload.kind === "resize-many") {
    if (
      payload.changes.length !== targets.length ||
      new Set(payload.changes.map((c) => c.objectId)).size !== targets.length ||
      payload.changes.some(
        (c) => !targets.some((t) => t.objectId === c.objectId),
      )
    )
      throw new Error("Resized history targets are inconsistent.");
    const kind = payload.changes.every((c) => c.objectType === "token")
      ? "token"
      : payload.changes.every((c) => c.objectType === "drawing")
        ? "drawing"
        : "mixed";
    if (payload.objectType !== kind)
      throw new Error("Resized history types are inconsistent.");
  } else if (payload.kind === "delete-many") {
    if (
      payload.objects.length !== targets.length ||
      new Set(payload.objects.map((saved) => saved.object.id)).size !==
        targets.length ||
      payload.objects.some(
        (saved) =>
          !targets.some((target) => target.objectId === saved.object.id),
      )
    )
      throw new Error("Deleted history targets are inconsistent.");
    const kind = payload.objects.every((saved) => saved.objectType === "token")
      ? "token"
      : payload.objects.every((saved) => saved.objectType === "drawing")
        ? "drawing"
        : "mixed";
    if (kind !== payload.objectType)
      throw new Error("Deleted history types are inconsistent.");
  } else if (payload.kind === "translate") {
    if (
      payload.originals.length !== targets.length ||
      new Set(payload.originals.map((original) => original.objectId)).size !==
        targets.length ||
      payload.originals.some(
        (original) =>
          !targets.some((target) => target.objectId === original.objectId),
      )
    )
      throw new Error("Translated history targets are inconsistent.");
    const kind = payload.originals.every(
      (original) => original.objectType === "token",
    )
      ? "token"
      : payload.originals.every((original) => original.objectType === "drawing")
        ? "drawing"
        : "mixed";
    if (kind !== payload.objectType)
      throw new Error("Translated history types are inconsistent.");
  } else if (payload.kind === "move-many") {
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
    (payload.kind !== "move" &&
      payload.kind !== "resize" &&
      payload.kind !== "token-resize" &&
      payload.kind !== "text-update" &&
      payload.object.id !== targets[0]!.objectId)
  )
    throw new Error("Scene history target is inconsistent.");
  return { ...entry, payload, targets };
}
export const expectsPresent = (entry: Entry) =>
  entry.payload.kind === "text-update" ||
  entry.payload.kind === "resize-many" ||
  entry.payload.kind === "token-resize" ||
  entry.payload.kind === "resize" ||
  entry.payload.kind === "translate" ||
  entry.payload.kind === "move" ||
  entry.payload.kind === "move-many" ||
  (entry.payload.kind === "create"
    ? entry.state === "done"
    : entry.state === "undone");
