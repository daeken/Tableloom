import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.js";
import { instancePack } from "./instances-fixture.js";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { instanceSchema, instancePageSchema } from "@tableloom/core/instances";

test("instance HTTP creation, ownership, strict writes, privacy, scope and persisted restart use isolated versioned state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-instance-http-")),
    pack = instancePack(),
    key = "instance-http-fixture-not-a-real-key",
    options = {
      databasePath: join(directory, "table.sqlite"),
      hostKey: key,
      contentPacks: [pack],
    };
  let app = await createApp(options);
  const post = (
      path: string,
      body: unknown,
      cookie = "",
      origin = "http://localhost",
    ) =>
      app.inject({
        method: "POST",
        url: `/api/${path}`,
        headers: { origin, cookie, "content-type": "application/json" },
        payload: JSON.stringify(body),
      }),
    get = (path: string, cookie = "") =>
      app.inject({ url: `/api/${path}`, headers: { cookie } }),
    cookieOf = (r: { headers: Record<string, unknown> }) =>
      String(r.headers["set-cookie"]).split(";")[0]!;
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/instances`,
    reference = {
      packId: pack.id,
      packVersion: pack.version,
      definitionId: "a-public",
    },
    body = { reference, expectedRevision: 0 };
  try {
    const gm = cookieOf(await post("access/setup", { key, name: "GM" })),
      code = (await post("access/invitations", {}, gm)).json().token,
      player = cookieOf(await post("access/join", { name: "Player", code }));
    assert.equal((await get(root)).statusCode, 401);
    assert.equal((await post(root, body, player)).statusCode, 404);
    const campaign = (await get(`campaigns/${DEFAULT_CAMPAIGN_ID}`, gm)).json();
    assert.equal(
      (
        await post(
          `campaigns/${DEFAULT_CAMPAIGN_ID}/settings`,
          {
            expectedVersion: campaign.version,
            settings: {
              name: campaign.name,
              description: campaign.description,
              system: campaign.system,
              contentPacks: [{ id: pack.id, version: pack.version }],
            },
          },
          gm,
        )
      ).statusCode,
      200,
    );
    const before = (await get("table", player)).body;
    assert.equal(
      (await post(root, body, player, "https://foreign.invalid")).statusCode,
      403,
    );
    for (const extra of [
      { ownerId: "forged" },
      { data: {} },
      { visibility: "public" },
      { id: "forged" },
      { schemaVersion: 1 },
    ])
      assert.equal(
        (await post(root, { ...body, ...extra }, player)).statusCode,
        400,
      );
    assert.equal(
      (
        await post(
          root,
          { ...body, reference: { ...reference, definitionId: "b-hidden" } },
          player,
        )
      ).statusCode,
      404,
    );
    const response = await post(root, body, player);
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers["cache-control"], "no-store");
    const created = instanceSchema.parse(response.json());
    assert.equal(created.visibility, "gm");
    assert.equal(created.version, 1);
    const privateResponse = await post(
        root,
        { ...body, reference: { ...reference, definitionId: "b-hidden" } },
        gm,
      ),
      hidden = instanceSchema.parse(privateResponse.json());
    assert.equal((await get(`${root}/${hidden.id}`, player)).statusCode, 404);
    assert.equal(
      instancePageSchema.parse((await get(`${root}?limit=1`, player)).json())
        .next,
      null,
    );
    assert.ok(
      !(await get(root, player)).body.includes("PRIVATE-CONTENT-CANARY"),
    );
    const path = `${root}/${created.id}`,
      edit = {
        expectedVersion: 1,
        name: "Saved page",
        visibility: "public",
        data: { label: "Persisted", marked: true },
      };
    assert.equal(
      (await post(path, { ...edit, source: created.source }, player))
        .statusCode,
      400,
    );
    const saved = instanceSchema.parse((await post(path, edit, player)).json());
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.source, created.source);
    assert.equal((await post(path, edit, player)).statusCode, 409);
    assert.equal(
      (await post(`${path}/delete`, { expectedVersion: 1 }, gm)).statusCode,
      409,
    );
    assert.equal(
      (
        await get(
          `campaigns/00000000-0000-4000-8000-000000000000/instances/${created.id}`,
          player,
        )
      ).statusCode,
      409,
    );
    assert.equal((await get(`${root}?limit=51`, player)).statusCode, 400);
    await app.close();
    app = await createApp(options);
    assert.deepEqual(
      instanceSchema.parse((await get(path, player)).json()),
      saved,
    );
    assert.equal((await get("table", player)).body, before);
    assert.equal(
      (await post(`${path}/delete`, { expectedVersion: 2 }, player)).statusCode,
      200,
    );
    assert.equal((await get(path, gm)).statusCode, 404);
    assert.equal(
      instancePageSchema.parse((await get(root, player)).json()).instances
        .length,
      0,
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
