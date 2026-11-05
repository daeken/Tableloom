import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GRID } from "@tableloom/core/scene-grid";
import { gridDraft, gridReviewCurrent } from "./grid-review.js";
const member = {
    id: crypto.randomUUID(),
    name: "GM",
    tableId: crypto.randomUUID(),
    role: "gm" as const,
  },
  context = {
    campaignId: member.tableId,
    sceneId: crypto.randomUUID(),
    generation: 1,
  },
  grid = { version: 0, settings: structuredClone(DEFAULT_GRID) },
  review = structuredClone({ context, grid });
test("grid review keeps captured values and blocks peer saves, context generations and lost GM access without blocking unrelated scene edits", () => {
  assert.equal(gridReviewCurrent(review, context, grid, member), true);
  for (const next of [
    { ...grid, version: 1 },
    { ...grid, settings: { ...grid.settings, visible: false } },
  ])
    assert.equal(gridReviewCurrent(review, context, next, member), false);
  for (const next of [
    { ...context, generation: 2 },
    { ...context, sceneId: crypto.randomUUID() },
    { ...context, campaignId: crypto.randomUUID() },
  ])
    assert.equal(gridReviewCurrent(review, next, grid, member), false);
  assert.equal(
    gridReviewCurrent(review, context, grid, { ...member, role: "player" }),
    false,
  );
  assert.equal(gridReviewCurrent(review, context, grid, null), false);
  assert.equal(
    gridReviewCurrent(review, context, grid, {
      ...member,
      tableId: crypto.randomUUID(),
    }),
    false,
  );
  assert.deepEqual(gridDraft(review, "80.5", "-12.25", "33.75", false), {
    context,
    expectedVersion: 0,
    settings: {
      spacing: 80.5,
      origin: { x: -12.25, y: 33.75 },
      visible: false,
    },
  });
  assert.deepEqual(review, { context, grid });
  assert.equal(gridDraft(review, "60", "0", "0", true), null);
  for (const values of [
    ["", "0", "0"],
    ["10", " ", "0"],
    ["NaN", "0", "0"],
    ["Infinity", "0", "0"],
    ["501", "0", "0"],
    ["80", "10001", "0"],
  ])
    assert.equal(
      gridDraft(review, values[0]!, values[1]!, values[2]!, true),
      null,
    );
});
