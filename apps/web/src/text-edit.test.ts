import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createTable } from "@tableloom/core";
import { projectTable, applyCommand } from "@tableloom/core/server";
import { commandSchema } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { textPlacement } from "./text-placement.js";
import { textEditCommand } from "./text-edit.js";
test("text drafts target captured versions, survive unrelated snapshots and fail closed after remote movement, transfer, deletion or lost access", () => {
  const member: Member = {
      id: randomUUID(),
      tableId: randomUUID(),
      role: "player",
      name: "Player",
    },
    other: Member = { ...member, id: randomUUID() },
    state = applyCommand(
      createTable(),
      commandSchema.parse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: textPlacement(
          "Original",
          { x: 0, y: 0 },
          "#123456",
          randomUUID(),
        ),
      }),
      member,
    ),
    captured = structuredClone(state.drawings[0]!),
    view = projectTable(state, member);
  assert.equal(
    textEditCommand(captured, view, member, captured.text!, captured.color),
    null,
  );
  assert.equal(
    textEditCommand(captured, view, member, "  ", captured.color),
    null,
  );
  assert.equal(
    textEditCommand(captured, view, other, "Draft", captured.color),
    null,
  );
  assert.equal(
    textEditCommand(captured, view, null, "Draft", captured.color),
    null,
  );
  const draft = "Reviewed\n<em>literal</em>",
    command = textEditCommand(captured, view, member, draft, "#abcdef")!;
  assert.deepEqual(command, {
    type: "drawing.text.update",
    drawingId: captured.id,
    expectedVersion: 1,
    changes: { text: draft, color: "#abcdef" },
  });
  const unrelated = {
    ...view,
    tokens: [
      {
        id: randomUUID(),
        name: "Scout",
        color: "#123456",
        position: { x: 2, y: 3 },
        radius: 24,
        version: 1,
        ownerId: other.id,
      },
    ],
  };
  assert.deepEqual(
    textEditCommand(captured, unrelated, member, draft, "#abcdef"),
    command,
  );
  for (const drawings of [
    [],
    [{ ...captured, version: 2 }],
    [{ ...captured, ownerId: other.id, version: 2 }],
  ])
    assert.equal(
      textEditCommand(
        captured,
        { ...view, drawings },
        member,
        draft,
        "#abcdef",
      ),
      null,
    );
  assert.equal(captured.text, "Original");
  assert.equal(draft, "Reviewed\n<em>literal</em>");
  const latest = applyCommand(
    state,
    commandSchema.parse({ ...command, id: randomUUID() }),
    member,
  );
  assert.equal(
    textEditCommand(
      captured,
      projectTable(latest, member),
      member,
      "Old draft",
      "#abcdef",
    ),
    null,
  );
  assert.deepEqual(
    textEditCommand(
      latest.drawings[0]!,
      projectTable(latest, member),
      member,
      "Fresh review",
      "#abcdef",
    ),
    {
      type: "drawing.text.update",
      drawingId: captured.id,
      expectedVersion: 2,
      changes: { text: "Fresh review", color: "#abcdef" },
    },
  );
});
