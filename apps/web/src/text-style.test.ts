import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  commandSchema,
  createTable,
  restoreTable,
  DEFAULT_TEXT_STYLE,
  tableSchema,
} from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand, projectTable } from "@tableloom/core/server";
import { textPlacement } from "./text-placement.js";
import { textEditCommand } from "./text-edit.js";
test("text style inputs are finite allowlists and legacy table-7 text gains only former rendering defaults; style-only drafts capture versions", () => {
  const member: Member = {
      id: randomUUID(),
      tableId: randomUUID(),
      name: "Editor",
      role: "player",
    },
    input = textPlacement(
      "North gate\nShort",
      { x: 0, y: 0 },
      "#123456",
      randomUUID(),
    ),
    state = applyCommand(
      createTable(),
      commandSchema.parse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: input,
      }),
      member,
    ),
    drawing = state.drawings[0]!;
  assert.deepEqual(drawing.textStyle, DEFAULT_TEXT_STYLE);
  const view = projectTable(state, member);
  for (const font of ["monospace", "sans-serif", "serif"] as const)
    for (const weight of ["normal", "bold"] as const)
      for (const align of ["left", "center", "right"] as const) {
        const textStyle = { font, weight, align },
          command = textEditCommand(
            drawing,
            view,
            member,
            drawing.text!,
            drawing.color,
            textStyle,
          );
        if (font === "monospace" && weight === "normal" && align === "left")
          assert.equal(command, null);
        else {
          assert.ok(command);
          assert.deepEqual(
            applyCommand(
              state,
              commandSchema.parse({ ...command, id: randomUUID() }),
              member,
            ).drawings[0]!.textStyle,
            textStyle,
          );
        }
      }
  assert.equal(
    textEditCommand(
      drawing,
      view,
      { ...member, id: randomUUID() },
      drawing.text!,
      drawing.color,
      { font: "serif", weight: "bold", align: "right" },
    ),
    null,
  );
  const old = structuredClone(state);
  const legacy: Record<string, unknown> = {
    ...old,
    schemaVersion: 7,
    drawings: old.drawings.map(({ textStyle, ...d }) => d),
  };
  assert.deepEqual(restoreTable(legacy).state, state);
  assert.ok(restoreTable(legacy).migrated);
  assert.throws(() => restoreTable({ ...legacy, drawings: state.drawings }));
  assert.equal(
    tableSchema.safeParse({ ...state, drawings: legacy.drawings }).success,
    false,
  );
  for (const invalid of [
    { font: "https://example.invalid/font", weight: "normal", align: "left" },
    { font: "serif", weight: 700, align: "left" },
    { font: "serif", weight: "bold", align: "justify" },
    { ...DEFAULT_TEXT_STYLE, css: "bad" },
  ])
    assert.throws(() =>
      commandSchema.parse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: { ...input, textStyle: invalid },
      }),
    );
  assert.throws(() =>
    commandSchema.parse({
      id: randomUUID(),
      type: "drawing.add",
      drawing: { ...input, kind: "rectangle", text: undefined },
    }),
  );
  const omitted = { ...input };
  delete omitted.textStyle;
  assert.deepEqual(
    applyCommand(
      createTable(),
      commandSchema.parse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: omitted,
      }),
      member,
    ).drawings[0]!.textStyle,
    DEFAULT_TEXT_STYLE,
  );
});
