import { test } from "node:test";
import assert from "node:assert/strict";
import type { Token, Drawing } from "@tableloom/core";
import {
  selectionDelta,
  translateObject,
  hitDrawing,
  objectsInBox,
  selectObjects,
} from "./scene-selection.js";
const token = (x: number, y: number): Token => ({
  id: crypto.randomUUID(),
  name: "Scout",
  position: { x, y },
  color: "#405f4d",
  ownerId: crypto.randomUUID(),
  version: 7,
});
const drawing = (
  kind: "stroke" | "rectangle",
  points: Drawing["points"],
): Drawing => ({
  id: crypto.randomUUID(),
  kind,
  points,
  color: "#405f4d",
  ownerId: crypto.randomUUID(),
  version: 4,
});
test("mixed translations clamp every geometry point together and preserve shape, owner, versions and spacing", () => {
  const objects = [
      token(9990, -9970),
      drawing("stroke", [
        { x: 9900, y: -9980 },
        { x: 9950, y: -9990 },
      ]),
    ],
    delta = selectionDelta(objects, { x: 100, y: -100 });
  assert.deepEqual(delta, { x: 10, y: -10 });
  const moved = objects.map((object) => translateObject(object, delta));
  assert.deepEqual(moved[0], {
    ...objects[0],
    position: { x: 10000, y: -9980 },
  });
  assert.deepEqual(moved[1], {
    ...objects[1],
    points: [
      { x: 9910, y: -9990 },
      { x: 9960, y: -10000 },
    ],
  });
  assert.deepEqual(selectionDelta([], delta), { x: 0, y: 0 });
  assert.deepEqual((objects[1] as Drawing).points, [
    { x: 9900, y: -9980 },
    { x: 9950, y: -9990 },
  ]);
});
test("drawing hit tests use segments, handle coincident/reversed points, and leave room interiors for marquee", () => {
  const stroke = drawing("stroke", [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ]);
  assert.ok(hitDrawing(stroke, { x: 50, y: 3 }, 4));
  assert.ok(!hitDrawing(stroke, { x: 50, y: 6 }, 4));
  assert.ok(
    hitDrawing(
      drawing("stroke", [
        { x: 10, y: 10 },
        { x: 10, y: 10 },
      ]),
      { x: 12, y: 10 },
      3,
    ),
  );
  const room = drawing("rectangle", [
    { x: 100, y: 100 },
    { x: 0, y: 0 },
  ]);
  assert.ok(hitDrawing(room, { x: 50, y: 0 }, 3));
  assert.ok(!hitDrawing(room, { x: 50, y: 50 }, 3));
  assert.ok(!hitDrawing(room, { x: 110, y: 110 }, 3));
});
test("mixed marquee selects token centers and fully enclosed drawing bounds, with a shared unique 100-object cap", () => {
  const scout = token(10, 10),
    stroke = drawing("stroke", [
      { x: 20, y: 20 },
      { x: 40, y: 50 },
    ]),
    room = drawing("rectangle", [
      { x: -100, y: -100 },
      { x: 100, y: 100 },
    ]);
  assert.deepEqual(
    objectsInBox([scout, stroke, room], { x: 60, y: 60 }, { x: 0, y: 0 }),
    [scout.id, stroke.id],
  );
  assert.deepEqual(
    objectsInBox([stroke], { x: 30, y: 30 }, { x: 60, y: 60 }),
    [],
  );
  assert.deepEqual(selectObjects([scout.id], [scout.id, stroke.id]), [
    scout.id,
    stroke.id,
  ]);
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
  assert.equal(selectObjects(ids, [room.id]), null);
});

test("deletion review freezes targets and blocks remote versions, ownership changes, removals and lost permissions", async () => {
  const { captureDeletionReview, deletionReviewCurrent } =
    await import("./scene-selection.js");
  const scout = token(10, 10),
    room = drawing("rectangle", [
      { x: 0, y: 0 },
      { x: 20, y: 20 },
    ]);
  room.ownerId = scout.ownerId;
  const member = {
      id: scout.ownerId!,
      name: "Player",
      role: "player" as const,
      tableId: crypto.randomUUID(),
    },
    state = { tokens: [scout], drawings: [room] },
    review = captureDeletionReview([scout, room]);
  assert.equal(deletionReviewCurrent(review, state, member), true);
  assert.equal(review.length, 2);
  assert.ok(!JSON.stringify(review).includes("points"));
  assert.equal(
    deletionReviewCurrent(
      review,
      { ...state, tokens: [{ ...scout, version: 2 }] },
      member,
    ),
    false,
  );
  assert.equal(
    deletionReviewCurrent(
      review,
      { ...state, drawings: [{ ...room, ownerId: crypto.randomUUID() }] },
      member,
    ),
    false,
  );
  assert.equal(
    deletionReviewCurrent(review, { ...state, drawings: [] }, member),
    false,
  );
  assert.equal(review.length, 2);
  assert.equal(deletionReviewCurrent(review, state, null), false);
  assert.equal(
    deletionReviewCurrent(review, state, {
      ...member,
      id: crypto.randomUUID(),
    }),
    false,
  );
  assert.equal(deletionReviewCurrent([], state, member), false);
  assert.equal(
    deletionReviewCurrent([review[0]!, review[0]!], state, member),
    false,
  );
  assert.equal(
    deletionReviewCurrent(
      review,
      { ...state, tokens: [scout, token(50, 50)] },
      member,
    ),
    true,
  );
});
