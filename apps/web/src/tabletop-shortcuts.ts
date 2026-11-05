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
  canDeleteSelection: boolean;
  undoAvailable: boolean;
  redoAvailable: boolean;
}
export type TabletopShortcut =
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
  } else if (key.key === "?") action = { type: "help" };
  else if (!key.shiftKey) {
    const tool = (Object.keys(toolKeys) as Tool[]).find(
      (tool) => toolKeys[tool].toLowerCase() === key.key.toLowerCase(),
    );
    if (tool) action = { type: "tool", tool };
    else if (key.key === "Escape")
      action = { type: scope.gesture ? "cancel" : "clear" };
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
    action.type === "delete-review" &&
    (scope.pending || !scope.canDeleteSelection)
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
