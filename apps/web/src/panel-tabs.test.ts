import { test } from "node:test";
import assert from "node:assert/strict";
import {
  panelTabDestination,
  panelTabs,
  type PanelTabKey,
} from "./panel-tabs.js";
const key = (key: string, changes: Partial<PanelTabKey> = {}): PanelTabKey => ({
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
test("horizontal panel focus wraps through every tab and supports first/last without selecting panels", () => {
  for (let index = 0; index < panelTabs.length; index++) {
    const current = panelTabs[index]!;
    assert.equal(
      panelTabDestination(current, key("ArrowRight")),
      panelTabs[(index + 1) % panelTabs.length],
    );
    assert.equal(
      panelTabDestination(current, key("ArrowLeft")),
      panelTabs[(index + panelTabs.length - 1) % panelTabs.length],
    );
    assert.equal(panelTabDestination(current, key("Home")), "rolls");
    assert.equal(panelTabDestination(current, key("End")), "chat");
  }
});
test("panel focus navigation preserves native activation, tabbing, vertical scroll, modifiers and input composition", () => {
  for (const value of [
    "Enter",
    " ",
    "Tab",
    "ArrowUp",
    "ArrowDown",
    "Escape",
    "Delete",
    "n",
  ])
    assert.equal(panelTabDestination("notes", key(value)), null);
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
      assert.equal(panelTabDestination("rolls", key(value, changes)), null);
});
