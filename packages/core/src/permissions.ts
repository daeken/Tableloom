import type { Member } from "./access.js";
import type { Command, Roll, TableState } from "./index.js";

export function canSeeRoll(member: Member, roll: Roll): boolean {
  return (
    roll.visibility === "public" ||
    member.role === "gm" ||
    roll.ownerId === member.id
  );
}

export function canEditObject(
  member: Member | null,
  object: { ownerId: string | null },
): boolean {
  return (
    member !== null && (member.role === "gm" || object.ownerId === member.id)
  );
}

/** This is a UI hint too; the server must always enforce it on mutations. */
export function authorizeCommand(
  state: TableState,
  command: Command,
  member: Member,
): void {
  switch (command.type) {
    case "system.set":
      if (member.role !== "gm")
        throw new Error("Only the GM can change the game system.");
      return;
    case "token.move": {
      const token = state.tokens.find((token) => token.id === command.tokenId);
      if (!token) throw new Error("That token no longer exists.");
      if (!canEditObject(member, token))
        throw new Error("Only the owner or GM can move this token.");
      return;
    }
    case "object.delete": {
      const object =
        state.tokens.find((token) => token.id === command.objectId) ??
        state.drawings.find((drawing) => drawing.id === command.objectId);
      if (!object) throw new Error("That object no longer exists.");
      if (!canEditObject(member, object))
        throw new Error("Only the owner or GM can delete this object.");
      return;
    }
    case "drawing.add":
    case "token.add":
    case "dice.roll":
      return;
    default: {
      const unhandled: never = command;
      throw new Error(`Unsupported command: ${String(unhandled)}`);
    }
  }
}
