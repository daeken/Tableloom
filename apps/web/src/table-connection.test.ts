import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION, createTable } from "@tableloom/core";
import { projectTable } from "@tableloom/core/server";
import {
  DEFAULT_CAMPAIGN_ID,
  DEFAULT_SCENE_ID,
} from "@tableloom/core/campaigns";
import type { ServerMessage } from "@tableloom/core";
import type { CommandContext } from "@tableloom/core/campaigns";
import { TableConnection, MAX_PENDING_BYTES } from "./table-connection.js";
import type {
  CommandDelivery,
  ConnectionDependencies,
  ConnectionStatus,
  LiveHandlers,
  LiveSocket,
} from "./table-connection.js";

const context: CommandContext = {
  campaignId: DEFAULT_CAMPAIGN_ID,
  sceneId: DEFAULT_SCENE_ID,
  generation: 1,
};
const member = {
  id: crypto.randomUUID(),
  name: "GM",
  role: "gm" as const,
  tableId: DEFAULT_CAMPAIGN_ID,
};
const snapshot = (next = context) => ({
  type: "snapshot" as const,
  background: null,
  backgroundVersion: null,
  protocolVersion: PROTOCOL_VERSION,
  history: { undo: null, redo: null },
  state: projectTable(createTable(), member),
  context: next,
  campaignName: "Campaign",
  sceneName: "Scene",
  participants: 1,
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
class Socket implements LiveSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  constructor(readonly handlers: LiveHandlers) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  emit(message: unknown) {
    this.handlers.message(JSON.stringify(message));
  }
}
function fixture(
  probe: ConnectionDependencies["probe"] = async () => PROTOCOL_VERSION,
) {
  let time = 0,
    refreshes = 0,
    clears = 0;
  const deliveries: CommandDelivery[] = [];
  const sockets: Socket[] = [],
    statuses: ConnectionStatus[] = [],
    errors: string[] = [],
    snapshots: ServerMessage[] = [],
    presence: number[] = [];
  const timers = new Set<{ at: number; action: () => void }>();
  const client = new TableConnection(
    "ws://fixture.invalid/api/live",
    DEFAULT_CAMPAIGN_ID,
    {
      delivery: (item) => deliveries.push(item),
      probe,
      open: (_url, handlers) => {
        const socket = new Socket(handlers);
        sockets.push(socket);
        return socket;
      },
      random: () => 1,
      schedule: (action, delay) => {
        const timer = { at: time + delay, action };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
      refreshAccess: async () => {
        refreshes++;
      },
      snapshot: (message) => snapshots.push(message),
      participants: (count) => presence.push(count),
      clear: () => {
        clears++;
      },
      status: (status) => statuses.push(status),
      error: (error) => errors.push(error),
    },
  );
  const advance = async (ms: number) => {
    const end = time + ms;
    while (true) {
      const next = [...timers]
        .filter((timer) => timer.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      time = next.at;
      timers.delete(next);
      next.action();
      await flush();
    }
    time = end;
    await flush();
  };
  return {
    client,
    deliveries,
    sockets,
    statuses,
    errors,
    snapshots,
    presence,
    timers,
    advance,
    get refreshes() {
      return refreshes;
    },
    get clears() {
      return clears;
    },
  };
}

test("connection waits for a fresh snapshot, rejects stale callbacks and scene actions, and never queues/replays edits", async () => {
  const f = fixture();
  f.client.start();
  await flush();
  const first = f.sockets[0]!;
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    false,
  );
  first.emit(snapshot());
  assert.equal(f.statuses.at(-1), "connected");
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    true,
  );
  assert.equal(first.sent.length, 1);
  const frame = JSON.parse(first.sent[0]!);
  assert.deepEqual(frame.context, context);
  assert.equal(frame.command.type, "dice.roll");
  assert.ok(frame.command.id);
  first.handlers.close(1006);
  assert.equal(f.statuses.at(-1), "offline");
  assert.equal(f.refreshes, 1);
  assert.match(f.errors.at(-1)!, /may have saved/);
  assert.equal(f.clears, 0);
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    false,
  );
  await f.advance(1000);
  const second = f.sockets[1]!;
  assert.equal(second.sent.length, 0);
  first.emit(snapshot({ ...context, generation: 99 }));
  first.handlers.close(4001);
  assert.equal(f.clears, 0);
  assert.equal(f.sockets.length, 2);
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    false,
  );
  const changed = { ...context, generation: 2 };
  second.emit(snapshot(changed));
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    false,
  );
  assert.equal(
    f.client.send(changed, { type: "dice.roll", expression: "d6" }),
    true,
  );
  assert.equal(second.sent.length, 1);
  f.client.stop();
  second.emit(snapshot());
  second.handlers.error();
  await f.advance(60000);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.timers.size, 0);
});

test("network failures back off to a bounded delay; deadlines abort hanging probes and ignore late results", async () => {
  const f = fixture(async () => {
    throw new Error("offline");
  });
  f.client.start();
  await flush();
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    assert.equal(f.timers.size, 1);
    await f.advance(delay - 1);
    assert.equal(f.statuses.at(-1), "offline");
    await f.advance(1);
  }
  f.client.stop();
  assert.equal(f.timers.size, 0);
  let resolve!: (protocol: number) => void;
  let signal!: AbortSignal;
  const slow = fixture(async (s) => {
    signal = s;
    return new Promise<number>((done) => {
      resolve = done;
    });
  });
  slow.client.start();
  await flush();
  await slow.advance(10000);
  assert.equal(signal.aborted, true);
  assert.equal(slow.statuses.at(-1), "offline");
  resolve(PROTOCOL_VERSION);
  await flush();
  assert.equal(slow.sockets.length, 0);
  assert.match(slow.errors.at(-1)!, /timed out/);
  slow.client.stop();
  const waiting = fixture();
  waiting.client.start();
  await flush();
  await waiting.advance(10000);
  assert.equal(waiting.sockets[0]!.closed, true);
  assert.equal(
    waiting.client.send(context, { type: "dice.roll", expression: "d6" }),
    false,
  );
  waiting.client.stop();
});

