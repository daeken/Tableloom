import { z } from "zod";
import { systemIdSchema } from "@tableloom/module-sdk";
import { sceneHistorySchema } from "./scene-history.js";
import { commandContextSchema } from "./campaigns.js";
export const PROTOCOL_VERSION = 10;

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
  version: z.number().int().positive(),
});
export type Drawing = z.infer<typeof drawingSchema>;
export const drawingInputSchema = drawingSchema
  .omit({ ownerId: true, version: true })
  .strict();
export type DrawingInput = z.infer<typeof drawingInputSchema>;
export const tokenSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(32),
  position: pointSchema,
  color: colorSchema,
  ownerId: z.uuid().nullable(),
  version: z.number().int().positive(),
});
export type Token = z.infer<typeof tokenSchema>;
export const tokenInputSchema = tokenSchema
  .omit({ ownerId: true, version: true })
  .strict();

export const diceResultSchema = z.object({
  id: z.uuid(),
  actor: z.string().min(1).max(32),
  expression: z.string().max(32),
  dice: z.array(z.number().int().min(1).max(1000)).min(1).max(100),
  sides: z.number().int().min(2).max(1000),
  modifier: z.number().int(),
  total: z.number().int(),
  at: z.iso.datetime(),
});
export type DiceResult = z.infer<typeof diceResultSchema>;
export const visibilitySchema = z.enum(["public", "gm"]);
export const rollVisibilitySchema = visibilitySchema;
export type RollVisibility = z.infer<typeof rollVisibilitySchema>;
export const rollSchema = diceResultSchema
  .extend({
    ownerId: z.uuid().nullable(),
    visibility: rollVisibilitySchema,
  })
  .refine((roll) => roll.visibility === "public" || roll.ownerId !== null, {
    message: "A private roll must have an authenticated owner.",
  });
export type Roll = z.infer<typeof rollSchema>;
export const MAX_ROLL_HISTORY = 100;
export const MAX_TOTAL_ROLLS = 1100;
export const MAX_TABLE_NOTES = 100;
export const noteInputSchema = z
  .object({
    id: z.uuid(),
    title: z.string().trim().min(1).max(120),
    body: z.string().max(10000),
    visibility: visibilitySchema,
  })
  .strict();
export const noteSchema = noteInputSchema.extend({
  ownerId: z.uuid(),
  version: z.number().int().positive(),
});
export type Note = z.infer<typeof noteSchema>;

