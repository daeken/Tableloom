import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { backgroundStateSchema } from "@tableloom/core/scene-map";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";
import { pngFixture } from "./png-fixture.js";
const KEY = "tableloom-map-http-test-private-host-key";
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, "Map snapshot timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("live background maps reveal only projected data, guard bytes/context/assets, survive restart, and hide without a private activity clock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-background-")),
    options = { databasePath: join(directory, "table.sqlite"), hostKey: KEY };
  let app = await createApp(options);
  const sockets: TestWebSocket[] = [];
  const post = (path: string, payload: unknown, cookie = "") =>
      app.inject({
        method: "POST",
        url: `/api/${path}`,
        headers: {
          origin: "http://localhost",
          cookie,
          "content-type": "application/json",
        },
        payload: JSON.stringify(payload),
      }),
    get = (path: string, cookie = "") =>
      app.inject({ url: `/api/${path}`, headers: { cookie } }),
    cookieOf = (r: { headers: Record<string, unknown> }) =>
      String(r.headers["set-cookie"]).split(";")[0]!;
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/scene-map`,
    assetRoot = `campaigns/${DEFAULT_CAMPAIGN_ID}/assets`;
  async function connect(url: string, cookie: string) {
    const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
        headers: { Cookie: cookie, Origin: url },
      }),
      messages: ServerMessage[] = [];
    sockets.push(ws);
    ws.on("message", (data) =>
      messages.push(serverMessageSchema.parse(JSON.parse(data.toString()))),
    );
    await once(ws, "open");
    await contextReady(ws);
    const snapshots = () => messages.filter((m) => m.type === "snapshot");
    return { ws, messages, snapshots, latest: () => snapshots().at(-1)! };
  }
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" })),
      grant = await post("access/join", {
        name: "Player",
        code: (await post("access/invitations", {}, gm)).json().token,
      }),
      player = cookieOf(grant);
    let p = await connect(url, player);
    const g = await connect(url, gm),
      initial = backgroundStateSchema.parse((await get(root, gm)).json()),
      png = pngFixture(320, 240),
      asset = (
        await app.inject({
          method: "POST",
          url: `/api/${assetRoot}?name=GM%20unrevealed%20map`,
          headers: {
            cookie: gm,
            origin: "http://localhost",
            "content-type": "image/png",
          },
          payload: png,
        })
      ).json();
    const set = {
        context: initial.context,
        expectedVersion: 0,
        assetId: asset.id,
        position: { x: 60, y: 80 },
        width: 400,
      },
      beforeSnapshots = p.snapshots().length,
      beforeTable = (await get("table", player)).body;
    assert.equal((await get(root, player)).statusCode, 403);
    assert.equal((await post(`${root}/set`, set, player)).statusCode, 403);
    const placed = backgroundStateSchema.parse(
      (await post(`${root}/set`, set, gm)).json(),
    );
    await until(() => g.latest().backgroundVersion === 1);
    const imagePath = `${root}/${initial.context.sceneId}/${placed.map!.imageId}/content`;
    assert.equal((await get(imagePath, player)).statusCode, 404);
    assert.equal((await get(imagePath)).statusCode, 401);
    assert.deepEqual((await get(imagePath, gm)).rawPayload, png);
    assert.equal(p.snapshots().length, beforeSnapshots);
    assert.deepEqual(p.latest().background, null);
    assert.equal(p.latest().backgroundVersion, null);
    assert.ok(!JSON.stringify(p.messages).includes(asset.id));
    const moved = backgroundStateSchema.parse(
      (
        await post(
          `${root}/set`,
          { ...set, expectedVersion: 1, position: { x: 70, y: 90 } },
          gm,
        )
      ).json(),
    );
    await until(() => g.latest().backgroundVersion === 2);
    assert.equal(p.snapshots().length, beforeSnapshots);
    assert.equal(
      (
        await post(
          `${root}/visibility`,
          {
            context: initial.context,
            expectedVersion: 2,
            visibility: "public",
          },
          gm,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          `${root}/visibility`,
          {
            context: initial.context,
            expectedVersion: 2,
            visibility: "public",
            acknowledgeReveal: true,
          },
          gm,
        )
      ).statusCode,
      200,
    );
    await until(() => p.latest().background?.imageId === placed.map!.imageId);
    assert.equal(p.latest().backgroundVersion, null);
    assert.ok(!JSON.stringify(p.latest()).includes(asset.id));
    const shared = await get(imagePath, player);
    assert.equal(shared.statusCode, 200);
    assert.deepEqual(shared.rawPayload, png);
    assert.equal(shared.headers["cache-control"], "no-store");
    assert.equal(shared.headers["x-content-type-options"], "nosniff");
    assert.equal(
      (await get(`${assetRoot}/${asset.id}/content`, player)).statusCode,
      404,
    );
    assert.equal(
      (await post(`${assetRoot}/${asset.id}/delete`, {}, gm)).statusCode,
      409,
    );
    const stale = await post(
      `${root}/set`,
      { ...set, expectedVersion: 1, width: 500 },
      gm,
    );
    assert.equal(stale.statusCode, 409);
    assert.equal((await get("table", player)).body, beforeTable);
    const hidden = backgroundStateSchema.parse(
      (
        await post(
          `${root}/visibility`,
          { context: initial.context, expectedVersion: 3, visibility: "gm" },
          gm,
        )
      ).json(),
    );
    await until(() => p.latest().background === null);
    assert.equal((await get(imagePath, player)).statusCode, 404);
    const hiddenCount = p.snapshots().length;
    await post(
      `${root}/set`,
      { ...set, expectedVersion: hidden.version, position: { x: 90, y: 100 } },
      gm,
    );
    await until(() => g.latest().backgroundVersion === 5);
    assert.equal(p.snapshots().length, hiddenCount);
    assert.equal(
      (
        await post(
          `${root}/set`,
          {
            ...set,
            context: { ...set.context, generation: 999 },
            expectedVersion: 5,
          },
          gm,
        )
      ).statusCode,
      409,
    );
    const next = (
      await post(
        `campaigns/${DEFAULT_CAMPAIGN_ID}/scenes`,
        { name: "Future scene" },
        gm,
      )
    ).json();
    await post(
      `campaigns/${DEFAULT_CAMPAIGN_ID}/activate`,
      { sceneId: next.id, expectedVersion: initial.context.generation },
      gm,
    );
    await until(() => p.latest().context.sceneId === next.id);
    assert.equal(p.latest().background, null);
    assert.equal((await get(imagePath, player)).statusCode, 404);
    assert.equal(
      (await post(`${assetRoot}/${asset.id}/delete`, {}, gm)).statusCode,
      409,
    );
    const nextControl = backgroundStateSchema.parse(
      (await get(root, gm)).json(),
    );
    await post(
      `campaigns/${DEFAULT_CAMPAIGN_ID}/activate`,
      {
        sceneId: initial.context.sceneId,
        expectedVersion: nextControl.context.generation,
      },
      gm,
    );
    await until(() => g.latest().context.sceneId === initial.context.sceneId);
    assert.equal(
      (
        await post(
          `${root}/remove`,
          { context: initial.context, expectedVersion: 5 },
          gm,
        )
      ).statusCode,
      409,
    );
    const current = backgroundStateSchema.parse((await get(root, gm)).json());
    assert.equal(current.map!.position.x, 90);
    assert.equal(current.version, 5);
    sockets.forEach((s) => s.terminate());
    await app.close();
    app = await createApp(options);
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    p = await connect(url, player);
    assert.equal(p.latest().background, null);
    assert.equal(p.latest().backgroundVersion, null);
    assert.deepEqual(
      backgroundStateSchema.parse((await get(root, gm)).json()),
      current,
    );
    await post(
      `${root}/visibility`,
      {
        context: current.context,
        expectedVersion: 5,
        visibility: "public",
        acknowledgeReveal: true,
      },
      gm,
    );
    await until(() => Boolean(p.latest().background));
    assert.equal(
      (await post(`access/members/${grant.json().member.id}/remove`, {}, gm))
        .statusCode,
      200,
    );
    assert.equal((await get(imagePath, player)).statusCode, 401);
    const fresh = backgroundStateSchema.parse((await get(root, gm)).json());
    await post(
      `${root}/remove`,
      { context: fresh.context, expectedVersion: fresh.version },
      gm,
    );
    assert.equal((await get(imagePath, gm)).statusCode, 404);
    assert.equal(
      (await post(`${assetRoot}/${asset.id}/delete`, {}, gm)).statusCode,
      409,
    );
    await post(
      `${root}/clear-history`,
      {
        context: fresh.context,
        expectedVersion: fresh.version + 1,
        acknowledgeClear: true,
      },
      gm,
    );
    assert.equal(
      (await post(`${assetRoot}/${asset.id}/delete`, {}, gm)).statusCode,
      200,
    );
    assert.equal(moved.map!.height, 300);
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("map history HTTP inverses are GM-only, explicitly revealed, version-guarded, live-private, and durable across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-map-history-http-")),
    options = { databasePath: join(directory, "table.sqlite"), hostKey: KEY };
  let app = await createApp(options);
  let url = await app.listen({ port: 0, host: "127.0.0.1" });
  const sockets: TestWebSocket[] = [];
  const post = (path: string, payload: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: {
        origin: "http://localhost",
        cookie,
        "content-type": "application/json",
      },
      payload: JSON.stringify(payload),
    });
  const get = (path: string, cookie = "") =>
    app.inject({ url: `/api/${path}`, headers: { cookie } });
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers["set-cookie"]).split(";")[0]!;
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/scene-map`,
    assetRoot = `campaigns/${DEFAULT_CAMPAIGN_ID}/assets`;
  async function live(cookie: string) {
    const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
        headers: { Cookie: cookie, Origin: url },
      }),
      messages: ServerMessage[] = [];
    sockets.push(ws);
    ws.on("message", (data) =>
      messages.push(serverMessageSchema.parse(JSON.parse(data.toString()))),
    );
    await once(ws, "open");
    await contextReady(ws);
    return {
      messages,
      latest: () => messages.filter((m) => m.type === "snapshot").at(-1)!,
    };
  }
  try {
    const gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" })),
      player = cookieOf(
        await post("access/join", {
          name: "Player",
          code: (await post("access/invitations", {}, gm)).json().token,
        }),
      );
    const p = await live(player),
      g = await live(gm),
      initial = backgroundStateSchema.parse((await get(root, gm)).json());
    const asset = (
      await app.inject({
        method: "POST",
        url: `/api/${assetRoot}?name=Hidden`,
        headers: {
          cookie: gm,
          origin: "http://localhost",
          "content-type": "image/png",
        },
        payload: pngFixture(),
      })
    ).json();
    const placed = backgroundStateSchema.parse(
      (
        await post(
          `${root}/set`,
          {
            context: initial.context,
            expectedVersion: 0,
            assetId: asset.id,
            position: { x: 0, y: 0 },
            width: 400,
          },
          gm,
        )
      ).json(),
    );
    await until(() => g.latest().backgroundVersion === 1);
    const command = {
      context: initial.context,
      expectedVersion: 1,
      entryId: placed.history.undo!.id,
    };
    assert.equal((await post(`${root}/undo`, command, player)).statusCode, 403);
    assert.equal(
      (
        await post(
          `${root}/clear-history`,
          {
            context: initial.context,
            expectedVersion: 1,
            acknowledgeClear: true,
          },
          player,
        )
      ).statusCode,
      403,
    );
    const count = p.messages.length;
    const undone = backgroundStateSchema.parse(
      (await post(`${root}/undo`, command, gm)).json(),
    );
    await until(() => g.latest().backgroundVersion === 2);
    assert.equal(undone.map, null);
    assert.equal(p.messages.length, count);
    assert.equal((await post(`${root}/undo`, command, gm)).statusCode, 409);
    const redo = {
      context: initial.context,
      expectedVersion: 2,
      entryId: undone.history.redo!.id,
    };
    const redone = backgroundStateSchema.parse(
      (await post(`${root}/redo`, redo, gm)).json(),
    );
    await until(() => g.latest().backgroundVersion === 3);
    assert.equal(p.messages.length, count);
    assert.notEqual(redone.map!.imageId, placed.map!.imageId);
    await post(
      `${root}/visibility`,
      {
        context: initial.context,
        expectedVersion: 3,
        visibility: "public",
        acknowledgeReveal: true,
      },
      gm,
    );
    await until(() => p.latest().background !== null);
    const publicId = p.latest().background!.imageId;
    const hidden = backgroundStateSchema.parse(
      (
        await post(
          `${root}/visibility`,
          { context: initial.context, expectedVersion: 4, visibility: "gm" },
          gm,
        )
      ).json(),
    );
    await until(() => p.latest().background === null);
    const inverse = {
      context: initial.context,
      expectedVersion: 5,
      entryId: hidden.history.undo!.id,
    };
    assert.equal((await post(`${root}/undo`, inverse, gm)).statusCode, 400);
    assert.equal(
      (await post(`${root}/undo`, { ...inverse, acknowledgeReveal: true }, gm))
        .statusCode,
      200,
    );
    await until(() => p.latest().background !== null);
    const currentId = p.latest().background!.imageId;
    assert.notEqual(currentId, publicId);
    assert.equal(
      (
        await get(
          `${root}/${initial.context.sceneId}/${publicId}/content`,
          player,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await get(
          `${root}/${initial.context.sceneId}/${currentId}/content`,
          player,
        )
      ).statusCode,
      200,
    );
    assert.ok(!JSON.stringify(p.messages).includes(asset.id));
    for (const edge of [
      placed.history.undo,
      undone.history.redo,
      hidden.history.undo,
    ])
      assert.ok(!JSON.stringify(p.messages).includes(edge!.id));
    const state = backgroundStateSchema.parse((await get(root, gm)).json());
    sockets.forEach((s) => s.terminate());
    await app.close();
    app = await createApp(options);
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    assert.deepEqual(
      backgroundStateSchema.parse((await get(root, gm)).json()),
      state,
    );
    const peer = await live(player),
      before = peer.messages.length;
    assert.equal(
      (
        await post(
          `${root}/clear-history`,
          { context: initial.context, expectedVersion: state.version },
          gm,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          `${root}/clear-history`,
          {
            context: initial.context,
            expectedVersion: state.version,
            acknowledgeClear: true,
          },
          gm,
        )
      ).statusCode,
      200,
    );
    const control = backgroundStateSchema.parse((await get(root, gm)).json());
    assert.deepEqual(control.map, state.map);
    assert.equal(control.history.count, 0);
    assert.equal(control.version, state.version + 1);
    // Clearing private history of a visible, unchanged map does not emit player activity.
    const gmLive = await live(gm);
    assert.equal(gmLive.latest().backgroundVersion, control.version);
    assert.equal(peer.messages.length, before);
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