test("protocol mismatch, malformed snapshots, foreign campaigns, and policy closures stop reconnecting", async () => {
  const mismatch = fixture(async () => PROTOCOL_VERSION + 1);
  mismatch.client.start();
  await flush();
  assert.equal(mismatch.statuses.at(-1), "blocked");
  assert.equal(mismatch.sockets.length, 0);
  assert.equal(mismatch.timers.size, 0);
  for (const message of [
    { ...snapshot(), protocolVersion: PROTOCOL_VERSION - 1 },
    { ...snapshot(), context: { ...context, campaignId: crypto.randomUUID() } },
    { type: "snapshot", background: null, backgroundVersion: null, state: {} },
    "invalid",
  ]) {
    const f = fixture();
    f.client.start();
    await flush();
    f.sockets[0]!.emit(message);
    assert.equal(f.statuses.at(-1), "blocked");
    assert.equal(
      f.client.send(context, { type: "dice.roll", expression: "d6" }),
      false,
    );
    assert.equal(f.timers.size, 0);
    assert.equal(f.snapshots.length, 0);
    f.client.stop();
  }
  for (const code of [1002, 1008, 1009]) {
    const f = fixture();
    f.client.start();
    await flush();
    f.sockets[0]!.emit(snapshot());
    f.sockets[0]!.handlers.close(code);
    assert.equal(f.statuses.at(-1), "blocked");
    assert.equal(f.timers.size, 0);
    f.client.stop();
  }
});

test("credential loss clears snapshots, overload waits, and outgoing backpressure refuses rather than buffering changes", async () => {
  const f = fixture();
  f.client.start();
  await flush();
  const socket = f.sockets[0]!;
  socket.emit(snapshot());
  socket.bufferedAmount = MAX_PENDING_BYTES;
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    false,
  );
  assert.equal(socket.sent.length, 0);
  assert.match(f.errors.at(-1)!, /not sent/);
  socket.bufferedAmount = 0;
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    true,
  );
  socket.handlers.close(1013);
  await f.advance(2999);
  assert.equal(f.sockets.length, 1);
  await f.advance(1);
  assert.equal(f.sockets.length, 2);
  f.sockets[1]!.emit(snapshot());
  f.sockets[1]!.handlers.close(4001);
  assert.equal(f.clears, 1);
  assert.equal(f.presence.at(-1), 0);
  f.client.stop();
});

test("command confirmations correlate only to pending requests; snapshots and unknown results cannot confirm delivery", async () => {
  const f = fixture();
  f.client.start();
  await flush();
  const socket = f.sockets[0]!;
  socket.emit(snapshot());
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    true,
  );
  const id = JSON.parse(socket.sent[0]!).command.id;
  assert.equal(f.deliveries.at(-1)?.status, "pending");
  socket.emit(snapshot());
  socket.emit({ type: "ack", commandId: crypto.randomUUID() });
  assert.equal(f.deliveries.at(-1)?.status, "pending");
  socket.emit({ type: "ack", commandId: id });
  assert.equal(f.deliveries.at(-1)?.status, "accepted");
  const count = f.deliveries.length;
  socket.emit({ type: "error", commandId: id, message: "Late duplicate" });
  assert.equal(f.deliveries.length, count);
  const noteId = crypto.randomUUID();
  f.client.send(context, { type: "note.delete", noteId, expectedVersion: 1 });
  const nextId = JSON.parse(socket.sent[1]!).command.id;
  socket.emit({
    type: "error",
    commandId: nextId,
    message: "This note changed.",
  });
  assert.equal(f.deliveries.at(-1)?.status, "rejected");
  assert.equal(f.deliveries.at(-1)?.target, noteId);
  assert.equal(f.deliveries.at(-1)?.message, "This note changed.");
  f.client.stop();
});

test("pending requests have bounded count and deadlines; disconnects report uncertainty without replay", async () => {
  const f = fixture();
  f.client.start();
  await flush();
  const socket = f.sockets[0]!;
  socket.emit(snapshot());
  for (let i = 0; i < 64; i++)
    assert.equal(
      f.client.send(context, { type: "dice.roll", expression: "d6" }),
      true,
    );
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    false,
  );
  assert.equal(socket.sent.length, 64);
  await f.advance(10000);
  assert.equal(
    f.deliveries.filter((item) => item.status === "uncertain").length,
    64,
  );
  socket.emit({
    type: "ack",
    commandId: JSON.parse(socket.sent[0]!).command.id,
  });
  assert.equal(f.deliveries.at(-1)?.status, "uncertain");
  assert.equal(
    f.client.send(context, { type: "dice.roll", expression: "d6" }),
    true,
  );
  socket.handlers.close(1006);
  assert.equal(f.deliveries.at(-1)?.status, "uncertain");
  await f.advance(1000);
  assert.equal(f.sockets[1]!.sent.length, 0);
  f.client.stop();
  assert.equal(f.timers.size, 0);
});
