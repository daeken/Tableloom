import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWebSocket as WebSocket, contextReady } from "./test-client.js";
import { serverMessageSchema, tableViewSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { applyCommand } from "@tableloom/core/server";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { createApp } from "./app.js";

const KEY = "tableloom-campaign-wire-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Campaign snapshot did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, token: string) {
  const socket = new WebSocket(`${url.replace("http", "ws")}/api/live`, {
    headers: { Origin: url, Cookie: `tableloom_session=${token}` },
  });
  const raw: string[] = [],
    messages: ServerMessage[] = [];
  socket.on("message", (data) => {
    raw.push(data.toString());
    messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
  });
  await once(socket, "open");
  await contextReady(socket);
  return { socket, raw, messages };
}

test("the live default campaign never transmits offstage scene content or another campaign's content", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-campaign-wire-"));
  const databasePath = join(directory, "table.sqlite");
  const store = new TableStore(databasePath),
    access = new AccessStore(databasePath, KEY);
  const gm = access.setupHost(KEY, "GM"),
    player = access.redeemInvitation(
      access.createInvitation(gm.token).token,
      "Player",
    );
  const defaultCampaign = store.getCampaign();
  const scene = store.createScene(defaultCampaign.id, {
    name: "Hidden future scene",
  });
  const active = store.activateScene(
    defaultCampaign.id,
    scene.id,
    defaultCampaign.version,
  );
  const futureTokenId = randomUUID(),
    futureCommandId = randomUUID();
  store.save(
    applyCommand(
      store.load(),
      {
        id: futureCommandId,
        type: "token.add",
        token: {
          id: futureTokenId,
          name: "Future ambush marker",
          position: { x: 0, y: 0 },
          color: "#405f4d",
        },
      },
      gm.member,
    ),
    futureCommandId,
  );
  store.activateScene(
    defaultCampaign.id,
    defaultCampaign.activeSceneId,
    active.version,
  );
  const other = store.createCampaign({
    name: "Hidden other campaign",
    description: "",
    system: { id: "kids-on-brooms", version: "0.1.0" },
    contentPacks: [],
  });
  const otherNoteId = randomUUID(),
    otherCommandId = randomUUID();
  store.save(
    applyCommand(
      store.load(other.id),
      {
        id: otherCommandId,
        type: "note.add",
        note: {
          id: otherNoteId,
          title: "Another campaign's public clue",
          body: "Not public across campaigns",
          visibility: "public",
        },
      },
      gm.member,
    ),
    otherCommandId,
    other.id,
  );
  const app = await createApp({ databasePath, hostKey: KEY });
  const sockets: WebSocket[] = [];
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const g = await connect(url, gm.token),
      p = await connect(url, player.token);
    sockets.push(g.socket, p.socket);
    await until(() =>
      [g, p].every((client) =>
        client.messages.some((message) => message.type === "snapshot"),
      ),
    );
    const command = { id: randomUUID(), type: "dice.roll", expression: "d6" };
    p.socket.send(JSON.stringify(command));
    await until(() =>
      [g, p].every((client) =>
        client.messages.some(
          (message) =>
            message.type === "snapshot" && message.state.rolls.length === 1,
        ),
      ),
    );
    // A receipt in another campaign cannot suppress a valid command here.
    assert.equal(store.hasCommand(otherCommandId), false);
    assert.equal(store.hasCommand(otherCommandId, other.id), true);
    p.socket.send(
      JSON.stringify({
        id: otherCommandId,
        type: "dice.roll",
        expression: "d8",
      }),
    );
    await until(() =>
      [g, p].every((client) =>
        client.messages.some(
          (message) =>
            message.type === "snapshot" && message.state.rolls.length === 2,
        ),
      ),
    );
    assert.equal(store.hasCommand(otherCommandId), true);
    for (const client of [g, p]) {
      const response = await app.inject({
        url: "/api/table",
        headers: {
          cookie: `tableloom_session=${client === g ? gm.token : player.token}`,
        },
      });
      assert.equal(response.statusCode, 200);
      const view = tableViewSchema.parse(response.json());
      assert.equal(view.tokens.length, 0);
      assert.equal(view.notes.length, 0);
      for (const secret of [
        futureTokenId,
        "Future ambush marker",
        scene.name,
        scene.id,
        other.id,
        other.name,
        otherNoteId,
        "Not public across campaigns",
        otherCommandId,
      ]) {
        assert.ok(
          !client.raw.join("").includes(secret),
          `Unexpected offstage data: ${secret}`,
        );
        assert.ok(!response.body.includes(secret));
      }
    }
    assert.equal(store.load(other.id).rolls.length, 0);
    assert.equal(store.hasCommand(command.id, other.id), false);
    await app.close();
    const restored = store.getCampaign();
    store.activateScene(restored.id, scene.id, restored.version);
    assert.equal(store.load().tokens[0]?.id, futureTokenId);
    assert.equal(store.load().rolls.length, 2); // Campaign-wide dice persisted beside the inactive scene.
    assert.equal(store.load(other.id).notes[0]?.id, otherNoteId);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    store.close();
    access.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
