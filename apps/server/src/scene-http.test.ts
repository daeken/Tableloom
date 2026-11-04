import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestWebSocket, contextReady } from "./test-client.js";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import {
  contextKey,
  sceneListSchema,
  sceneSchema,
  DEFAULT_CAMPAIGN_ID,
} from "@tableloom/core/campaigns";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";

const KEY = "tableloom-scene-api-fixture-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Scene update did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, cookie: string) {
  const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
    headers: { Cookie: cookie, Origin: url },
  });
  const raw: string[] = [],
    messages: ServerMessage[] = [];
  ws.on("message", (data) => {
    raw.push(data.toString());
    messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
  });
  await once(ws, "open");
  await contextReady(ws);
  return { ws, raw, messages };
}

test("GM scene controls hide offstage metadata, preserve campaign data, and reject stale, forged, and legacy contexts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-scene-api-")),
    databasePath = join(directory, "table.sqlite");
  let app = await createApp({ databasePath, hostKey: KEY });
  const store = new TableStore(databasePath),
    sockets: TestWebSocket[] = [];
  const post = (path: string, body: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: {
        origin: "http://localhost",
        cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  const get = (path: string, cookie = "") =>
    app.inject({ url: `/api/${path}`, headers: { cookie } });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gmCookie = cookieOf(
      await post("access/setup", { name: "GM", key: KEY }),
    );
    const invitation = (await post("access/invitations", {}, gmCookie)).json()
      .token;
    const playerCookie = cookieOf(
      await post("access/join", { name: "Player", code: invitation }),
    );
    const gm = await connect(url, gmCookie),
      player = await connect(url, playerCookie);
    sockets.push(gm.ws, player.ws);
    const initial = { ...player.ws.context! };
    const tokenId = randomUUID(),
      noteId = randomUUID();
    player.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "token.add",
        token: {
          id: tokenId,
          name: "First scene token",
          position: { x: 20, y: 30 },
          color: "#405f4d",
        },
      }),
    );
    player.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "note.add",
        note: {
          id: noteId,
          title: "Campaign note",
          body: "Keep across scenes",
          visibility: "public",
        },
      }),
    );
    await until(() =>
      gm.messages.some(
        (m) => m.type === "snapshot" && m.state.notes.length === 1,
      ),
    );
    const prefix = `campaigns/${DEFAULT_CAMPAIGN_ID}`;
    assert.equal((await get(`${prefix}/scenes`)).statusCode, 401);
    assert.equal((await get(`${prefix}/scenes`, playerCookie)).statusCode, 403);
    assert.equal(
      (await post(`${prefix}/scenes`, { name: "Spoof" }, playerCookie))
        .statusCode,
      403,
    );
    assert.equal(
      (await post(`${prefix}/scenes`, { name: " ", hidden: true }, gmCookie))
        .statusCode,
      400,
    );
    const offstage = await post(
      `${prefix}/scenes`,
      { name: "Hidden future battlefield" },
      gmCookie,
    );
    assert.equal(offstage.statusCode, 201);
    const scene = sceneSchema.parse(offstage.json());
    const list = await get(`${prefix}/scenes`, gmCookie);
    assert.equal(list.headers["cache-control"], "no-store");
    assert.equal(sceneListSchema.parse(list.json()).length, 2);
    assert.equal(store.getCampaign().activeSceneId, initial.sceneId);
    player.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "dice.roll",
        expression: "d6",
        visibility: "gm",
      }),
    );
    await until(() =>
      player.messages.some(
        (m) => m.type === "snapshot" && m.state.rolls.length === 1,
      ),
    );
    assert.equal(contextKey(player.ws.context!), contextKey(initial)); // Private activity is not a context clock.
    assert.ok(!player.raw.join("").includes(scene.id));
    assert.ok(!player.raw.join("").includes(scene.name));
    assert.ok(
      !(
        await get(`campaigns/${DEFAULT_CAMPAIGN_ID}`, playerCookie)
      ).body.includes(scene.name),
    );
    assert.equal(
      (
        await post(
          `${prefix}/activate`,
          { sceneId: scene.id, expectedVersion: initial.generation },
          playerCookie,
        )
      ).statusCode,
      403,
    );
    const activated = await post(
      `${prefix}/activate`,
      { sceneId: scene.id, expectedVersion: initial.generation },
      gmCookie,
    );
    assert.equal(activated.statusCode, 200);
    await until(() =>
      [gm, player].every((client) =>
        client.messages.some(
          (m) => m.type === "snapshot" && m.context.sceneId === scene.id,
        ),
      ),
    );
    const shown = player.messages.findLast((m) => m.type === "snapshot");
    assert.equal(shown?.type === "snapshot" && shown.sceneName, scene.name);
    assert.equal(shown?.type === "snapshot" && shown.state.tokens.length, 0);
    assert.equal(
      shown?.type === "snapshot" && shown.state.notes[0]?.id,
      noteId,
    );
    assert.equal(shown?.type === "snapshot" && shown.state.rolls.length, 1);
    assert.equal(
      (
        await post(
          `${prefix}/activate`,
          { sceneId: initial.sceneId, expectedVersion: initial.generation },
          gmCookie,
        )
      ).statusCode,
      409,
    );
    const other = (
      await post(
        "campaigns",
        {
          name: "Other",
          description: "",
          system: { id: "kids-on-bikes", version: "0.1.0" },
          contentPacks: [],
        },
        gmCookie,
      )
    ).json();
    assert.equal(
      (
        await post(
          `${prefix}/activate`,
          {
            sceneId: other.activeSceneId,
            expectedVersion: activated.json().version,
          },
          gmCookie,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await post(
          `${prefix}/activate`,
          { sceneId: scene.id, expectedVersion: activated.json().version },
          gmCookie,
        )
      ).statusCode,
      409,
    );
    const back = await post(
      `${prefix}/activate`,
      { sceneId: initial.sceneId, expectedVersion: activated.json().version },
      gmCookie,
    );
    assert.equal(back.statusCode, 200);
    await until(() => player.ws.context?.generation === back.json().version);
    assert.equal(store.load().tokens[0]?.id, tokenId);
    async function rejectRaw(
      frame: unknown,
      commandId: string,
      pattern: RegExp,
    ) {
      const before = store.load(),
        start = player.messages.length;
      player.ws.sendRaw(JSON.stringify(frame));
      await until(() =>
        player.messages
          .slice(start)
          .some((m) => m.type === "error" && pattern.test(m.message)),
      );
      assert.deepEqual(store.load(), before);
      assert.equal(store.hasCommand(commandId), false);
    }
    const delayed = {
      id: randomUUID(),
      type: "token.move",
      tokenId,
      position: { x: 999, y: 999 },
    };
    await rejectRaw(
      { context: initial, command: delayed },
      delayed.id,
      /scene changed/,
    ); // Same scene ID after an away-and-back cycle.
    const forged = { ...delayed, id: randomUUID() };
    await rejectRaw(
      {
        context: { ...player.ws.context!, campaignId: other.id },
        command: forged,
      },
      forged.id,
      /scene changed/,
    );
    const legacy = { ...delayed, id: randomUUID() };
    await rejectRaw(legacy, legacy.id, /old protocol/);
    const invalid = { ...delayed, id: randomUUID() };
    await rejectRaw(
      { context: { ...player.ws.context!, generation: -1 }, command: invalid },
      invalid.id,
      /old protocol/,
    );
    const fresh = await connect(url, playerCookie);
    sockets.push(fresh.ws);
    const replay = { ...delayed, id: randomUUID() },
      freshStart = fresh.messages.length;
    fresh.ws.sendRaw(JSON.stringify({ context: initial, command: replay }));
    await until(() =>
      fresh.messages.slice(freshStart).some((m) => m.type === "error"),
    );
    assert.equal(store.hasCommand(replay.id), false);
    assert.equal(store.load().tokens[0]?.position.x, 20);
    player.ws.send(
      JSON.stringify({
        ...delayed,
        id: randomUUID(),
        position: { x: 40, y: 50 },
      }),
    );
    await until(() =>
      gm.messages.some(
        (m) => m.type === "snapshot" && m.state.tokens[0]?.position.x === 40,
      ),
    );
    await app.close();
    app = await createApp({ databasePath, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    const restored = await connect(url, playerCookie);
    sockets.push(restored.ws);
    assert.equal(restored.ws.context?.sceneId, initial.sceneId);
    assert.equal(restored.ws.context?.generation, back.json().version);
    assert.equal(store.load().tokens[0]?.position.x, 40);
    assert.equal(store.load().notes[0]?.id, noteId);
    assert.equal(store.listScenes().length, 2);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
