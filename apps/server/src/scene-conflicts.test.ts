import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";
import { TestWebSocket, contextReady } from "./test-client.js";
const KEY = "tableloom-scene-conflict-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Scene conflict result timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, cookie: string) {
  const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
    headers: { Cookie: cookie, Origin: url },
  });
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  await once(ws, "open");
  await contextReady(ws);
  return { ws, messages };
}
const result = (messages: ServerMessage[], id: string) =>
  messages.find(
    (message) =>
      (message.type === "ack" || message.type === "error") &&
      message.commandId === id,
  );

test("concurrent owner/GM scene edits accept one version, reject stale deletes/transfers without receipts, and persist versions over restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-scene-conflicts-")),
    path = join(directory, "table.sqlite");
  let app = await createApp({ databasePath: path, hostKey: KEY });
  const store = new TableStore(path),
    sockets: TestWebSocket[] = [];
  const post = (route: string, body: Record<string, unknown>, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/access/${route}`,
      headers: { origin: "http://localhost", cookie },
      payload: body,
    });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const setup = await post("setup", { key: KEY, name: "GM" }),
      gm = cookieOf(setup),
      gmId = setup.json().member.id;
    const player = cookieOf(
      await post("join", {
        name: "Player",
        code: (await post("invitations", {}, gm)).json().token,
      }),
    );
    let p = await connect(url, player);
    const g = await connect(url, gm);
    sockets.push(p.ws, g.ws);
    const tokenId = crypto.randomUUID(),
      create = {
        id: crypto.randomUUID(),
        type: "token.add",
        token: {
          id: tokenId,
          name: "Scout",
          position: { x: 10, y: 20 },
          color: "#405f4d",
        },
      };
    p.ws.send(JSON.stringify(create));
    await until(() => Boolean(result(p.messages, create.id)));
    const owner = store.load().tokens[0]!.ownerId;
    const move = {
        id: crypto.randomUUID(),
        type: "token.move",
        tokenId,
        expectedVersion: 1,
        position: { x: 50, y: 60 },
      },
      competing = {
        ...move,
        id: crypto.randomUUID(),
        position: { x: 80, y: 90 },
      };
    p.ws.sendRaw(JSON.stringify({ context: p.ws.context, command: move }));
    g.ws.sendRaw(JSON.stringify({ context: g.ws.context, command: competing }));
    await until(
      () =>
        Boolean(result(p.messages, move.id)) &&
        Boolean(result(g.messages, competing.id)),
    );
    const outcomes = [
      result(p.messages, move.id)!,
      result(g.messages, competing.id)!,
    ];
    assert.equal(
      outcomes.filter((message) => message.type === "ack").length,
      1,
    );
    assert.equal(
      outcomes.filter((message) => message.type === "error").length,
      1,
    );
    assert.equal(store.load().tokens[0]?.version, 2);
    const failed = outcomes.find((message) => message.type === "error")!;
    assert.equal(store.hasCommand(failed.commandId!), false);
    const winner =
      outcomes[0]?.type === "ack"
        ? { peer: p, command: move }
        : { peer: g, command: competing };
    const beforeRetry = store.load(),
      start = winner.peer.messages.length;
    winner.peer.ws.sendRaw(
      JSON.stringify({
        context: winner.peer.ws.context,
        command: winner.command,
      }),
    );
    await until(() =>
      Boolean(result(winner.peer.messages.slice(start), winner.command.id)),
    );
    assert.deepEqual(store.load(), beforeRetry);
    const reject = async (command: Record<string, unknown>) => {
      g.ws.sendRaw(JSON.stringify({ context: g.ws.context, command }));
      await until(() => Boolean(result(g.messages, String(command.id))));
      assert.equal(result(g.messages, String(command.id))?.type, "error");
      assert.equal(store.hasCommand(String(command.id)), false);
    };
    await reject({
      id: crypto.randomUUID(),
      type: "object.delete",
      objectId: tokenId,
      expectedVersion: 1,
    });
    await reject({
      id: crypto.randomUUID(),
      type: "object.assign",
      objectId: tokenId,
      expectedVersion: 1,
      expectedOwnerId: owner,
      ownerId: gmId,
    });
    const returned = {
      ...move,
      id: crypto.randomUUID(),
      expectedVersion: 2,
      position: { x: 10, y: 20 },
    };
    g.ws.sendRaw(JSON.stringify({ context: g.ws.context, command: returned }));
    await until(() => Boolean(result(g.messages, returned.id)));
    assert.equal(store.load().tokens[0]?.version, 3);
    await reject({ ...move, id: crypto.randomUUID() }); // Same position as the original, newer edit version.
    const transfer = {
      id: crypto.randomUUID(),
      type: "object.assign",
      objectId: tokenId,
      expectedVersion: 3,
      expectedOwnerId: owner,
      ownerId: gmId,
    };
    g.ws.sendRaw(JSON.stringify({ context: g.ws.context, command: transfer }));
    await until(() => Boolean(result(g.messages, transfer.id)));
    assert.equal(store.load().tokens[0]?.version, 4);
    await reject({ ...move, id: crypto.randomUUID(), expectedVersion: 3 });
    const removed = {
      id: crypto.randomUUID(),
      type: "object.delete",
      objectId: tokenId,
      expectedVersion: 4,
    };
    g.ws.sendRaw(JSON.stringify({ context: g.ws.context, command: removed }));
    await until(() => Boolean(result(g.messages, removed.id)));
    assert.equal(store.load().tokens.length, 0);
    await reject({ ...move, id: crypto.randomUUID(), expectedVersion: 4 });
    const tokenTwo = crypto.randomUUID(),
      add = {
        ...create,
        id: crypto.randomUUID(),
        token: { ...create.token, id: tokenTwo },
      };
    p.ws.send(JSON.stringify(add));
    await until(() => Boolean(result(p.messages, add.id)));
    const final = {
      ...move,
      id: crypto.randomUUID(),
      tokenId: tokenTwo,
      expectedVersion: 1,
    };
    p.ws.sendRaw(JSON.stringify({ context: p.ws.context, command: final }));
    await until(() => Boolean(result(p.messages, final.id)));
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    app = await createApp({ databasePath: path, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    p = await connect(url, player);
    sockets.push(p.ws);
    assert.equal(store.load().tokens[0]?.version, 2);
    const stale = { ...final, id: crypto.randomUUID() };
    p.ws.sendRaw(JSON.stringify({ context: p.ws.context, command: stale }));
    await until(() => Boolean(result(p.messages, stale.id)));
    assert.equal(result(p.messages, stale.id)?.type, "error");
    assert.equal(store.hasCommand(stale.id), false);
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
