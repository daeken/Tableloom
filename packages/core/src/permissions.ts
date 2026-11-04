import type { Member } from "./access.js";
import type { Command, Roll, TableState } from "./index.js";

export function canSeeRoll(
  member: Member,
  roll: Pick<Roll, "visibility" | "ownerId">,
): boolean {
  return (
    roll.visibility === "public" ||
    member.role === "gm" ||
    roll.ownerId === member.id
  );
}
export const canSeeNote = canSeeRoll;

export function canManageRoll(
  member: Member,
  roll: Pick<Roll, "visibility" | "ownerId">,
): boolean {
  return (
    member.role === "gm" ||
    (roll.visibility === "gm" && roll.ownerId === member.id)
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
    case "scene.undo":
    case "scene.redo":
      throw new Error("Move history actions must be resolved by the server.");
    case "object.assign": {
      if (member.role !== "gm")
        throw new Error("Only the GM can reassign ownership.");
      const object = [...state.tokens, ...state.drawings].find(
        (object) => object.id === command.objectId,
      );
      if (!object) throw new Error("That object no longer exists.");
      if (object.version !== command.expectedVersion)
        throw new Error(
          "This object changed. Review the latest scene before transferring it.",
        );
      if (object.ownerId !== command.expectedOwnerId)
        throw new Error(
          "Ownership changed. Review the latest owner before transferring.",
        );
      if (object.ownerId === command.ownerId)
        throw new Error("This member already owns that object.");
      return;
    }
    case "note.assign": {
      if (member.role !== "gm")
        throw new Error("Only the GM can reassign ownership.");
      const note = state.notes.find((note) => note.id === command.noteId);
      if (!note) throw new Error("That note is unavailable.");
      if (note.version !== command.expectedVersion)
        throw new Error("This note changed. Review it before transferring.");
      if (note.ownerId === command.ownerId)
        throw new Error("This member already owns that note.");
      if (note.visibility === "gm" && command.acknowledgePrivateAccess !== true)
        throw new Error(
          "Confirm that this private note will be shared with its new owner and removed from the previous owner's view.",
        );
      return;
    }
    case "system.set":
      if (member.role !== "gm")
        throw new Error("Only the GM can change the game system.");
      return;
    case "token.move": {
      const token = state.tokens.find((token) => token.id === command.tokenId);
      if (!token) throw new Error("That token no longer exists.");
      if (!canEditObject(member, token))
        throw new Error("Only the owner or GM can move this token.");
      if (token.version !== command.expectedVersion)
        throw new Error(
          "This token changed. Review its latest position before moving it again.",
        );
      return;
    }
    case "object.delete": {
      const object =
        state.tokens.find((token) => token.id === command.objectId) ??
        state.drawings.find((drawing) => drawing.id === command.objectId);
      if (!object) throw new Error("That object no longer exists.");
      if (!canEditObject(member, object))
        throw new Error("Only the owner or GM can delete this object.");
      if (object.version !== command.expectedVersion)
        throw new Error(
          "This object changed. Review the latest scene before deleting it.",
        );
      return;
    }
    case "drawing.add":
    case "token.add":
    case "dice.roll":
    case "note.add":
      return;
    case "note.update":
    case "note.delete": {
      const note = state.notes.find((note) => note.id === command.noteId);
      if (!note || !canSeeNote(member, note))
        throw new Error("That note is unavailable.");
      if (!canEditObject(member, note))
        throw new Error("Only the owner or GM can change this note.");
      if (note.version !== command.expectedVersion)
        throw new Error("This note changed. Reload it before saving.");
      return;
    }
    default: {
      const unhandled: never = command;
      throw new Error(`Unsupported command: ${String(unhandled)}`);
    }
  }
}
