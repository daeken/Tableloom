import { test } from "node:test";
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import {
  assetSchema,
  assetPageSchema,
  MAX_ASSET_BYTES,
} from "@tableloom/core/assets";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";
import { backgroundStateSchema } from "@tableloom/core/scene-map";
import {
  advancedMapFixture,
  indexedPassFixture,
  pngPassFixture,
} from "./png-pass-fixture.js";
import { pngFixture, indexedMapFixture, pngChunk } from "./png-fixture.js";
const KEY = "tableloom-asset-http-test-host-key";
test("asset HTTP uploads stay GM-private and out of snapshots, preserve scope/origin/size/auth checks and survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-asset-http-")),
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
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/assets`;
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" })),
      playerGrant = await post("access/join", {
        name: "Player",
        code: (await post("access/invitations", {}, gm)).json().token,
      }),
      player = cookieOf(playerGrant);
    const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
        headers: { Cookie: player, Origin: url },
      }),
      frames: string[] = [];
    sockets.push(ws);
    ws.on("message", (data) => frames.push(data.toString()));
    await once(ws, "open");
    await contextReady(ws);
    const before = (await get("table", player)).body,
      binary = pngFixture(),
      upload = (
        cookie = gm,
        body = binary,
        origin = "http://localhost",
        type = "image/png",
      ) =>
        app.inject({
          method: "POST",
          url: `/api/${root}?name=${encodeURIComponent("GM unrevealed map.png")}`,
          headers: { cookie, origin, "content-type": type },
          payload: body,
        });
    assert.equal((await get(root)).statusCode, 401);
    assert.equal((await get(root, player)).statusCode, 403);
    assert.equal(
      (await upload("", Buffer.alloc(MAX_ASSET_BYTES + 1))).statusCode,
      401,
    );
    assert.equal((await upload(player)).statusCode, 403);
    assert.equal(
      (await upload(gm, binary, "https://foreign.invalid")).statusCode,
      403,
    );
    assert.equal(
      (await upload(gm, binary, "http://localhost", "image/webp")).statusCode,
      415,
    );
    assert.equal(
      (await upload(gm, Buffer.alloc(MAX_ASSET_BYTES + 1))).statusCode,
      413,
    );
    const response = await upload();
    assert.equal(response.statusCode, 201);
    const asset = assetSchema.parse(response.json()),
      path = `${root}/${asset.id}/content`;
    const content = await get(path, gm);
    assert.equal(content.statusCode, 200);
    assert.deepEqual(content.rawPayload, binary);
    assert.equal(content.headers["content-type"], "image/png");
    assert.equal(content.headers["cache-control"], "no-store");
    assert.equal(content.headers["x-content-type-options"], "nosniff");
    assert.ok(
      String(content.headers["content-disposition"]).includes(asset.id),
    );
    assert.equal((await get(path)).statusCode, 401);
    assert.equal((await get(path, player)).statusCode, 404);
    assert.equal(
      (await post(`${root}/${asset.id}/delete`, {}, player)).statusCode,
      403,
    );
    const page = assetPageSchema.parse((await get(root, gm)).json());
    assert.equal(page.assets[0]!.id, asset.id);
    assert.equal(page.totalCount, 1);
    // Confirm the upload route accepts valid bodies above the ordinary 256-KiB JSON limit.
    const raw = randomFillSync(Buffer.alloc((512 * 4 + 1) * 256));
    for (let y = 0; y < 256; y++) raw[y * (512 * 4 + 1)] = 0;
    const large = pngFixture(512, 256, { raw });
    assert.ok(large.length > 256 * 1024);
    assert.equal((await upload(gm, large)).statusCode, 201);
    assert.equal((await get("table", player)).body, before);
    assert.ok(!frames.join("").includes(asset.id));
    assert.ok(!frames.join("").includes(asset.name));
    const other = (
      await post(
        "campaigns",
        {
          name: "Other",
          description: "",
          system: { id: "kids-on-bikes", version: "0.1.0" },
          contentPacks: [],
        },
        gm,
      )
    ).json();
    const selected = await post(`campaigns/${other.id}/select`, {}, gm),
      otherCookie = cookieOf(selected);
    assert.equal((await get(path, otherCookie)).statusCode, 409);
    assert.equal(
      (
        await get(
          `campaigns/${other.id}/assets/${asset.id}/content`,
          otherCookie,
        )
      ).statusCode,
      404,
    );
    const restored = await post(
        `campaigns/${DEFAULT_CAMPAIGN_ID}/select`,
        {},
        otherCookie,
      ),
      restoredCookie = cookieOf(restored);
    sockets.forEach((s) => s.terminate());
    await app.close();
    app = await createApp(options);
    await app.listen({ port: 0, host: "127.0.0.1" });
    assert.deepEqual((await get(path, restoredCookie)).rawPayload, binary);
    assert.equal(
      (await post(`${root}/${asset.id}/delete`, {}, restoredCookie)).statusCode,
      200,
    );
    assert.equal((await get(path, restoredCookie)).statusCode, 404);
    assert.equal(
      assetPageSchema.parse((await get(root, restoredCookie)).json())
        .totalCount,
      1,
    );
    assert.equal(
      (
        await post(
          `access/members/${playerGrant.json().member.id}/remove`,
          {},
          restoredCookie,
        )
      ).statusCode,
      200,
    );
    assert.equal((await get(path, player)).statusCode, 401);
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("PNG modes, 16-bit precision and Adam7 data retain transparency through private storage, scene replacement/reveal, restart, and authorization guards", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-asset-modes-")),
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
    });
  const get = (path: string, cookie = "") =>
    app.inject({ url: `/api/${path}`, headers: { cookie } });
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers["set-cookie"]).split(";")[0]!;
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/assets`,
    maps = `campaigns/${DEFAULT_CAMPAIGN_ID}/scene-map`;
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" })),
      playerGrant = await post("access/join", {
        name: "Player",
        code: (await post("access/invitations", {}, gm)).json().token,
      }),
      player = cookieOf(playerGrant);
    const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
        headers: { Cookie: player, Origin: url },
      }),
      frames: string[] = [];
    sockets.push(ws);
    ws.on("message", (data) => frames.push(data.toString()));
    await once(ws, "open");
    await contextReady(ws);
    const upload = (binary: Buffer, cookie = gm) =>
      app.inject({
        method: "POST",
        url: `/api/${root}?name=Private%20mode%20fixture`,
        headers: {
          cookie,
          origin: "http://localhost",
          "content-type": "image/png",
        },
        payload: binary,
      });
    const indexed = indexedMapFixture(),
      notes = pngChunk("tEXt", Buffer.from("GM\0Unrevealed private notes")),
      withNotes = Buffer.concat([
        indexed.subarray(0, 33),
        notes,
        indexed.subarray(33),
      ]);
    const fixtures = [
      { input: withNotes, expected: indexed, width: 320, height: 240 },
      {
        input: pngFixture(9, 1, {
          color: 0,
          depth: 1,
          raw: Buffer.from([0, 0x55, 0xff]),
          extra: pngChunk("tRNS", Buffer.from([0, 1])),
        }),
        width: 9,
        height: 1,
      },
      {
        input: pngFixture(2, 1, {
          color: 4,
          raw: Buffer.from([0, 32, 0, 192, 128]),
        }),
        width: 2,
        height: 1,
      },
      {
        input: pngFixture(1, 1, {
          color: 2,
          raw: Buffer.from([0, 40, 60, 80]),
          extra: pngChunk("tRNS", Buffer.from([0, 40, 0, 60, 0, 80])),
        }),
        width: 1,
        height: 1,
      },
    ];
    fixtures.push(
      { input: advancedMapFixture(), width: 320, height: 240 },
      { input: indexedPassFixture(), width: 17, height: 13 },
      {
        input: pngPassFixture({
          width: 9,
          height: 5,
          color: 0,
          depth: 16,
          interlace: 0,
          extra: pngChunk("tRNS", Buffer.from([0x12, 0x34])),
        }),
        width: 9,
        height: 5,
      },
    );
    const assets: ReturnType<typeof assetSchema.parse>[] = [];
    const beforeFrames = frames.length,
      core = (await get("table", player)).body;
    for (const fixture of fixtures) {
      const response = await upload(fixture.input);
      assert.equal(response.statusCode, 201);
      const asset = assetSchema.parse(response.json());
      assets.push(asset);
      assert.equal(asset.width, fixture.width);
      assert.equal(asset.height, fixture.height);
      const saved = await get(`${root}/${asset.id}/content`, gm);
      assert.deepEqual(saved.rawPayload, fixture.expected ?? fixture.input);
      assert.ok(
        !saved.rawPayload.includes(Buffer.from("Unrevealed private notes")),
      );
      assert.equal(saved.headers["content-type"], "image/png");
      assert.equal(saved.headers["cache-control"], "no-store");
      assert.equal(
        (await get(`${root}/${asset.id}/content`, player)).statusCode,
        404,
      );
    }
    assert.equal(frames.length, beforeFrames);
    assert.equal((await get("table", player)).body, core);
    assert.equal((await upload(indexed, player)).statusCode, 403);
    const bad = pngFixture(1, 1, {
      color: 3,
      depth: 2,
      raw: Buffer.from([0, 0xc0]),
      extra: pngChunk("PLTE", Buffer.from([0, 0, 0])),
    });
    assert.equal((await upload(bad)).statusCode, 400);
    assert.equal(
      assetPageSchema.parse((await get(root, gm)).json()).totalCount,
      7,
    );
    const priorPage = (await get(root, gm)).body;
    const excessive = await upload(
      pngFixture(8192, 2048, { color: 6, depth: 16, raw: Buffer.alloc(2) }),
    );
    assert.equal(excessive.statusCode, 400);
    assert.match(excessive.json().error, /decoded scanline budget/);
    assert.equal((await get(root, gm)).body, priorPage);
    const control = backgroundStateSchema.parse((await get(maps, gm)).json());
    const placed = backgroundStateSchema.parse(
      (
        await post(
          `${maps}/set`,
          {
            context: control.context,
            expectedVersion: 0,
            assetId: assets[0]!.id,
            position: { x: 0, y: 0 },
            width: 400,
          },
          gm,
        )
      ).json(),
    );
    let image = `${maps}/${control.context.sceneId}/${placed.map!.imageId}/content`,
      expectedShared = indexed;
    let lastImageId = placed.map!.imageId;
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
    assert.equal(shared.statusCode, 200);
    assert.deepEqual(shared.rawPayload, indexed);
    assert.equal(shared.headers["x-content-type-options"], "nosniff");
    assert.equal(shared.headers["cache-control"], "no-store");
    // Replace the public scene with each new mode: the replacement starts private.
    for (let i = 4; i < fixtures.length; i++) {
      const current = backgroundStateSchema.parse((await get(maps, gm)).json()),
        oldImage = image;
      const next = backgroundStateSchema.parse(
        (
          await post(
            `${maps}/set`,
            {
              context: current.context,
              expectedVersion: current.version,
              assetId: assets[i]!.id,
              position: { x: 0, y: 0 },
              width: 400,
            },
            gm,
          )
        ).json(),
      );
      image = `${maps}/${next.context.sceneId}/${next.map!.imageId}/content`;
      expectedShared = fixtures[i]!.input;
      lastImageId = next.map!.imageId;
      assert.equal((await get(image, player)).statusCode, 404);
      assert.equal((await get(oldImage, player)).statusCode, 404);
      assert.equal((await get(image, gm)).statusCode, 200);
      assert.equal(
        (
          await post(
            `${maps}/visibility`,
            {
              context: next.context,
              expectedVersion: next.version,
              visibility: "public",
              acknowledgeReveal: true,
            },
            gm,
          )
        ).statusCode,
        200,
      );
      assert.deepEqual((await get(image, player)).rawPayload, expectedShared);
    }
    // A later visible snapshot lets us check the whole stream for private identifiers.
    const end = Date.now() + 5000;
    while (!frames.some((f) => f.includes(lastImageId))) {
      assert.ok(Date.now() < end);
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const asset of assets) assert.ok(!frames.join("").includes(asset.id));
    assert.ok(!frames.join("").includes("Unrevealed private notes"));
    sockets.forEach((s) => s.terminate());
    await app.close();
    app = await createApp(options);
    for (let i = 0; i < assets.length; i++)
      assert.deepEqual(
        (await get(`${root}/${assets[i]!.id}/content`, gm)).rawPayload,
        fixtures[i]!.expected ?? fixtures[i]!.input,
      );
    assert.deepEqual((await get(image, player)).rawPayload, expectedShared);
    await post(`access/members/${playerGrant.json().member.id}/remove`, {}, gm);
    assert.equal((await get(image, player)).statusCode, 401);
  } finally {
    sockets.forEach((s) => s.terminate());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
