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
import { pngFixture } from "./png-fixture.js";
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
      (await upload(gm, binary, "http://localhost", "image/jpeg")).statusCode,
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
