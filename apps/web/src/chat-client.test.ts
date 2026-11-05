import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatClient, ChatRequestError, type ChatView } from "./chat-client.js";
import type { ChatInput, ChatPage } from "@tableloom/core/chat";
const member = {
  id: crypto.randomUUID(),
  tableId: crypto.randomUUID(),
  name: "Alice",
  role: "player" as const,
};
const input: ChatInput = {
  id: crypto.randomUUID(),
  body: "Hello",
  audience: "gm",
};
const message = {
  ...input,
  authorId: member.id,
  authorName: member.name,
  createdAt: 1234,
};
const page: ChatPage = {
  campaignId: member.tableId,
  viewerId: member.id,
  messages: [message],
};
function fixture() {
  const requests: {
    body: ChatInput | undefined;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  let state: ChatView = {
    messages: [],
    pending: false,
    ready: false,
    error: "",
  };
  const client = new ChatClient(
    member,
    (body, signal) =>
      new Promise((resolve, reject) =>
        requests.push({ body, signal, resolve, reject }),
      ),
    (view) => (state = view),
  );
  return { client, requests, state: () => state };
}
test("chat client ignores retired/older loads, clears on disconnect, and validates campaign/viewer/private audience before display", async () => {
  const f = fixture();
  f.client.start();
  const old = f.client.load(),
    fresh = f.client.load();
  f.requests[1]!.resolve(page);
  await fresh;
  f.requests[0]!.resolve({ ...page, messages: [] });
  await old;
  assert.deepEqual(f.state().messages, [message]);
  for (const bad of [
    { ...page, campaignId: crypto.randomUUID() },
    { ...page, viewerId: crypto.randomUUID() },
    { ...page, messages: [{ ...message, authorId: crypto.randomUUID() }] },
    { ...page, secret: "no" },
  ]) {
    const load = f.client.load();
    f.requests.at(-1)!.resolve(bad);
    await load;
    assert.deepEqual(f.state().messages, []);
    assert.equal(f.state().ready, false);
    assert.ok(f.state().error);
  }
  const retired = f.client.load();
  f.client.stop();
  assert.ok(f.requests.at(-1)!.signal.aborted);
  f.client.start();
  f.requests.at(-1)!.resolve(page);
  await retired;
  assert.deepEqual(f.state().messages, []);
  const recovered = f.client.load();
  f.requests.at(-1)!.resolve(page);
  await recovered;
  assert.equal(f.state().error, "");
  assert.equal(f.state().ready, true);
  f.client.stop();
});
test("chat sends are gated, uncertain delivery never replays, retained explicit retries confirm, and retired posts cannot clear drafts", async () => {
  const f = fixture();
  assert.equal(await f.client.send(input), false);
  f.client.start();
  assert.equal(await f.client.send(input), false);
  const load = f.client.load();
  f.requests.at(-1)!.resolve(page);
  await load;
  const send = f.client.send(input);
  assert.equal(f.state().pending, true);
  assert.equal(await f.client.send(input), false);
  f.requests.at(-1)!.reject(new Error("connection lost"));
  assert.equal(await send, false);
  assert.match(f.state().error, /not confirmed/);
  assert.equal(f.requests.length, 2);
  const refresh = f.client.load();
  f.requests.at(-1)!.resolve(page);
  await refresh;
  assert.match(f.state().error, /not confirmed/);
  const retry = f.client.send(input);
  assert.deepEqual(f.requests.at(-1)!.body, input);
  f.requests.at(-1)!.resolve(message);
  assert.equal(await retry, true); // The following refresh has not completed yet.
  await Promise.resolve();
  await Promise.resolve();
  f.requests.at(-1)!.resolve(page);
  assert.equal(await retry, true);
  assert.equal(f.state().error, "");
  const reject = f.client.send({ ...input, id: crypto.randomUUID() });
  f.requests.at(-1)!.reject(new ChatRequestError("Chat is busy. Wait."));
  assert.equal(await reject, false);
  assert.equal(f.state().error, "Chat is busy. Wait.");
  const retired = f.client.send(input),
    post = f.requests.at(-1)!;
  f.client.stop();
  f.client.start();
  post.resolve(message);
  assert.equal(await retired, false);
  assert.deepEqual(f.state().messages, []);
  assert.match(f.state().error, /not confirmed/);
  f.client.stop();
});
