import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createTable,
  commandSchema,
  tokenLayersOf,
  layeredTokens,
} from "@tableloom/core";
import type { Token, Drawing } from "@tableloom/core";
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
        type: "token.add",
        token: {
          id: randomUUID(),
          name: "Scout",
          color: "#123456",
          position: { x: 50, y: 50 },
        },
      }),
      member,
    );
  const view = projectTable(state, member),
    review = captureSceneOrder(view.tokens[0]!, view),
    command = sceneLayerCommand(review, view, member, "above-drawings")!;
  assert.equal(command.type, "token.layer.update");
  assert.equal(
    sceneLayerCommand(review, view, member, "between-drawings"),
    null,
  );
  const changed = applyCommand(
      state,
      commandSchema.parse({ ...command, id: randomUUID() }),
      member,
    ),
    changedView = projectTable(changed, member),
    upper = captureSceneOrder(changedView.tokens[0]!, changedView);
  assert.deepEqual(sceneOrderIds(upper), [review.object.id]);
  assert.equal(sceneOrderCommand(upper, changedView, member, "front"), null);
  assert.equal(sceneOrderCommand(upper, changedView, member, "back"), null);
  assert.equal(sceneOrderCurrent(review, changedView, member), false);
  const peerChanged = {
    ...changedView,
    tokens: changedView.tokens.map((d, i) =>
      i === 1 ? { ...d, layer: "above-drawings" as const, version: 2 } : d,
    ),
  };
  assert.equal(sceneOrderCurrent(upper, peerChanged, member), false);
  assert.equal(
    sceneLayerCommand(upper, peerChanged, member, "between-drawings"),
    null,
  );
  const unrelated = {
    ...changedView,
    tokens: changedView.tokens.map((d, i) =>
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
      { ...changedView, tokens: [...changedView.tokens].reverse() },
      member,
      "back",
    ),
    null,
  );
  assert.deepEqual(tokenLayersOf(changed.tokens), [
    "above-drawings",
    "between-drawings",
    "between-drawings",
  ]);
  assert.deepEqual(
    layeredTokens(changed.tokens).map((d) => d.id),
    [changed.tokens[1]!.id, changed.tokens[2]!.id, changed.tokens[0]!.id],
  );
  const max = Array.from({ length: 200 }, () => randomUUID()),
    large = {
      ...command,
      id: randomUUID(),
      expectedOrder: max,
      expectedLayers: max.map(() => "between-drawings"),
    };
  assert.equal(commandSchema.safeParse(large).success, true);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 256 * 1024);
  assert.equal(
    commandSchema.safeParse({
      ...large,
      expectedOrder: [...max, randomUUID()],
      expectedLayers: [...large.expectedLayers, "between-drawings"],
    }).success,
    false,
  );
});

test("picking and visible token ordering place top tokens before upper drawings and ordinary tokens, preserving read-only occlusion", () => {
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
  const label: Drawing = {
    ...room,
    id: randomUUID(),
    kind: "text",
    text: "Gate",
    textStyle: { font: "serif", weight: "bold", align: "center" },
    layer: "above-tokens",
  };
  const middle: Token = {
    id: randomUUID(),
    name: "Scout",
    position: { x: 50, y: 50 },
    radius: 24,
    color: "#abcdef",
    ownerId,
    version: 1,
  };
  const top: Token = {
    ...middle,
    id: randomUUID(),
    name: "Highlight",
    layer: "above-drawings",
  };
  const view = { drawings: [room, label], tokens: [top, middle] };
  assert.equal(pickSceneObject(view, { x: 50, y: 50 }, 3)?.id, top.id);
  assert.equal(
    pickSceneObject(
      { ...view, tokens: [{ ...top, ownerId: randomUUID() }, middle] },
      { x: 50, y: 50 },
      3,
    )?.id,
    top.id,
  );
  assert.equal(
    pickSceneObject({ ...view, tokens: [middle] }, { x: 50, y: 50 }, 3)?.id,
    label.id,
  );
  assert.equal(
    pickSceneObject({ drawings: [room], tokens: [middle] }, { x: 50, y: 50 }, 3)
      ?.id,
    middle.id,
  );
  assert.equal(
    pickSceneObject({ drawings: [room], tokens: [] }, { x: 50, y: 50 }, 3),
    undefined,
  ); // Lower-room marquee behavior stays intact.
  const another: Token = { ...top, id: randomUUID() };
  assert.equal(
    pickSceneObject(
      { ...view, tokens: [top, middle, another] },
      { x: 50, y: 50 },
      3,
    )?.id,
    another.id,
  );
  assert.equal(
    pickSceneObject(
      { ...view, tokens: [another, middle, top] },
      { x: 50, y: 50 },
      3,
    )?.id,
    top.id,
  );
  assert.deepEqual(
    layeredTokens([top, middle, another]).map((token) => token.id),
    [middle.id, top.id, another.id],
  );
  const review = captureSceneOrder(top, {
    ...createTable(),
    ...view,
    version: "a".repeat(64),
  });
  assert.equal(
    sceneLayerCommand(
      review,
      { ...createTable(), ...view, version: "a".repeat(64) },
      { id: ownerId, tableId: randomUUID(), name: "Editor", role: "player" },
      "above-tokens",
    ),
    null,
  );
});
