import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import {
  assetSchema,
  assetPageSchema,
  MAX_ASSET_BYTES,
} from "@tableloom/core/assets";
import { backgroundStateSchema } from "@tableloom/core/scene-map";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";
import { AccessStore } from "./access.js";
import { AssetStore } from "./assets.js";
import { SceneMapStore } from "./scene-map.js";
import { TestWebSocket, contextReady } from "./test-client.js";
import {
  jpegFixture,
  progressiveJpegFixture,
  grayscaleJpegFixture,
} from "./jpeg-fixture.js";
import { sanitizeJpeg } from "./jpeg.js";
import { pngFixture } from "./png-fixture.js";
const KEY = "tableloom-jpeg-fixture-private-host-key";
test("JPEG assets persist canonical oriented PNG metadata/bytes, preserve GM/scope/history guards and roll back rejected writes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const tables = new TableStore(db),
      access = new AccessStore(db, KEY),
      gm = access.setupHost(KEY, "GM"),
      player = access.redeemInvitation(
        access.createInvitation(gm.token).token,
        "Player",
      ),
      assets = new AssetStore(db),
      maps = new SceneMapStore(db, tables, assets),
      input = jpegFixture(24, 16, 6),
      canonical = sanitizeJpeg(input),
      before = tables.load();
    const asset = assets.upload(
      gm.member,
      "Courtyard.jpg",
      input,
      "image/jpeg",
    );
    assert.equal(asset.mimeType, "image/png");
    assert.equal(asset.width, 16);
    assert.equal(asset.height, 24);
    assert.equal(asset.byteLength, canonical.bytes.length);
    assert.equal(assets.list(gm.member).usedBytes, canonical.bytes.length);
    assert.deepEqual(
      new AssetStore(db).content(gm.member, asset.id).bytes,
      canonical.bytes,
    );
    const rows = () => db.prepare("SELECT * FROM campaign_assets").all(),
      saved = rows();
    assert.throws(
      () =>
        assets.upload(
          { ...player.member, role: "gm" },
          "Forged",
          input,
          "image/jpeg",
        ),
      /Only campaign GMs/,
    );
    assert.throws(() => assets.upload(gm.member, "Wrong MIME", input));
    assert.throws(() =>
      assets.upload(gm.member, "Wrong bytes", pngFixture(), "image/jpeg"),
    );
    db.exec(
      "CREATE TRIGGER reject_jpeg_asset BEFORE INSERT ON campaign_assets BEGIN SELECT RAISE(ABORT,'fixture JPEG write failure'); END",
    );
    assert.throws(
      () => assets.upload(gm.member, "Failed", input, "image/jpeg"),
      /fixture JPEG write failure/,
    );
    assert.deepEqual(rows(), saved);
    db.exec("DROP TRIGGER reject_jpeg_asset");
    const control = maps.controls(gm.member),
      placed = maps.set(gm.member, {
        context: control.context,
        expectedVersion: 0,
        assetId: asset.id,
        position: { x: 0, y: 0 },
        width: 200,
      });
    assert.equal(placed.map!.height, 300);
    assert.equal(maps.project(player.member).background, null);
    maps.visibility(gm.member, {
      context: control.context,
      expectedVersion: 1,
      visibility: "public",
      acknowledgeReveal: true,
    });
    assert.deepEqual(
      assets.contentForScene(
        player.member,
        control.context.sceneId,
        placed.map!.imageId,
      ).bytes,
      canonical.bytes,
    );
    assert.throws(() => assets.delete(gm.member, asset.id), /every scene map/);
    maps.remove(gm.member, { context: control.context, expectedVersion: 2 });
    assert.throws(
      () => assets.delete(gm.member, asset.id),
      /retained map history/,
    );
    maps.clearHistory(gm.member, {
      context: control.context,
      expectedVersion: 3,
      acknowledgeClear: true,
    });
    assets.delete(gm.member, asset.id);
    assert.equal(assets.list(gm.member).totalCount, 0);
    assert.deepEqual(tables.load(), before);
  } finally {
    db.close();
  }
});
test("JPEG HTTP uploads normalize privately, enforce raw body/type/origin/auth limits, reveal canonical PNG only, and survive restart/revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-jpeg-http-")),
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
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/assets`,
    maps = `campaigns/${DEFAULT_CAMPAIGN_ID}/scene-map`;
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" })),
      grant = await post("access/join", {
        name: "Player",
        code: (await post("access/invitations", {}, gm)).json().token,
      }),
      player = cookieOf(grant);
    const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
        headers: { Cookie: player, Origin: url },
      }),
      frames: string[] = [];
    sockets.push(ws);
    ws.on("message", (data) => frames.push(data.toString()));
    await once(ws, "open");
    await contextReady(ws);
    const input = jpegFixture(32, 24, 6),
      upload = (
        body = input,
        cookie = gm,
        type = "image/jpeg",
        origin = "http://localhost",
      ) =>
        app.inject({
          method: "POST",
          url: `/api/${root}?name=Unrevealed%20GPS%20map.jpg`,
          headers: { cookie, origin, "content-type": type },
          payload: body,
        }),
      before = frames.length;
    assert.equal(
      (await upload(Buffer.alloc(MAX_ASSET_BYTES + 1), "")).statusCode,
      401,
    );
    assert.equal(
      (await upload(Buffer.alloc(MAX_ASSET_BYTES + 1), player)).statusCode,
      403,
    );
    assert.equal(
      (await upload(input, gm, "image/jpeg", "https://foreign.invalid"))
        .statusCode,
      403,
    );
    assert.equal(
      (await upload(Buffer.alloc(MAX_ASSET_BYTES + 1))).statusCode,
      413,
    );
    assert.equal((await upload(pngFixture())).statusCode, 400);
    assert.equal((await upload(input, gm, "image/png")).statusCode, 400);
    const assets: ReturnType<typeof assetSchema.parse>[] = [];
    const sources = [input, progressiveJpegFixture(), grayscaleJpegFixture()];
    for (const source of sources) {
      const response = await upload(source);
      assert.equal(response.statusCode, 201);
      const asset = assetSchema.parse(response.json());
      assets.push(asset);
      assert.equal(asset.mimeType, "image/png");
      const saved = await get(`${root}/${asset.id}/content`, gm);
      assert.deepEqual(saved.rawPayload, sanitizeJpeg(source).bytes);
      assert.equal(saved.headers["content-type"], "image/png");
      assert.ok(String(saved.headers["content-disposition"]).endsWith('.png"'));
      assert.equal(saved.headers["cache-control"], "no-store");
      assert.equal(saved.headers["x-content-type-options"], "nosniff");
      assert.equal(
        (await get(`${root}/${asset.id}/content`, player)).statusCode,
        404,
      );
      assert.equal((await get(`${root}/${asset.id}/content`)).statusCode, 401);
    }
    assert.equal(
      assetPageSchema.parse((await get(root, gm)).json()).totalCount,
      3,
    );
    assert.equal(frames.length, before);
    const control = backgroundStateSchema.parse((await get(maps, gm)).json()),
      placed = backgroundStateSchema.parse(
        (
          await post(
            `${maps}/set`,
            {
              context: control.context,
              expectedVersion: 0,
              assetId: assets[0]!.id,
              position: { x: 0, y: 0 },
              width: 300,
            },
            gm,
          )
        ).json(),
      ),
      image = `${maps}/${control.context.sceneId}/${placed.map!.imageId}/content`;
    assert.equal(placed.map!.height, 400);
    assert.equal((await get(image, player)).statusCode, 404);
    await post(
      `${maps}/visibility`,
      {
        context: control.context,
        expectedVersion: 1,
        visibility: "public",
        acknowledgeReveal: true,
      },
      gm,
    );
    const shared = await get(image, player);
    assert.equal(shared.headers["content-type"], "image/png");
    assert.deepEqual(shared.rawPayload, sanitizeJpeg(input).bytes);
    assert.ok(
      !shared.rawPayload.includes(Buffer.from("Synthetic private GPS")),
    );
    const end = Date.now() + 5000;
    while (!frames.some((frame) => frame.includes(placed.map!.imageId))) {
      assert.ok(Date.now() < end);
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const asset of assets) assert.ok(!frames.join("").includes(asset.id));
    assert.ok(!frames.join("").includes("Unrevealed GPS"));
    sockets.forEach((s) => s.terminate());
    await app.close();
    app = await createApp(options);
    for (let i = 0; i < sources.length; i++)
      assert.deepEqual(
        (await get(`${root}/${assets[i]!.id}/content`, gm)).rawPayload,
        sanitizeJpeg(sources[i]!).bytes,
      );
    assert.deepEqual(
      (await get(image, player)).rawPayload,
      sanitizeJpeg(input).bytes,
    );
    await post(`access/members/${grant.json().member.id}/remove`, {}, gm);
    assert.equal((await get(image, player)).statusCode, 401);
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
