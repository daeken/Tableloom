import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { commandSchema, createTable } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand, projectTable } from "@tableloom/core/server";
import {
  captureSceneOrder,
  sceneOrderCurrent,
  sceneOrderCommand,
} from "./scene-order.js";
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
    review = captureSceneOrder(view.drawings[1]!, view),
    command = sceneOrderCommand(review, view, member, "front")!;
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
    sceneOrderCommand(review, projectTable(changed, member), member, "back"),
    null,
  );
  assert.equal(
    sceneOrderCurrent(
      review,
      { ...view, drawings: [...view.drawings].reverse() },
      member,
    ),
    false,
  );
  assert.equal(
    sceneOrderCurrent(
      review,
      { ...view, drawings: view.drawings.slice(1) },
      member,
    ),
    false,
  );
  assert.equal(
    sceneOrderCurrent(review, view, { ...member, id: randomUUID() }),
    false,
  );
  assert.equal(sceneOrderCurrent(review, view, null), false);
  const unrelated = {
    ...view,
    drawings: view.drawings.map((d, i) =>
      i === 0 ? { ...d, color: "#abcdef", version: d.version + 1 } : d,
    ),
  };
  assert.equal(sceneOrderCurrent(review, unrelated, member), true);
  const front = captureSceneOrder(view.drawings.at(-1)!, view);
  assert.equal(sceneOrderCommand(front, view, member, "front"), null);
  for (const extra of [
    { expectedOrder: [review.object.id, review.object.id] },
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
      expectedLayers: max.map(() => "below-tokens"),
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
      expectedLayers: [...max, randomUUID()].map(() => "below-tokens"),
    }).success,
    false,
  );
});

test("token stack reviews freeze identity/version/order, survive unrelated edits and bound full-stack command input", () => {
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
        type: "token.add",
        token: {
          id: randomUUID(),
          name: "Scout",
          color: "#123456",
          position: { x: i + 100, y: i + 100 },
        },
      }),
      member,
    );
  const view = projectTable(state, member),
    review = captureSceneOrder(view.tokens[1]!, view),
    command = sceneOrderCommand(review, view, member, "front")!;
  assert.equal(command.type, "token.reorder");
  if (command.type !== "token.reorder") throw new Error("Wrong command.");
  assert.deepEqual(
    command.expectedOrder,
    state.tokens.map((d) => d.id),
  );
  const changed = applyCommand(
    state,
    commandSchema.parse({ ...command, id: randomUUID() }),
    member,
  );
  assert.equal(
    sceneOrderCommand(review, projectTable(changed, member), member, "back"),
    null,
  );
  assert.equal(
    sceneOrderCurrent(
      review,
      { ...view, tokens: [...view.tokens].reverse() },
      member,
    ),
    false,
  );
  assert.equal(
    sceneOrderCurrent(
      review,
      { ...view, tokens: view.tokens.slice(1) },
      member,
    ),
    false,
  );
  assert.equal(
    sceneOrderCurrent(review, view, { ...member, id: randomUUID() }),
    false,
  );
  assert.equal(sceneOrderCurrent(review, view, null), false);
  const unrelated = {
    ...view,
    tokens: view.tokens.map((d, i) =>
      i === 0 ? { ...d, color: "#abcdef", version: d.version + 1 } : d,
    ),
  };
  assert.equal(sceneOrderCurrent(review, unrelated, member), true);
  const front = captureSceneOrder(view.tokens.at(-1)!, view);
  assert.equal(sceneOrderCommand(front, view, member, "front"), null);
  for (const extra of [
    { expectedOrder: [review.object.id, review.object.id] },
    { direction: "middle" },
    { ownerId: member.id },
  ])
    assert.throws(() =>
      commandSchema.parse({ ...command, id: randomUUID(), ...extra }),
    );
  const max = Array.from({ length: 200 }, () => randomUUID());
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
