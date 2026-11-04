import { randomInt, randomUUID } from "node:crypto";
import { parseDice } from "./index.js";
import type { Command, Roll, TableState } from "./index.js";

export function rollDice(
  expression: string,
  actor: string,
  random: (min: number, max: number) => number = randomInt,
): Roll {
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

export function applyCommand(
  state: TableState,
  command: Command,
  actor: string,
): TableState {
  const next = structuredClone(state);
  switch (command.type) {
    case "drawing.add":
      if (next.drawings.length >= 2000)
        throw new Error("This scene has reached its drawing limit.");
      if (next.drawings.some((d) => d.id === command.drawing.id))
        throw new Error("Drawing already exists.");
      next.drawings.push(command.drawing);
      break;
    case "token.add":
      if (next.tokens.length >= 200)
        throw new Error("This scene has reached its token limit.");
      if (next.tokens.some((t) => t.id === command.token.id))
        throw new Error("Token already exists.");
      next.tokens.push(command.token);
      break;
    case "token.move": {
      const token = next.tokens.find((t) => t.id === command.tokenId);
      if (!token) throw new Error("That token no longer exists.");
      token.position = command.position;
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
      next.rolls = [...next.rolls, rollDice(command.expression, actor)].slice(
        -100,
      );
      break;
  }
  next.revision += 1;
  return next;
}
