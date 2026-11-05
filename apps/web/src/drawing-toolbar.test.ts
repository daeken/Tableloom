import { test } from "node:test";
import assert from "node:assert/strict";
import { drawingToolbarItems } from "./drawing-toolbar.js";
import {
  horizontalFocusTarget,
  type FocusNavigationKey,
} from "./focus-navigation.js";
const key = (
  key: string,
  changes: Partial<FocusNavigationKey> = {},
): FocusNavigationKey => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 0,
  defaultPrevented: false,
  ...changes,
});
test("toolbar focus crosses tool/color groups and wraps without selecting a tool or color", () => {
  assert.equal(new Set(drawingToolbarItems).size, drawingToolbarItems.length);
  for (let index = 0; index < drawingToolbarItems.length; index++) {
    const current = drawingToolbarItems[index]!;
    assert.equal(
      horizontalFocusTarget(drawingToolbarItems, current, key("ArrowRight")),
      drawingToolbarItems[(index + 1) % drawingToolbarItems.length],
    );
    assert.equal(
      horizontalFocusTarget(drawingToolbarItems, current, key("ArrowLeft")),
      drawingToolbarItems[
        (index + drawingToolbarItems.length - 1) % drawingToolbarItems.length
      ],
    );
    assert.equal(
      horizontalFocusTarget(drawingToolbarItems, current, key("Home")),
      "tool:select",
    );
    assert.equal(
      horizontalFocusTarget(drawingToolbarItems, current, key("End")),
      "color:#8c6c9c",
    );
  }
  assert.equal(horizontalFocusTarget([], "missing", key("ArrowRight")), null);
  assert.equal(horizontalFocusTarget(["known"], "missing", key("Home")), null);
});
test("toolbar navigation preserves native activation, leaving/returning, vertical scrolling, shortcuts and composing input", () => {
  for (const value of [
    "Tab",
    "Enter",
    " ",
    "ArrowUp",
    "ArrowDown",
    "Escape",
    "Delete",
    "n",
    "z",
  ])
    assert.equal(
      horizontalFocusTarget(drawingToolbarItems, "tool:select", key(value)),
      null,
    );
  for (const value of ["ArrowLeft", "ArrowRight", "Home", "End"])
    for (const changes of [
      { ctrlKey: true },
      { metaKey: true },
      { altKey: true },
      { shiftKey: true },
      { isComposing: true },
      { keyCode: 229 },
      { defaultPrevented: true },
    ])
      assert.equal(
        horizontalFocusTarget(
          drawingToolbarItems,
          "tool:select",
          key(value, changes),
        ),
        null,
      );
});
