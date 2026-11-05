import type { NudgeDirection } from "./keyboard-objects.js";
import type { Tool } from "./Tabletop.js";
export const toolKeys: Record<Tool, string> = {
  select: "V",
  hand: "H",
  measure: "M",
  pen: "P",
  rectangle: "R",
  text: "T",
  token: "O",
  erase: "E",
};
export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  keyCode: number;
  defaultPrevented: boolean;
}
export interface ShortcutScope {
  focused: boolean;
  dialogOpen: boolean;
  enabled: boolean;
  gesture: boolean;
  pending: boolean;
  editableSelection: boolean;
  undoAvailable: boolean;
  redoAvailable: boolean;
}
export type TabletopShortcut =
  | { type: "nudge"; direction: NudgeDirection; large: boolean }
  | { type: "tool"; tool: Tool }
  | { type: "history"; direction: "undo" | "redo" }
  | {
      type:
        | "snap"
        | "cancel"
        | "clear"
        | "help"
        | "delete-review"
        | "zoom-in"
        | "zoom-out"
        | "zoom-reset"
        | "objects"
        | "create"
        | "position"
        | "blocked";
    };
/** Return null to preserve native editing/browser keys outside the focused battlefield. */
export function tabletopShortcut(
  key: ShortcutKey,
  scope: ShortcutScope,
): TabletopShortcut | null {
  if (
    !scope.focused ||
    scope.dialogOpen ||
    key.defaultPrevented ||
    key.isComposing ||
    key.keyCode === 229 ||
    key.altKey ||
    (key.ctrlKey && key.metaKey)
  )
    return null;
  let action: TabletopShortcut | null = null;
  if (key.ctrlKey || key.metaKey) {
    if (key.key.toLowerCase() === "z")
      action = { type: "history", direction: key.shiftKey ? "redo" : "undo" };
    else if (key.ctrlKey && !key.shiftKey && key.key.toLowerCase() === "y")
      action = { type: "history", direction: "redo" };
  } else if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key.key)
  ) {
    if (!scope.editableSelection) return null;
    const direction = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    }[key.key] as NudgeDirection;
    action = { type: "nudge", direction, large: key.shiftKey };
  } else if (key.key === "?") action = { type: "help" };
  else if (!key.shiftKey) {
    const tool = (Object.keys(toolKeys) as Tool[]).find(
      (tool) => toolKeys[tool].toLowerCase() === key.key.toLowerCase(),
    );
    if (tool) action = { type: "tool", tool };
    else if (key.key === "Escape")
      action = { type: scope.gesture ? "cancel" : "clear" };
    else if (key.key.toLowerCase() === "g") action = { type: "position" };
    else if (key.key.toLowerCase() === "n") action = { type: "create" };
    else if (key.key.toLowerCase() === "l") action = { type: "objects" };
    else if (key.key.toLowerCase() === "s") action = { type: "snap" };
    else if (key.key === "Delete" || key.key === "Backspace")
      action = { type: "delete-review" };
    else if (key.key === "=" || key.key === "+") action = { type: "zoom-in" };
    else if (key.key === "-") action = { type: "zoom-out" };
    else if (key.key === "0") action = { type: "zoom-reset" };
  } else if (key.key === "+") action = { type: "zoom-in" };
  if (!action) return null;
  if (key.repeat) return { type: "blocked" };
  if (scope.gesture && action.type !== "cancel") return { type: "blocked" };
  if (
    action.type === "help" ||
    action.type === "cancel" ||
    action.type === "clear"
  )
    return action;
  if (!scope.enabled) return { type: "blocked" };
  if (
    (action.type === "delete-review" ||
      action.type === "nudge" ||
      action.type === "create" ||
      action.type === "position") &&
    (scope.pending || (action.type !== "create" && !scope.editableSelection))
  )
    return { type: "blocked" };
  if (
    action.type === "history" &&
    (scope.pending ||
      !(action.direction === "undo"
        ? scope.undoAvailable
        : scope.redoAvailable))
  )
    return { type: "blocked" };
  return action;
}
