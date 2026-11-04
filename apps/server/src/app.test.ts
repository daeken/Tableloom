import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";

const HOST_KEY = "tableloom-test-host-key-never-use-in-production";
const testApp = (options: Omit<Parameters<typeof createApp>[0], "hostKey">) =>
  createApp({ ...options, hostKey: HOST_KEY });
async function post(
  app: Awaited<ReturnType<typeof createApp>>,
  route: string,
  payload: unknown,
  cookie = "",
) {
  return app.inject({
    method: "POST",
    url: `/api/access/${route}`,
    headers: {
      origin: "http://localhost",
      cookie,
      "content-type": "application/json",
    },
    payload: JSON.stringify(payload),
  });
}
function cookieOf(response: { headers: Record<string, unknown> }) {
  return String(response.headers["set-cookie"]).split(";")[0]!;
}

async function client(url: string, cookie: string) {
  const ws = new WebSocket(
    `${url.replace("http", "ws")}/api/live?name=Imposter`,
    { headers: { Cookie: cookie, Origin: url } },
  );
  const messages: ServerMessage[] = [];
  ws.on("message", (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return { ws, messages };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for WebSocket update");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("two real clients synchronize changes, reject invalid commands, deduplicate rolls, and restore persisted state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-test-"));
  const databasePath = join(directory, "table.sqlite");
  let app = await testApp({ databasePath });
  const clients: WebSocket[] = [];
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const setup = await post(app, "setup", { key: HOST_KEY, name: "Alice" });
    assert.equal(setup.statusCode, 200);
    const aliceCookie = cookieOf(setup);
    const invitation = await post(app, "invitations", {}, aliceCookie);
    const bobCookie = cookieOf(
      await post(app, "join", { code: invitation.json().token, name: "Bob" }),
    );
    const alice = await client(url, aliceCookie);
    clients.push(alice.ws);
    const bob = await client(url, bobCookie);
    clients.push(bob.ws);
    await until(() => bob.messages.some((m) => m.type === "snapshot"));
    const tokenId = randomUUID();
    alice.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "token.add",
        token: {
          id: tokenId,
          name: "Hero",
          position: { x: 60, y: 120 },
          color: "#405f4d",
        },
      }),
    );
    await until(() =>
      [alice, bob].every((c) =>
        c.messages.some(
          (m) =>
            m.type === "snapshot" &&
            m.state.revision === 1 &&
            m.state.tokens[0]?.name === "Hero",
        ),
      ),
    );
    const drawingId = randomUUID();
    bob.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "drawing.add",
        drawing: {
          id: drawingId,
          kind: "rectangle",
          points: [
            { x: 0, y: 0 },
            { x: 60, y: 60 },
          ],
          color: "#405f4d",
        },
      }),
    );
    await until(() =>
      alice.messages.some(
        (m) =>
          m.type === "snapshot" &&
          m.state.revision === 2 &&
          m.state.drawings.length === 1,
      ),
    );
    bob.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "token.move",
        tokenId,
        position: { x: 80, y: 90 },
      }),
    );
    await until(() =>
      alice.messages.some(
        (m) =>
          m.type === "snapshot" &&
          m.state.revision === 3 &&
          m.state.tokens[0]?.position.x === 80,
      ),
    );
    const rollCommand = {
      id: randomUUID(),
      type: "dice.roll",
      expression: "2d6 + 3",
    };
    alice.ws.send(JSON.stringify(rollCommand));
    await until(() =>
      bob.messages.some(
        (m) => m.type === "snapshot" && m.state.rolls.length === 1,
      ),
    );
    alice.ws.send(JSON.stringify(rollCommand));
    bob.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "system.set",
        systemId: "uninstalled-game",
      }),
    );
    bob.ws.send("not json");
    bob.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "dice.roll",
        expression: "999d6",
      }),
    );
    await until(
      () => bob.messages.filter((m) => m.type === "error").length === 3,
    );
    const data = (await (
      await fetch(`${url}/api/table`, { headers: { cookie: aliceCookie } })
    ).json()) as {
      revision: number;
      rolls: { actor: string; dice: number[]; total: number }[];
    };
    assert.equal(data.revision, 4);
    assert.equal(data.rolls.length, 1);
    assert.equal(data.rolls[0]?.actor, "Alice");
    assert.equal(
      data.rolls[0]?.total,
      data.rolls[0]!.dice.reduce((a, b) => a + b, 3),
    );
    // Restart with live clients, exercising shutdown and subsequent reconnection.
    await app.close();
    app = await testApp({ databasePath });
    const restarted = await app.listen({ port: 0, host: "127.0.0.1" });
    assert.deepEqual(
      await (
        await fetch(`${restarted}/api/table`, {
          headers: { cookie: aliceCookie },
        })
      ).json(),
      data,
    );
    const reconnected = await client(restarted, aliceCookie);
    clients.push(reconnected.ws);
    await until(() =>
      reconnected.messages.some(
        (m) => m.type === "snapshot" && m.state.revision === 4,
      ),
    );
    reconnected.ws.send(JSON.stringify(rollCommand));
    await until(
      () =>
        reconnected.messages.filter((m) => m.type === "snapshot").length === 2,
    );
    assert.equal(
      (
        (await (
          await fetch(`${restarted}/api/table`, {
            headers: { cookie: aliceCookie },
          })
        ).json()) as {
          revision: number;
        }
      ).revision,
      4,
    );
  } finally {
    for (const ws of clients) ws.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("WebSocket handshake rejects foreign browser origins and unauthenticated access", async () => {
  const app = await testApp({ databasePath: ":memory:" });
  try {
    const foreign = await app.inject({
      url: "/api/live?name=Player",
      headers: { origin: "https://elsewhere.example", host: "localhost" },
    });
    assert.equal(foreign.statusCode, 403);
    const unauthorized = await app.inject({
      url: "/api/live",
      headers: { origin: "http://localhost" },
    });
    assert.equal(unauthorized.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("SQLite state and command receipt are atomic when a duplicate receipt fails", () => {
  const store = new TableStore(":memory:");
  try {
    const state = store.load();
    const id = randomUUID();
    store.save({ ...state, revision: 1 }, id);
    assert.throws(() => store.save({ ...state, revision: 2 }, id));
    assert.equal(store.load().revision, 1);
    assert.equal(store.hasCommand(id), true);
  } finally {
    store.close();
  }
});
