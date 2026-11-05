import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema, createTable } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand, projectTable } from "@tableloom/core/server";
import {
  captureDrawingOrder,
  drawingOrderCurrent,
  drawingOrderCommand,
} from "./drawing-order.js";
test("drawing stack reviews freeze identity/version/order, survive unrelated edits and bound full-stack command input", () => {
  const member: Member = {
    id: randomUUID(),
    tableId: randomUUID(),
    name: "Editor",
    role: "player",
  };
  let state = createTable();
  for (let i = 0; i < 3; i++)
    state = applyCommand(
      state,
      commandSchema.parse({
        id: randomUUID(),
        type: "drawing.add",
        drawing: {
          id: randomUUID(),
          kind: "rectangle",
          color: "#123456",
          points: [
            { x: i, y: i },
            { x: i + 20, y: i + 20 },
          ],
        },
      }),
      member,
    );
  const view = projectTable(state, member),
    review = captureDrawingOrder(view.drawings[1]!, view),
    command = drawingOrderCommand(review, view, member, "front")!;
  assert.equal(command.type, "drawing.reorder");
  if (command.type !== "drawing.reorder") throw new Error("Wrong command.");
  assert.deepEqual(
    command.expectedOrder,
    state.drawings.map((d) => d.id),
  );
  const changed = applyCommand(
    state,
    commandSchema.parse({ ...command, id: randomUUID() }),
    member,
  );
  assert.equal(
    drawingOrderCommand(review, projectTable(changed, member), member, "back"),
    null,
  );
  assert.equal(
    drawingOrderCurrent(
      review,
      { ...view, drawings: [...view.drawings].reverse() },
      member,
    ),
    false,
  );
  assert.equal(
    drawingOrderCurrent(
      review,
      { ...view, drawings: view.drawings.slice(1) },
      member,
    ),
    false,
  );
  assert.equal(
    drawingOrderCurrent(review, view, { ...member, id: randomUUID() }),
    false,
  );
  assert.equal(drawingOrderCurrent(review, view, null), false);
  const unrelated = {
    ...view,
    drawings: view.drawings.map((d, i) =>
      i === 0 ? { ...d, color: "#abcdef", version: d.version + 1 } : d,
    ),
  };
  assert.equal(drawingOrderCurrent(review, unrelated, member), true);
  const front = captureDrawingOrder(view.drawings.at(-1)!, view);
  assert.equal(drawingOrderCommand(front, view, member, "front"), null);
  for (const extra of [
    { expectedOrder: [review.drawing.id, review.drawing.id] },
    { direction: "middle" },
    { ownerId: member.id },
  ])
    assert.throws(() =>
      commandSchema.parse({ ...command, id: randomUUID(), ...extra }),
    );
  const max = Array.from({ length: 2000 }, () => randomUUID());
  assert.ok(
    commandSchema.safeParse({
      ...command,
      id: randomUUID(),
      expectedOrder: max,
    }).success,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify({ ...command, expectedOrder: max })) <
      256 * 1024,
  );
  assert.equal(
    commandSchema.safeParse({
      ...command,
      id: randomUUID(),
      expectedOrder: [...max, randomUUID()],
    }).success,
    false,
  );
});
