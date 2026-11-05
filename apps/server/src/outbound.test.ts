import { test } from "node:test";
import assert from "node:assert/strict";
import { createTable, PROTOCOL_VERSION } from "@tableloom/core";
import { projectTable } from "@tableloom/core/server";
import type { ServerMessage } from "@tableloom/core";
import {
  DEFAULT_CAMPAIGN_ID,
  DEFAULT_SCENE_ID,
} from "@tableloom/core/campaigns";
import {
  OutboundChannel,
  MAX_OUTBOUND_CONTROLS,
  MAX_OUTBOUND_CONTROL_BYTES,
  OUTBOUND_WRITE_TIMEOUT,
} from "./outbound.js";

const connectedFixture = {
  id: "00000000-0000-4000-8000-000000000099",
  name: "Fixture",
  role: "gm" as const,
};
function fixture() {
  let time = 0,
    authorized = true,
    generation = 1,
    builds = 0,
    count = 1,
    terminated = 0;
  const sent: ServerMessage[] = [],
    callbacks: ((error?: Error) => void)[] = [],
    closed: { code: number; reason: string }[] = [],
    forces: boolean[] = [];
  const timers = new Set<{ at: number; action: () => void }>();
  const channel = new OutboundChannel(
    {
      readyState: 1,
      send: (data, callback) => {
        sent.push(JSON.parse(data) as ServerMessage);
        callbacks.push(callback);
      },
      close: (code, reason) => {
        closed.push({ code, reason });
      },
      terminate: () => {
        terminated++;
      },
    },
    {
      authorized: () => authorized,
      snapshot: (force) => {
        builds++;
        forces.push(force);
        return {
          type: "snapshot",
          background: null,
          backgroundVersion: null,
          grid: {
            version: 0,
            settings: { spacing: 60, origin: { x: 0, y: 0 }, visible: true },
          },
          protocolVersion: PROTOCOL_VERSION,
          history: { undo: null, redo: null },
          state: projectTable(createTable(), {
            id: crypto.randomUUID(),
            name: "GM",
            role: "gm",
            tableId: DEFAULT_CAMPAIGN_ID,
          }),
          context: {
            campaignId: DEFAULT_CAMPAIGN_ID,
            sceneId: DEFAULT_SCENE_ID,
            generation,
          },
          campaignName: `Generation ${generation}`,
          sceneName: "Scene",
          participants: count,
          onlineMembers: count ? [connectedFixture] : [],
        };
      },
      presence: () => ({
        type: "presence",
        campaignId: DEFAULT_CAMPAIGN_ID,
        participants: count,
        onlineMembers: count ? [connectedFixture] : [],
      }),
      schedule: (action, delay) => {
        const timer = { at: time + delay, action };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
  );
  const finish = (error?: Error) => {
    const next = callbacks.shift();
    assert.ok(next);
    next(error);
  };
  const advance = (ms: number) => {
    time += ms;
    for (const timer of [...timers])
      if (timer.at <= time) {
        timers.delete(timer);
        timer.action();
      }
  };
  return {
    channel,
    sent,
    callbacks,
    closed,
    forces,
    timers,
    finish,
    advance,
    set authorized(value: boolean) {
      authorized = value;
    },
    set generation(value: number) {
      generation = value;
    },
    set count(value: number) {
      count = value;
    },
    get builds() {
      return builds;
    },
    get terminated() {
      return terminated;
    },
  };
}

test("outbound serializes writes, keeps FIFO command results, and coalesces lazy snapshots/presence to current state", () => {
  const f = fixture();
  f.channel.snapshot();
  assert.equal(f.sent.length, 1);
  for (let i = 0; i < 1000; i++) {
    f.generation = i + 2;
    f.count = i + 2;
    f.channel.snapshot(i === 0);
    f.channel.presence();
  }
  assert.equal(f.builds, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.timers.size, 1);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const commandId of ids) f.channel.control({ type: "ack", commandId });
  f.finish();
  assert.deepEqual(f.sent[1], { type: "ack", commandId: ids[0] });
  f.finish();
  assert.deepEqual(f.sent[2], { type: "ack", commandId: ids[1] });
  f.finish();
  assert.equal(f.builds, 2);
  const latest = f.sent[3];
  assert.ok(latest?.type === "snapshot" && latest.context.generation === 1001);
  assert.deepEqual(f.forces, [false, true]);
  f.finish();
  assert.deepEqual(f.sent[4], {
    type: "presence",
    campaignId: DEFAULT_CAMPAIGN_ID,
    participants: 1001,
    onlineMembers: [connectedFixture],
  });
  f.finish();
  assert.equal(f.timers.size, 0);
  f.channel.dispose();
});

test("outbound reauthorizes before queued controls and builds snapshots only after earlier writes drain", () => {
  const f = fixture();
  f.channel.control({ type: "ack", commandId: crypto.randomUUID() });
  f.channel.snapshot();
  f.channel.control({ type: "error", message: "Queued result" });
  f.authorized = false;
  f.finish();
  assert.equal(f.sent.length, 1);
  assert.equal(f.builds, 0);
  assert.equal(f.closed[0]?.code, 4001);
  f.channel.snapshot();
  f.channel.control({ type: "ack", commandId: crypto.randomUUID() });
  assert.equal(f.sent.length, 1);
  f.advance(1000);
  assert.equal(f.terminated, 1);
  f.channel.dispose();
});

test("outbound control count and UTF-8 byte budgets include the active result and overflow only that channel", () => {
  const count = fixture();
  for (let i = 0; i < MAX_OUTBOUND_CONTROLS; i++)
    count.channel.control({ type: "ack", commandId: crypto.randomUUID() });
  assert.equal(count.closed.length, 0);
  count.channel.control({ type: "ack", commandId: crypto.randomUUID() });
  assert.equal(count.closed[0]?.code, 1013);
  count.finish();
  assert.equal(count.sent.length, 1);
  count.channel.dispose();
  assert.equal(count.timers.size, 0);
  const bytes = fixture(),
    message = { type: "error" as const, message: "🧵".repeat(250) };
  const size = Buffer.byteLength(JSON.stringify(message)),
    capacity = Math.floor(MAX_OUTBOUND_CONTROL_BYTES / size);
  assert.ok(capacity < MAX_OUTBOUND_CONTROLS);
  for (let i = 0; i < capacity; i++) bytes.channel.control(message);
  assert.equal(bytes.closed.length, 0);
  bytes.channel.control(message);
  assert.equal(bytes.closed[0]?.code, 1013);
  bytes.channel.dispose();
  const healthy = fixture();
  healthy.channel.control({ type: "ack", commandId: crypto.randomUUID() });
  healthy.finish();
  assert.equal(healthy.closed.length, 0);
  healthy.channel.dispose();
});

test("outbound stalls and send failures clear waiting work and bound close-handshake time; late callbacks are inert", () => {
  const f = fixture();
  f.channel.snapshot();
  f.channel.control({ type: "ack", commandId: crypto.randomUUID() });
  f.advance(OUTBOUND_WRITE_TIMEOUT - 1);
  assert.equal(f.closed.length, 0);
  f.advance(1);
  assert.equal(f.closed[0]?.code, 1013);
  f.finish();
  assert.equal(f.sent.length, 1);
  f.advance(1000);
  assert.equal(f.terminated, 1);
  assert.equal(f.timers.size, 0);
  const failed = fixture();
  failed.channel.snapshot();
  failed.channel.snapshot();
  failed.finish(new Error("Transport failed"));
  assert.equal(failed.closed[0]?.code, 1011);
  assert.equal(failed.builds, 1);
  failed.channel.dispose();
  assert.equal(failed.timers.size, 0);
  const disposed = fixture();
  disposed.channel.snapshot();
  disposed.channel.snapshot();
  disposed.channel.dispose();
  disposed.finish();
  assert.equal(disposed.sent.length, 1);
  assert.equal(disposed.timers.size, 0);
});

test("large single snapshots remain supported without accumulating another serialized snapshot", () => {
  let buildCount = 0,
    finish: ((error?: Error) => void) | undefined;
  const timers = new Set<() => void>();
  const channel = new OutboundChannel(
    {
      readyState: 1,
      send: (frame, callback) => {
        assert.ok(Buffer.byteLength(frame) > 4 * 1024 * 1024);
        finish = callback;
      },
      close: () =>
        assert.fail("Large allowed state should not fail a fixed frame cap"),
      terminate: () => {},
    },
    {
      authorized: () => true,
      snapshot: () => {
        buildCount++;
        const state = projectTable(createTable(), {
          id: crypto.randomUUID(),
          name: "GM",
          role: "gm",
          tableId: DEFAULT_CAMPAIGN_ID,
        });
        return {
          type: "snapshot",
          background: null,
          backgroundVersion: null,
          grid: {
            version: 0,
            settings: { spacing: 60, origin: { x: 0, y: 0 }, visible: true },
          },
          protocolVersion: PROTOCOL_VERSION,
          history: { undo: null, redo: null },
          state: {
            ...state,
            drawings: Array.from({ length: 200 }, () => ({
              id: crypto.randomUUID(),
              kind: "stroke" as const,
              ownerId: null,
              version: 1,
              color: "#405f4d",
              points: Array.from({ length: 2000 }, () => ({
                x: 1234.56789,
                y: -9876.54321,
              })),
            })),
          },
          context: {
            campaignId: DEFAULT_CAMPAIGN_ID,
            sceneId: DEFAULT_SCENE_ID,
            generation: 1,
          },
          campaignName: "Large fixture",
          sceneName: "Scene",
          participants: 1,
          onlineMembers: [connectedFixture],
        };
      },
      presence: () => ({
        type: "presence",
        campaignId: DEFAULT_CAMPAIGN_ID,
        participants: 1,
        onlineMembers: [connectedFixture],
      }),
      schedule: (action) => {
        timers.add(action);
        return () => {
          timers.delete(action);
        };
      },
    },
  );
  channel.snapshot();
  for (let i = 0; i < 500; i++) channel.snapshot();
  assert.equal(buildCount, 1);
  channel.dispose();
  finish?.();
  assert.equal(timers.size, 0);
});

test("explicit access closure drops queued work immediately and preparation/transport throws stay local", () => {
  const access = fixture();
  access.channel.snapshot();
  access.channel.control({ type: "ack", commandId: crypto.randomUUID() });
  access.channel.close(4001, "Membership removed");
  access.finish();
  assert.equal(access.sent.length, 1);
  assert.equal(access.closed[0]?.code, 4001);
  access.advance(1000);
  assert.equal(access.terminated, 1);
  access.channel.dispose();
  for (const stage of ["prepare", "send"]) {
    const closed: number[] = [];
    const timers = new Set<() => void>();
    const channel = new OutboundChannel(
      {
        readyState: 1,
        send: () => {
          throw new Error("Write failed");
        },
        close: (code) => closed.push(code),
        terminate: () => {},
      },
      {
        authorized: () => true,
        snapshot: () => {
          throw new Error("Prepare failed");
        },
        presence: () => ({
          type: "presence",
          campaignId: DEFAULT_CAMPAIGN_ID,
          participants: 1,
          onlineMembers: [connectedFixture],
        }),
        schedule: (action) => {
          timers.add(action);
          return () => {
            timers.delete(action);
          };
        },
      },
    );
    assert.doesNotThrow(() =>
      stage === "prepare"
        ? channel.snapshot()
        : channel.control({ type: "ack", commandId: crypto.randomUUID() }),
    );
    assert.deepEqual(closed, [1011]);
    channel.dispose();
    assert.equal(timers.size, 0);
  }
});
