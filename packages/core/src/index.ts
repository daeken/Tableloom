import { z } from "zod";
import { systemIdSchema } from "@tableloom/module-sdk";

export const pointSchema = z.object({
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
});
export type Point = z.infer<typeof pointSchema>;
const colorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);
export const drawingSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["stroke", "rectangle"]),
  points: z.array(pointSchema).min(2).max(2000),
  color: colorSchema,
  ownerId: z.uuid().nullable(),
});
export type Drawing = z.infer<typeof drawingSchema>;
export const drawingInputSchema = drawingSchema
  .omit({ ownerId: true })
  .strict();
export type DrawingInput = z.infer<typeof drawingInputSchema>;
export const tokenSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(32),
  position: pointSchema,
  color: colorSchema,
  ownerId: z.uuid().nullable(),
});
export type Token = z.infer<typeof tokenSchema>;
export const tokenInputSchema = tokenSchema.omit({ ownerId: true }).strict();

export const rollSchema = z.object({
  id: z.uuid(),
  actor: z.string().min(1).max(32),
  expression: z.string().max(32),
  dice: z.array(z.number().int().min(1).max(1000)).min(1).max(100),
  sides: z.number().int().min(2).max(1000),
  modifier: z.number().int(),
  total: z.number().int(),
  at: z.iso.datetime(),
});
export type Roll = z.infer<typeof rollSchema>;

const tableDataSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  systemId: systemIdSchema,
  drawings: z.array(drawingSchema).max(2000),
  tokens: z.array(tokenSchema).max(200),
  rolls: z.array(rollSchema).max(100),
});
export const tableSchema = tableDataSchema.superRefine((state, context) => {
  const ids = new Set<string>();
  for (const object of [...state.tokens, ...state.drawings]) {
    if (ids.has(object.id))
      context.addIssue({
        code: "custom",
        message: "Scene object IDs must be unique.",
      });
    ids.add(object.id);
  }
});
export type TableState = z.infer<typeof tableSchema>;
export const createTable = (): TableState => ({
  schemaVersion: 2,
  revision: 0,
  systemId: "cyberpunk-red",
  drawings: [],
  tokens: [],
  rolls: [],
});

const legacyTableSchema = tableDataSchema.extend({
  schemaVersion: z.literal(1),
  drawings: z.array(drawingInputSchema).max(2000),
  tokens: z.array(tokenInputSchema).max(200),
});

/** Pre-authentication objects stay GM-controlled; never guess an owner's identity. */
export function restoreTable(value: unknown): {
  state: TableState;
  migrated: boolean;
} {
  const legacy = legacyTableSchema.safeParse(value);
  if (!legacy.success)
    return { state: tableSchema.parse(value), migrated: false };
  const state = tableSchema.parse({
    ...legacy.data,
    schemaVersion: 2,
    drawings: legacy.data.drawings.map((drawing) => ({
      ...drawing,
      ownerId: null,
    })),
    tokens: legacy.data.tokens.map((token) => ({ ...token, ownerId: null })),
  });
  return { state, migrated: true };
}

const envelope = { id: z.uuid() };
export const commandSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("drawing.add"),
    drawing: drawingInputSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal("token.add"),
    token: tokenInputSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal("token.move"),
    tokenId: z.uuid(),
    position: pointSchema,
  }),
  z.object({
    ...envelope,
    type: z.literal("object.delete"),
    objectId: z.uuid(),
  }),
  z.object({
    ...envelope,
    type: z.literal("dice.roll"),
    expression: z.string().trim().min(1).max(32),
  }),
  z.object({
    ...envelope,
    type: z.literal("system.set"),
    systemId: systemIdSchema,
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandInput = Command extends infer C
  ? C extends Command
    ? Omit<C, "id">
    : never
  : never;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    state: tableSchema,
    participants: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("presence"),
    participants: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("error"), message: z.string().max(500) }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export interface DiceExpression {
  count: number;
  sides: number;
  modifier: number;
}
export function parseDice(expression: string): DiceExpression {
  const match = /^(\d{1,3})?d(\d{1,4})(?:\s*([+-])\s*(\d{1,5}))?$/i.exec(
    expression.trim(),
  );
  if (!match) throw new Error("Use a roll like d20, 2d6, or 3d10 + 4.");
  const count = Number(match[1] ?? 1);
  const sides = Number(match[2]);
  const modifier = Number(match[4] ?? 0) * (match[3] === "-" ? -1 : 1);
  if (
    count < 1 ||
    count > 100 ||
    sides < 2 ||
    sides > 1000 ||
    Math.abs(modifier) > 10000
  ) {
    throw new Error(
      "Roll 1–100 dice, with 2–1000 sides and a modifier up to 10,000.",
    );
  }
  return { count, sides, modifier };
}
