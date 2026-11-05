import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSchema, DEFAULT_TEXT_STYLE } from "@tableloom/core";
import {
  creationAvailable,
  objectCreationCommand,
  type CreationDraft,
} from "./object-creation.js";

const id = "00000000-0000-4000-8000-000000000001";
const draft = (changes: Partial<CreationDraft> = {}): CreationDraft => ({
  kind: "token",
  x: "-20.5",
  y: "40",
  width: "120",
  height: "60",
  name: " Scout ",
  text: "<b>Gate</b>\nNorth",
  color: "#567890",
  textStyle: { ...DEFAULT_TEXT_STYLE },
  ...changes,
});
test("coordinate creation emits existing validated neutral commands without caller ownership or view/snap transforms", () => {
  assert.deepEqual(objectCreationCommand(draft(), id), {
    type: "token.add",
    token: {
      id,
      name: "Scout",
      position: { x: -20.5, y: 40 },
      color: "#567890",
    },
  });
  const room = objectCreationCommand(draft({ kind: "rectangle" }), id);
  assert.deepEqual(room, {
    type: "drawing.add",
    drawing: {
      id,
      kind: "rectangle",
      points: [
        { x: -20.5, y: 40 },
        { x: 99.5, y: 100 },
      ],
      color: "#567890",
    },
  });
  const label = objectCreationCommand(
    draft({
      kind: "text",
      textStyle: { font: "serif", weight: "bold", align: "right" },
    }),
    id,
  );
  assert.equal(label.type, "drawing.add");
  if (label.type === "drawing.add") {
    assert.equal(label.drawing.text, "<b>Gate</b>\nNorth");
    assert.deepEqual(label.drawing.textStyle, {
      font: "serif",
      weight: "bold",
      align: "right",
    });
    assert.deepEqual(label.drawing.points[0], { x: -20.5, y: 40 });
  }
  for (const kind of ["token", "rectangle", "text"] as const)
    assert.equal(
      commandSchema.safeParse({
        ...objectCreationCommand(draft({ kind }), id),
        id: crypto.randomUUID(),
      }).success,
      true,
    );
});
test("empty, nonfinite, out-of-range and invalid content drafts cannot produce commands", () => {
  for (const value of ["", " ", "Infinity", "NaN", "10001", "-10001"])
    for (const key of ["x", "y"] as const)
      assert.throws(() => objectCreationCommand(draft({ [key]: value }), id));
  for (const name of [" ", "x".repeat(33)])
    assert.throws(() => objectCreationCommand(draft({ name }), id));
  for (const text of [
    " ",
    "a\t",
    "x".repeat(501),
    Array(21).fill("a").join("\n"),
  ])
    assert.throws(() =>
      objectCreationCommand(draft({ kind: "text", text }), id),
    );
  assert.throws(() => objectCreationCommand(draft({ color: "red" }), id));
  assert.throws(() => objectCreationCommand(draft(), "bad-id"));
});
test("room and label creation reject overflow instead of silently clamping entered geometry", () => {
  for (const value of ["", "0", "-1", "Infinity", "20001"])
    for (const key of ["width", "height"] as const)
      assert.throws(() =>
        objectCreationCommand(draft({ kind: "rectangle", [key]: value }), id),
      );
  assert.throws(() =>
    objectCreationCommand(
      draft({ kind: "rectangle", x: "9999", width: "2" }),
      id,
    ),
  );
  assert.throws(() =>
    objectCreationCommand(draft({ kind: "text", x: "10000" }), id),
  );
  assert.throws(() =>
    objectCreationCommand(draft({ kind: "text", y: "10000" }), id),
  );
  assert.doesNotThrow(() =>
    objectCreationCommand(
      draft({
        kind: "rectangle",
        x: "-10000",
        y: "-10000",
        width: "20000",
        height: "20000",
      }),
      id,
    ),
  );
});
test("creation is blocked at live scene capacity or while offline/pending, independently for tokens and drawings", () => {
  const empty = { tokens: [], drawings: [] };
  for (const kind of ["token", "rectangle", "text"] as const) {
    assert.equal(creationAvailable(kind, empty, true, false), true);
    assert.equal(creationAvailable(kind, empty, false, false), false);
    assert.equal(creationAvailable(kind, empty, true, true), false);
  }
  // Only lengths matter; fixture arrays contain no fabricated persisted objects.
  const tokens = Array<never>(200),
    drawings = Array<never>(2000);
  assert.equal(
    creationAvailable("token", { tokens, drawings: [] }, true, false),
    false,
  );
  assert.equal(
    creationAvailable("text", { tokens, drawings: [] }, true, false),
    true,
  );
  assert.equal(
    creationAvailable("token", { tokens: [], drawings }, true, false),
    true,
  );
  for (const kind of ["text", "rectangle"] as const)
    assert.equal(
      creationAvailable(kind, { tokens: [], drawings }, true, false),
      false,
    );
});
