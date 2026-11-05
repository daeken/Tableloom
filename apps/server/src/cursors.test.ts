import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cursorUpdateSchema,
  cursorsMessageSchema,
  CURSOR_TTL_MS,
} from "@tableloom/core";
import { CursorStore } from "./cursors.js";
import {
  DEFAULT_CAMPAIGN_ID,
  DEFAULT_SCENE_ID,
} from "@tableloom/core/campaigns";
const context = {
    campaignId: DEFAULT_CAMPAIGN_ID,
    sceneId: DEFAULT_SCENE_ID,
    generation: 1,
  },
  member = {
    id: crypto.randomUUID(),
    name: "Player",
    role: "player" as const,
    tableId: context.campaignId,
  };
test("cursor boundaries validate world/context limits and reject identity spoofing, duplicates, oversized and secret fields", () => {
  const input = {
    type: "cursor.update",
    context,
    position: { x: -10000, y: 10000 },
  };
  assert.equal(cursorUpdateSchema.safeParse(input).success, true);
  assert.equal(
    cursorUpdateSchema.safeParse({ ...input, position: null }).success,
    true,
  );
  for (const changes of [
    { memberId: crypto.randomUUID() },
    { name: "Spoof" },
    { position: { x: Infinity, y: 0 } },
    { position: { x: 0, y: 10001 } },
    { position: { x: 0, y: 0, secret: 1 } },
    { context: { ...context, generation: 0 } },
  ])
    assert.equal(
      cursorUpdateSchema.safeParse({ ...input, ...changes }).success,
      false,
    );
  assert.equal(
    cursorUpdateSchema.safeParse({ ...input, position: null, renewOnly: true })
      .success,
    false,
  );
  const frame = {
    type: "cursors",
    context,
    cursors: [{ memberId: member.id, position: { x: 1, y: 2 } }],
  };
  assert.equal(cursorsMessageSchema.safeParse(frame).success, true);
  assert.equal(
    cursorsMessageSchema.safeParse({
      ...frame,
      cursors: [...frame.cursors, ...frame.cursors],
    }).success,
    false,
  );
  assert.equal(
    cursorsMessageSchema.safeParse({
      ...frame,
      cursors: Array.from({ length: 1001 }, () => ({
        memberId: crypto.randomUUID(),
        position: { x: 0, y: 0 },
      })),
    }).success,
    false,
  );
  assert.equal(
    cursorsMessageSchema.safeParse({ ...frame, sessionId: crypto.randomUUID() })
      .success,
    false,
  );
});
test("memory cursor ownership expires, filters auth/viewer/context, and never revives a superseded tab", () => {
  const store = new CursorStore(),
    a = {},
    b = {},
    auth = new Map<object, typeof member>([
      [a, member],
      [b, member],
    ]),
    read = (viewer = "other", ctx = context, time = 0) =>
      store.project(ctx, viewer, (o) => auth.get(o) ?? null, time);
  assert.equal(store.update(a, member, context, { x: 1, y: 2 }, 0), true);
  assert.equal(read().length, 1);
  assert.deepEqual(read(member.id), []);
  assert.equal(
    store.update(a, member, context, { x: 1, y: 2 }, 1000, true),
    false,
  );
  assert.equal(store.expire(CURSOR_TTL_MS).size, 0);
  store.update(b, member, context, { x: 3, y: 4 }, 1000);
  assert.equal(store.update(a, member, context, null, 1100), false);
  assert.deepEqual(read()[0]!.position, { x: 3, y: 4 });
  assert.equal(
    store.update(a, member, context, { x: 1, y: 2 }, 1100, true),
    false,
  );
  assert.deepEqual(read()[0]!.position, { x: 3, y: 4 });
  store.remove(b);
  assert.equal(
    store.update(a, member, context, { x: 1, y: 2 }, 1200, true),
    false,
  );
  assert.deepEqual(read(), []);
  store.update(a, member, context, { x: 8, y: 9 }, 2000);
  auth.delete(a);
  assert.deepEqual(read(), []);
  auth.set(a, { ...member, tableId: crypto.randomUUID() });
  assert.deepEqual(read(), []);
  auth.set(a, member);
  assert.deepEqual(read("other", { ...context, generation: 2 }), []);
  assert.deepEqual(read("other", context, 5000), []);
  // Renewal cannot revive a lease even before the periodic expiry sweep runs.
  assert.equal(
    store.update(a, member, context, { x: 8, y: 9 }, 5000, true),
    false,
  );
  assert.deepEqual(read("other", context, 5000), []);
  assert.equal(store.expire(5000).has(context.campaignId), true);
  store.update(a, member, context, { x: 8, y: 9 }, 6000);
  assert.equal(store.activate({ ...context, generation: 2 }), true);
  assert.deepEqual(read(), []);
  assert.equal(
    store.update(
      a,
      { ...member, tableId: crypto.randomUUID() },
      context,
      { x: 0, y: 0 },
      0,
    ),
    false,
  );
});
