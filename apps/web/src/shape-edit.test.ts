import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  createTable,
  restoreTable,
  shapeStyleOf,
} from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand, projectTable } from "@tableloom/core/server";
import { shapeEditCommand, fillOpacityPercent } from "./shape-edit.js";
import { hitDrawing } from "./scene-selection.js";
test("shape drafts validate line/fill bounds, preserve captured versions and old styles, and picking follows visible line thickness", () => {
  const member: Member = {
      id: randomUUID(),
      tableId: randomUUID(),
      name: "Editor",
      role: "player",
    },
    input = {
      id: randomUUID(),
      kind: "rectangle",
      color: "#405f4d",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 80 },
      ],
    },
    state = applyCommand(
      createTable(),
      commandSchema.parse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: input,
      }),
      member,
    ),
    drawing = state.drawings[0]!,
    view = projectTable(state, member);
  assert.deepEqual(shapeStyleOf(drawing), {
    lineWidth: 3,
    fill: { color: drawing.color, opacity: 0.07 },
  });
  assert.equal(
    shapeEditCommand(
      drawing,
      view,
      member,
      drawing.color,
      "3",
      true,
      drawing.color,
      "7",
    ),
    null,
  );
  assert.equal(fillOpacityPercent(0.29), "29");
  for (const opacity of [
    ...Array.from({ length: 100 }, (_, i) => (i + 1) / 100),
    0.01234567890123456,
    0.9999999999999999,
    0.10000000000000002,
  ]) {
    const precise = {
        ...drawing,
        shapeStyle: { lineWidth: 3, fill: { color: drawing.color, opacity } },
      },
      current = { ...view, drawings: [precise] },
      percent = fillOpacityPercent(opacity);
    assert.equal(
      shapeEditCommand(
        precise,
        current,
        member,
        drawing.color,
        "3",
        true,
        drawing.color,
        percent,
      ),
      null,
    );
    const update = shapeEditCommand(
      precise,
      current,
      member,
      "#abcdef",
      "3",
      true,
      drawing.color,
      percent,
    )!;
    assert.equal(update.type, "drawing.style.update");
    if (update.type === "drawing.style.update")
      assert.equal(update.changes.shapeStyle.fill!.opacity, opacity);
  }
  const command = shapeEditCommand(
    drawing,
    view,
    member,
    "#ab1234",
    "12.5",
    true,
    "#627d9c",
    "35",
  )!;
  assert.equal(command.type, "drawing.style.update");
  if (command.type !== "drawing.style.update")
    throw new Error("Wrong command kind.");
  assert.equal(command.expectedVersion, 1);
  const after = applyCommand(
    state,
    commandSchema.parse({ ...command, id: randomUUID() }),
    member,
  );
  assert.deepEqual(after.drawings[0]!.shapeStyle, {
    lineWidth: 12.5,
    fill: { color: "#627d9c", opacity: 0.35 },
  });
  assert.deepEqual(after.drawings[0]!.points, drawing.points);
  assert.equal(
    shapeEditCommand(
      drawing,
      projectTable(after, member),
      member,
      "#123456",
      "2",
      false,
      "#123456",
      "0",
    ),
    null,
  );
  for (const [width, opacity] of [
    ["0", "35"],
    ["33", "35"],
    ["Infinity", "35"],
    ["3", "0"],
    ["3", "101"],
    ["3", "bad"],
  ])
    assert.equal(
      shapeEditCommand(
        drawing,
        view,
        member,
        "#123456",
        width!,
        true,
        "#123456",
        opacity!,
      ),
      null,
    );
  assert.equal(
    shapeEditCommand(
      drawing,
      view,
      { ...member, id: randomUUID() },
      "#123456",
      "2",
      false,
      "#123456",
      "0",
    ),
    null,
  );
  assert.equal(
    shapeEditCommand(
      drawing,
      { ...view, drawings: [] },
      member,
      "#123456",
      "2",
      false,
      "#123456",
      "0",
    ),
    null,
  );
  const stroke = applyCommand(
    createTable(),
    commandSchema.parse({
      id: randomUUID(),
      type: "drawing.add",
      drawing: {
        ...input,
        id: randomUUID(),
        kind: "stroke",
        shapeStyle: { lineWidth: 32, fill: null },
      },
    }),
    member,
  ).drawings[0]!;
  assert.ok(hitDrawing(stroke, { x: 50, y: 55 }, 0));
  assert.ok(!hitDrawing(stroke, { x: 50, y: 65 }, 0));
  assert.throws(() =>
    commandSchema.parse({
      id: randomUUID(),
      type: "drawing.add",
      drawing: {
        ...input,
        kind: "stroke",
        shapeStyle: { lineWidth: 3, fill: { color: "#123456", opacity: 1 } },
      },
    }),
  );
  assert.throws(() =>
    commandSchema.parse({
      id: randomUUID(),
      type: "drawing.add",
      drawing: {
        ...input,
        kind: "text",
        text: "Wrong style kind",
        textStyle: { font: "monospace", weight: "normal", align: "left" },
        shapeStyle: { lineWidth: 3, fill: null },
      },
    }),
  );
  const old = { ...state, schemaVersion: 8 };
  assert.deepEqual(restoreTable(old).state, state);
  assert.throws(() => restoreTable({ ...old, drawings: after.drawings }));
});
