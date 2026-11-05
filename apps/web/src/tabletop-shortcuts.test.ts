import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema } from "@tableloom/core";
import {
  tabletopShortcut,
  toolKeys,
  type ShortcutKey,
  type ShortcutScope,
} from "./tabletop-shortcuts.js";
import { sceneHistoryCommand } from "./scene-history-command.js";
import type { SceneHistory } from "@tableloom/core/scene-history";
const key = (
  value: string,
  changes: Partial<ShortcutKey> = {},
): ShortcutKey => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  keyCode: 0,
  defaultPrevented: false,
  ...changes,
});
const scope = (changes: Partial<ShortcutScope> = {}): ShortcutScope => ({
  focused: true,
  dialogOpen: false,
  enabled: true,
  gesture: false,
  pending: false,
  canDeleteSelection: true,
  undoAvailable: true,
  redoAvailable: true,
  ...changes,
});
test("battlefield tool/local keys map explicitly, preserve browser modifiers, and consume held keys without repeating actions", () => {
  for (const [tool, value] of Object.entries(toolKeys)) {
    for (const letter of [value, value.toLowerCase()])
      assert.deepEqual(tabletopShortcut(key(letter), scope()), {
        type: "tool",
        tool,
      });
    assert.equal(
      tabletopShortcut(key(value, { shiftKey: true }), scope()),
      null,
    );
    assert.deepEqual(tabletopShortcut(key(value, { repeat: true }), scope()), {
      type: "blocked",
    });
  }
  for (const [value, type] of [
    ["s", "snap"],
    ["+", "zoom-in"],
    ["=", "zoom-in"],
    ["-", "zoom-out"],
    ["0", "zoom-reset"],
    ["?", "help"],
    ["Escape", "clear"],
    ["Delete", "delete-review"],
    ["Backspace", "delete-review"],
  ])
    assert.deepEqual(tabletopShortcut(key(value!), scope()), { type });
  assert.deepEqual(tabletopShortcut(key("+", { shiftKey: true }), scope()), {
    type: "zoom-in",
  });
  assert.deepEqual(tabletopShortcut(key("?", { shiftKey: true }), scope()), {
    type: "help",
  });
  for (const value of ["a", "ArrowLeft", "Enter", "Tab", "F5"])
    assert.equal(tabletopShortcut(key(value), scope()), null);
  for (const value of ["+", "-", "0", "r", "t", "w", "y"])
    assert.equal(
      tabletopShortcut(key(value, { metaKey: true }), scope()),
      null,
    );
  for (const value of ["r", "t", "w", "+", "-"])
    assert.equal(
      tabletopShortcut(key(value, { ctrlKey: true }), scope()),
      null,
    );
});
test("input/control focus, dialogs, IME/default handlers and AltGraph/modifier combinations retain their native keys", () => {
  for (const value of ["v", "s", "Delete", "Backspace", "Escape", "?", "z"]) {
    const event = key(value, { ctrlKey: value === "z" });
    for (const blocked of [{ focused: false }, { dialogOpen: true }])
      assert.equal(tabletopShortcut(event, scope(blocked)), null);
    for (const blocked of [
      { isComposing: true },
      { keyCode: 229 },
      { defaultPrevented: true },
      { altKey: true },
      { ctrlKey: true, metaKey: true },
    ])
      assert.equal(tabletopShortcut({ ...event, ...blocked }, scope()), null);
  }
});
test("gestures, pending edits, unavailable history and invalid selections block persistent shortcuts; Escape remains local and deletion always requests review", () => {
  for (const value of ["v", "s", "Delete", "+", "?", "z"]) {
    const event = key(value, { ctrlKey: value === "z" });
    assert.deepEqual(tabletopShortcut(event, scope({ gesture: true })), {
      type: "blocked",
    });
  }
  assert.deepEqual(tabletopShortcut(key("Escape"), scope({ gesture: true })), {
    type: "cancel",
  });
  for (const value of ["Delete", "Backspace"]) {
    assert.deepEqual(tabletopShortcut(key(value), scope({ pending: true })), {
      type: "blocked",
    });
    assert.deepEqual(
      tabletopShortcut(key(value), scope({ canDeleteSelection: false })),
      { type: "blocked" },
    );
    assert.deepEqual(tabletopShortcut(key(value), scope()), {
      type: "delete-review",
    });
  }
  for (const changes of [
    { pending: true },
    { enabled: false },
    { undoAvailable: false },
  ])
    assert.deepEqual(
      tabletopShortcut(key("z", { ctrlKey: true }), scope(changes)),
      { type: "blocked" },
    );
  assert.deepEqual(
    tabletopShortcut(
      key("z", { metaKey: true, shiftKey: true }),
      scope({ redoAvailable: false }),
    ),
    { type: "blocked" },
  );
  assert.deepEqual(
    tabletopShortcut(key("Escape"), scope({ pending: true, enabled: false })),
    { type: "clear" },
  );
  assert.deepEqual(tabletopShortcut(key("?"), scope({ enabled: false })), {
    type: "help",
  });
  assert.deepEqual(tabletopShortcut(key("p"), scope({ pending: true })), {
    type: "tool",
    tool: "pen",
  });
});
test("keyboard history uses the same available current cursor/version as buttons and never constructs stale, blocked or pending inverses", () => {
  const edge = {
      id: crypto.randomUUID(),
      version: 7,
      objectId: crypto.randomUUID(),
      objectCount: 1,
      action: "move" as const,
      objectType: "token" as const,
      name: "Scout",
      available: true,
    },
    history: SceneHistory = {
      undo: edge,
      redo: { ...edge, id: crypto.randomUUID(), version: 9 },
    };
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.deepEqual(tabletopShortcut(key("z", modifiers), scope()), {
      type: "history",
      direction: "undo",
    });
    assert.deepEqual(
      tabletopShortcut(key("Z", { ...modifiers, shiftKey: true }), scope()),
      { type: "history", direction: "redo" },
    );
  }
  assert.deepEqual(tabletopShortcut(key("y", { ctrlKey: true }), scope()), {
    type: "history",
    direction: "redo",
  });
  for (const direction of ["undo", "redo"] as const) {
    const command = sceneHistoryCommand(history, direction, true, false)!;
    assert.deepEqual(command, {
      type: `scene.${direction}`,
      historyId: history[direction]!.id,
      expectedVersion: history[direction]!.version,
    });
    assert.equal(
      commandSchema.safeParse({ ...command, id: crypto.randomUUID() }).success,
      true,
    );
    assert.equal(sceneHistoryCommand(history, direction, false, false), null);
    assert.equal(sceneHistoryCommand(history, direction, true, true), null);
    assert.equal(sceneHistoryCommand(null, direction, true, false), null);
    assert.equal(
      sceneHistoryCommand(
        { ...history, [direction]: { ...edge, available: false } },
        direction,
        true,
        false,
      ),
      null,
    );
  }
});
