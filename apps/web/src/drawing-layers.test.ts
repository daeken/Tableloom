import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createTable,
  commandSchema,
  drawingLayersOf,
  layeredDrawings,
} from "@tableloom/core";
import type { Drawing } from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
import { applyCommand, projectTable } from "@tableloom/core/server";
import {
  captureSceneOrder,
  sceneLayerCommand,
  sceneOrderCommand,
  sceneOrderCurrent,
  sceneOrderIds,
} from "./scene-order.js";
import { pickSceneObject } from "./scene-selection.js";

test("layer reviews freeze the full layer stack, guard no-ops and same-layer edges, and preserve unrelated token/content changes", () => {
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
            { x: 0, y: 0 },
            { x: 100, y: 100 },
          ],
        },
      }),
      member,
    );
  const view = projectTable(state, member),
    review = captureSceneOrder(view.drawings[0]!, view),
    command = sceneLayerCommand(review, view, member, "above-tokens")!;
  assert.equal(command.type, "drawing.layer.update");
  assert.equal(sceneLayerCommand(review, view, member, "below-tokens"), null);
  const changed = applyCommand(
      state,
      commandSchema.parse({ ...command, id: randomUUID() }),
      member,
    ),
    changedView = projectTable(changed, member),
    upper = captureSceneOrder(changedView.drawings[0]!, changedView);
  assert.deepEqual(sceneOrderIds(upper), [review.object.id]);
  assert.equal(sceneOrderCommand(upper, changedView, member, "front"), null);
  assert.equal(sceneOrderCommand(upper, changedView, member, "back"), null);
  assert.equal(sceneOrderCurrent(review, changedView, member), false);
  const peerChanged = {
    ...changedView,
    drawings: changedView.drawings.map((d, i) =>
      i === 1 ? { ...d, layer: "above-tokens" as const, version: 2 } : d,
    ),
  };
  assert.equal(sceneOrderCurrent(upper, peerChanged, member), false);
  assert.equal(
    sceneLayerCommand(upper, peerChanged, member, "below-tokens"),
    null,
  );
  const unrelated = {
    ...changedView,
    drawings: changedView.drawings.map((d, i) =>
      i === 1 ? { ...d, color: "#abcdef", version: 2 } : d,
    ),
  };
  assert.equal(sceneOrderCurrent(upper, unrelated, member), true);
  assert.equal(sceneOrderCurrent(upper, changedView, null), false);
  assert.equal(
    sceneOrderCurrent(upper, changedView, { ...member, id: randomUUID() }),
    false,
  );
  assert.equal(
    sceneOrderCommand(
      upper,
      { ...changedView, drawings: [...changedView.drawings].reverse() },
      member,
      "back",
    ),
    null,
  );
  assert.deepEqual(drawingLayersOf(changed.drawings), [
    "above-tokens",
    "below-tokens",
    "below-tokens",
  ]);
  assert.deepEqual(
    layeredDrawings(changed.drawings).map((d) => d.id),
    [changed.drawings[1]!.id, changed.drawings[2]!.id, changed.drawings[0]!.id],
  );
  const max = Array.from({ length: 2000 }, () => randomUUID()),
    large = {
      ...command,
      id: randomUUID(),
      expectedOrder: max,
      expectedLayers: max.map(() => "below-tokens"),
    };
  assert.equal(commandSchema.safeParse(large).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 256 * 1024);
  assert.equal(
    commandSchema.safeParse({
      ...large,
      expectedOrder: [...max, randomUUID()],
      expectedLayers: [...large.expectedLayers, "below-tokens"],
    }).success,
    false,
  );
});

test("picking follows upper drawings, tokens and lower drawings, including filled upper interiors and read-only occlusion", () => {
  const ownerId = randomUUID(),
    points = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ];
  const room: Drawing = {
    id: randomUUID(),
    kind: "rectangle",
    points,
    color: "#123456",
    ownerId,
    version: 1,
  };
  const token = {
    id: randomUUID(),
    name: "Scout",
    position: { x: 50, y: 50 },
    radius: 24,
    color: "#abcdef",
    ownerId,
    version: 1,
  };
  const lower = { drawings: [room], tokens: [token] };
  assert.equal(pickSceneObject(lower, { x: 50, y: 50 }, 3)?.id, token.id);
  assert.equal(pickSceneObject(lower, { x: 0, y: 50 }, 3)?.id, room.id);
  const upper = {
    drawings: [{ ...room, layer: "above-tokens" as const }],
    tokens: [token],
  };
  assert.equal(pickSceneObject(upper, { x: 50, y: 50 }, 3)?.id, room.id);
  // Ownership is deliberately not filtered here: another member's visible shape still covers a token.
  assert.equal(
    pickSceneObject(
      {
        drawings: [{ ...upper.drawings[0]!, ownerId: randomUUID() }],
        tokens: [token],
      },
      { x: 50, y: 50 },
      3,
    )?.id,
    room.id,
  );
  const open = {
    ...upper,
    drawings: [
      { ...upper.drawings[0]!, shapeStyle: { lineWidth: 3, fill: null } },
    ],
  };
  assert.equal(pickSceneObject(open, { x: 50, y: 50 }, 3)?.id, token.id);
  assert.equal(pickSceneObject(open, { x: 0, y: 50 }, 3)?.id, room.id);
  const text: Drawing = {
    ...room,
    id: randomUUID(),
    kind: "text",
    text: "Gate",
    textStyle: { font: "serif", weight: "bold", align: "center" },
    layer: "above-tokens",
  };
  assert.equal(
    pickSceneObject(
      { drawings: [...upper.drawings, text], tokens: [token] },
      { x: 50, y: 50 },
      3,
    )?.id,
    text.id,
  );
  assert.equal(
    pickSceneObject(
      { drawings: [text, ...upper.drawings], tokens: [token] },
      { x: 50, y: 50 },
      3,
    )?.id,
    room.id,
  );
  assert.equal(pickSceneObject(upper, { x: 200, y: 200 }, 3), undefined);
  assert.equal(
    pickSceneObject(
      {
        drawings: [
          {
            ...upper.drawings[0]!,
            points: [
              { x: 0, y: 0 },
              { x: 500, y: 500 },
              { x: 100, y: 100 },
            ],
          },
        ],
        tokens: [],
      },
      { x: 300, y: 300 },
      3,
    ),
    undefined,
  );
});
