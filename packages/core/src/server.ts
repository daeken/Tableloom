import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  MAX_ROLL_HISTORY,
  MAX_TOTAL_ROLLS,
  MAX_TABLE_NOTES,
  parseDice,
  tableViewSchema,
} from "./index.js";
import type {
  Command,
  DiceResult,
  Roll,
  TableState,
  TableView,
} from "./index.js";
import type { Member } from "./access.js";
import { authorizeCommand, canSeeRoll, canSeeNote } from "./permissions.js";

export function rollDice(
  expression: string,
  actor: string,
  random: (min: number, max: number) => number = randomInt,
): DiceResult {
  const { count, sides, modifier } = parseDice(expression);
  const dice = Array.from({ length: count }, () => random(1, sides + 1));
  return {
    id: randomUUID(),
    actor,
    expression: `${count}d${sides}${modifier ? ` ${modifier > 0 ? "+" : "-"} ${Math.abs(modifier)}` : ""}`,
    dice,
    sides,
    modifier,
    total: dice.reduce((sum, value) => sum + value, modifier),
    at: new Date().toISOString(),
  };
}

/** Every outbound table payload must pass through this per-member projection. */
export function projectTable(state: TableState, member: Member): TableView {
  const visible = {
    schemaVersion: state.schemaVersion,
    systemId: state.systemId,
    drawings: state.drawings,
    tokens: state.tokens,
    rolls: state.rolls.filter((roll) => canSeeRoll(member, roll)),
    notes: state.notes.filter((note) => canSeeNote(member, note)),
  };
  const version = createHash("sha256")
    .update(JSON.stringify(visible))
    .digest("hex");
  return tableViewSchema.parse({ ...visible, version });
}

function appendRoll(history: Roll[], roll: Roll): Roll[] {
  const sameAudience = (other: Roll) =>
    other.visibility === roll.visibility &&
    (roll.visibility === "public" || other.ownerId === roll.ownerId);
  const bucket = history.filter(sameAudience);
  const evicted = bucket.length >= MAX_ROLL_HISTORY ? bucket[0]?.id : undefined;
  const retained = history.filter((other) => other.id !== evicted);
  if (retained.length >= MAX_TOTAL_ROLLS)
    throw new Error(
      "The table has reached its roll history limit. Archive or delete live results to make room.",
    );
  return [...retained, roll];
}

export function applyCommand(
  state: TableState,
  command: Command,
  actor: Member,
  ownershipRecipient?: Member | null,
): TableState {
  authorizeCommand(state, command, actor);
  // Membership is resolved by the server at command time, never from wire data.
  if (command.type === "object.assign" || command.type === "note.assign") {
    if (
      !ownershipRecipient ||
      ownershipRecipient.id !== command.ownerId ||
      ownershipRecipient.tableId !== actor.tableId
    )
      throw new Error(
        "Choose a current member of this table as the new owner.",
      );
  }
  const next = structuredClone(state);
  switch (command.type) {
    case "scene.undo":
    case "scene.redo":
      throw new Error("Move history actions must be resolved by the server.");
    case "object.assign": {
      const object = [...next.tokens, ...next.drawings].find(
        (object) => object.id === command.objectId,
      )!;
      object.ownerId = command.ownerId;
      object.version += 1;
      break;
    }
    case "note.assign": {
      const note = next.notes.find((note) => note.id === command.noteId)!;
      note.ownerId = command.ownerId;
      note.version += 1;
      break;
    }
    case "drawing.add":
      if (next.drawings.length >= 2000)
        throw new Error("This scene has reached its drawing limit.");
      if (
        next.drawings.some((d) => d.id === command.drawing.id) ||
        next.tokens.some((t) => t.id === command.drawing.id) ||
        next.notes.some((n) => n.id === command.drawing.id)
      )
        throw new Error("An object with this ID already exists.");
      next.drawings.push({ ...command.drawing, ownerId: actor.id, version: 1 });
      break;
    case "token.add":
      if (next.tokens.length >= 200)
        throw new Error("This scene has reached its token limit.");
      if (
        next.tokens.some((t) => t.id === command.token.id) ||
        next.drawings.some((d) => d.id === command.token.id) ||
        next.notes.some((n) => n.id === command.token.id)
      )
        throw new Error("An object with this ID already exists.");
      next.tokens.push({ ...command.token, ownerId: actor.id, version: 1 });
      break;
    case "token.move": {
      const token = next.tokens.find((t) => t.id === command.tokenId);
      if (!token) throw new Error("That token no longer exists.");
      token.position = command.position;
      token.version += 1;
      break;
    }
    case "object.delete":
      next.tokens = next.tokens.filter((t) => t.id !== command.objectId);
      next.drawings = next.drawings.filter((d) => d.id !== command.objectId);
      break;
    case "system.set":
      next.systemId = command.systemId;
      break;
    case "dice.roll":
      next.rolls = appendRoll(next.rolls, {
        ...rollDice(command.expression, actor.name),
        ownerId: actor.id,
        visibility: command.visibility ?? "public",
      });
      break;
    case "note.add":
      if (next.notes.length >= MAX_TABLE_NOTES)
        throw new Error("The table has reached its note limit.");
      if (
        [...next.notes, ...next.tokens, ...next.drawings].some(
          (object) => object.id === command.note.id,
        )
      )
        throw new Error("An object with this ID already exists.");
      next.notes.push({ ...command.note, ownerId: actor.id, version: 1 });
      break;
    case "note.update": {
      const note = next.notes.find((note) => note.id === command.noteId)!;
      note.title = command.changes.title;
      note.body = command.changes.body;
      note.visibility = command.changes.visibility;
      note.version += 1;
      break;
    }
    case "note.delete":
      next.notes = next.notes.filter((note) => note.id !== command.noteId);
      break;
  }
  next.revision += 1;
  return next;
}