const tableDataSchema = z.object({
  schemaVersion: z.literal(5),
  revision: z.number().int().nonnegative(),
  systemId: systemIdSchema,
  drawings: z.array(drawingSchema).max(2000),
  tokens: z.array(tokenSchema).max(200),
  rolls: z.array(rollSchema).max(MAX_TOTAL_ROLLS),
  notes: z.array(noteSchema).max(MAX_TABLE_NOTES),
});
export const tableSchema = tableDataSchema.superRefine((state, context) => {
  const ids = new Set<string>();
  for (const object of [...state.tokens, ...state.drawings, ...state.notes]) {
    if (ids.has(object.id))
      context.addIssue({
        code: "custom",
        message: "Scene object IDs must be unique.",
      });
    ids.add(object.id);
  }
  const rollIds = new Set<string>();
  const audiences = new Map<string, number>();
  for (const roll of state.rolls) {
    if (rollIds.has(roll.id))
      context.addIssue({
        code: "custom",
        message: "Roll IDs must be unique.",
        path: ["rolls"],
      });
    rollIds.add(roll.id);
    const key = roll.visibility === "public" ? "public" : roll.ownerId!;
    const count = (audiences.get(key) ?? 0) + 1;
    if (count > MAX_ROLL_HISTORY)
      context.addIssue({
        code: "custom",
        message: "Roll history exceeds an audience limit.",
        path: ["rolls"],
      });
    audiences.set(key, count);
  }
});
export type TableState = z.infer<typeof tableSchema>;
// Public wire state has no global revision: that counter would reveal private activity.
export const tableViewSchema = tableDataSchema.omit({ revision: true }).extend({
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TableView = z.infer<typeof tableViewSchema>;
export const createTable = (): TableState => ({
  schemaVersion: 5,
  revision: 0,
  systemId: "cyberpunk-red",
  drawings: [],
  tokens: [],
  rolls: [],
  notes: [],
});

const legacyDrawingSchema = drawingSchema.omit({ version: true }).strict();
const legacyTokenSchema = tokenSchema.omit({ version: true }).strict();
const version4TableSchema = tableDataSchema
  .extend({
    schemaVersion: z.literal(4),
    drawings: z.array(legacyDrawingSchema).max(2000),
    tokens: z.array(legacyTokenSchema).max(200),
  })
  .strict();
const version3TableSchema = version4TableSchema
  .omit({ notes: true })
  .extend({ schemaVersion: z.literal(3) })
  .strict();
const version2TableSchema = version3TableSchema.extend({
  schemaVersion: z.literal(2),
  rolls: z.array(diceResultSchema.strict()).max(100),
});
const version1TableSchema = version2TableSchema.extend({
  schemaVersion: z.literal(1),
  drawings: z.array(drawingInputSchema).max(2000),
  tokens: z.array(tokenInputSchema).max(200),
});

/** Known legacy saves gain edit versions without guessing ownership or changing content. */
export function restoreTable(value: unknown): {
  state: TableState;
  migrated: boolean;
} {
  const current = tableSchema.safeParse(value);
  if (current.success) return { state: current.data, migrated: false };
  const legacy = z
    .union([
      version1TableSchema,
      version2TableSchema,
      version3TableSchema,
      version4TableSchema,
    ])
    .parse(value);
  const state = tableSchema.parse({
    ...legacy,
    schemaVersion: 5,
    notes: legacy.schemaVersion === 4 ? legacy.notes : [],
    drawings: legacy.drawings.map((drawing) => ({
      ...drawing,
      ownerId: "ownerId" in drawing ? drawing.ownerId : null,
      version: 1,
    })),
    tokens: legacy.tokens.map((token) => ({
      ...token,
      ownerId: "ownerId" in token ? token.ownerId : null,
      version: 1,
    })),
    rolls:
      legacy.schemaVersion >= 3
        ? legacy.rolls
        : legacy.rolls.map((roll) => ({
            ...roll,
            ownerId: null,
            visibility: "public",
          })),
  });
  return { state, migrated: true };
}

const envelope = { id: z.uuid() };
export const commandSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...envelope,
      type: z.literal("scene.undo"),
      historyId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("scene.redo"),
      historyId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("drawing.add"),
      drawing: drawingInputSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("token.add"),
      token: tokenInputSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("token.move"),
      expectedVersion: z.number().int().positive(),
      tokenId: z.uuid(),
      position: pointSchema,
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("object.delete"),
      expectedVersion: z.number().int().positive(),
      objectId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("object.assign"),
      expectedVersion: z.number().int().positive(),
      objectId: z.uuid(),
      expectedOwnerId: z.uuid().nullable(),
      ownerId: z.uuid(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("dice.roll"),
      expression: z.string().trim().min(1).max(32),
      visibility: rollVisibilitySchema.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("system.set"),
      systemId: systemIdSchema,
    })
    .strict(),
  z
    .object({ ...envelope, type: z.literal("note.add"), note: noteInputSchema })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("note.update"),
      noteId: z.uuid(),
      expectedVersion: z.number().int().positive(),
      changes: noteInputSchema.omit({ id: true }).strict(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("note.delete"),
      noteId: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      type: z.literal("note.assign"),
      noteId: z.uuid(),
      expectedVersion: z.number().int().positive(),
      ownerId: z.uuid(),
      acknowledgePrivateAccess: z.literal(true).optional(),
    })
    .strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const clientCommandSchema = z
  .object({ context: commandContextSchema, command: commandSchema })
  .strict();
export type CommandInput = Command extends infer C
  ? C extends Command
    ? Omit<C, "id">
    : never
  : never;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    history: sceneHistorySchema,
    state: tableViewSchema,
    context: commandContextSchema,
    campaignName: z.string().min(1).max(120),
    sceneName: z.string().min(1).max(120),
    participants: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("presence"),
    participants: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("ack"), commandId: z.uuid() }).strict(),
  z
    .object({
      type: z.literal("error"),
      commandId: z.uuid().optional(),
      message: z.string().max(500),
    })
    .strict(),
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
