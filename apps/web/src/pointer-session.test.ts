import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandInput } from "@tableloom/core";
import { PointerSession, withinTap } from "./pointer-session.js";
const down = (pointerId: number, isPrimary = true, button = 0) => ({
  pointerId,
  isPrimary,
  button,
});
test("only the owning pointer can read or release the exact captured command; duplicate/foreign releases are inert", () => {
  const session = new PointerSession<CommandInput>(),
    command: CommandInput = {
      type: "object.delete",
      objectId: crypto.randomUUID(),
      expectedVersion: 7,
    };
  assert.equal(session.begin(down(1), "erase:0"), true);
  session.update(command);
  assert.equal(session.read(2), null);
  assert.equal(session.finish(2, "erase:0"), null);
  assert.deepEqual(session.read(1), command);
  assert.deepEqual(session.finish(1, "erase:0"), { value: command });
  assert.equal(session.finish(1, "erase:0"), null);
  assert.equal(session.active, false);
});
test("a second contact anywhere cancels and cannot become owner until all tracked contacts are released", () => {
  for (const kind of [
    "draw",
    "move",
    "resize",
    "pan",
    "marquee",
    "measure",
    "token",
    "erase",
    "text",
  ]) {
    const session = new PointerSession<{ kind: string }>();
    session.begin(down(11), "scope");
    session.update({ kind });
    assert.equal(session.observeDown(22), true);
    assert.equal(session.read(11), null);
    assert.equal(session.begin(down(22, false), "scope"), false);
    assert.equal(session.finish(11, "scope"), null);
    assert.equal(session.begin(down(33), "scope"), false);
    assert.equal(session.finish(22, "scope"), null);
    assert.equal(session.finish(33, "scope"), null);
    assert.equal(session.active, false);
    assert.equal(session.begin(down(44), "scope"), true);
    session.update({ kind });
    assert.deepEqual(session.finish(44, "scope"), { value: { kind } });
  }
});
test("cancelled capture, tool/grid changes, reset and secondary/nonprimary presses never expose a commit", () => {
  const session = new PointerSession<string>();
  assert.equal(session.begin(down(1, true, 2), "scope"), false);
  assert.equal(session.active, false);
  assert.equal(session.begin(down(2, false), "scope"), false);
  session.update("forbidden");
  assert.equal(session.finish(2, "scope"), null);
  session.begin(down(3), "old");
  session.update("old geometry");
  assert.equal(session.finish(3, "new"), null);
  session.begin(down(4), "scope");
  session.update("preview");
  session.cancel();
  assert.equal(session.tracks(4), true);
  assert.equal(session.begin(down(4), "scope"), false);
  assert.equal(session.finish(4, "scope"), null);
  assert.equal(session.tracks(4), false);
  session.begin(down(5), "scope");
  session.update("preview");
  session.reset();
  assert.equal(session.finish(5, "scope"), null);
  session.update("late update");
  assert.equal(session.read(5), null);
  assert.equal(session.begin(down(6), "scope"), true);
});
test("gesture values are synchronous within one event batch and taps use a bounded screen-space tolerance", () => {
  const session = new PointerSession<{ x: number }>();
  session.begin(down(1), "scope");
  session.update({ x: 1 });
  session.update({ x: 2 });
  assert.deepEqual(session.finish(1, "scope"), { value: { x: 2 } });
  for (const scale of [0.25, 1, 3]) {
    assert.equal(
      withinTap({ x: 0, y: 0 }, { x: 8 / scale, y: 0 }, scale),
      true,
    );
    assert.equal(
      withinTap({ x: 0, y: 0 }, { x: 8.01 / scale, y: 0 }, scale),
      false,
    );
  }
});
