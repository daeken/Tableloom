import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.js";
import { fixturePack } from "./content-fixture.js";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { contentViewSchema, contentPageSchema } from "@tableloom/core/content";

test("content HTTP scope, pin selection, privacy, GM override/reset and restart preserve exact definitions and unrelated snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-content-http-")),
    databasePath = join(directory, "table.sqlite");
  const key = "content-http-fixture-not-a-real-key",
    pack = fixturePack(),
    options = { databasePath, hostKey: key, contentPacks: [pack] };
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
    });
  const get = (path: string, cookie = "") =>
    app.inject({ url: `/api/${path}`, headers: { cookie } });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/content`,
    definition = `${root}/${pack.id}/${pack.version}/a-public`;
  const override = {
    expectedRevision: 0,
    name: "Campaign page",
    visibility: "public",
    data: { label: "Homebrew", tags: [] },
    sources: [],
  };
  try {
    const gm = cookieOf(await post("access/setup", { key, name: "GM" }));
    const code = (await post("access/invitations", {}, gm)).json().token;
    const player = cookieOf(
      await post("access/join", { name: "Player", code }),
    );
    assert.equal((await get(root)).statusCode, 401);
    assert.deepEqual((await get(root, player)).json(), {
      definitions: [],
      next: null,
    });
    assert.equal((await get(definition, gm)).statusCode, 404);
    const campaign = (await get(`campaigns/${DEFAULT_CAMPAIGN_ID}`, gm)).json();
    const settings = {
      name: campaign.name,
      description: campaign.description,
      system: campaign.system,
      contentPacks: [{ id: pack.id, version: pack.version }],
    };
    assert.equal(
      (
        await post(
          `campaigns/${DEFAULT_CAMPAIGN_ID}/settings`,
          { expectedVersion: campaign.version, settings },
          gm,
        )
      ).statusCode,
      200,
    );
    const before = (await get("table", player)).body;
    const first = contentPageSchema.parse(
      (await get(`${root}?limit=1`, player)).json(),
    );
    assert.equal(first.definitions[0]?.reference.definitionId, "a-public");
    const second = contentPageSchema.parse(
      (
        await get(
          `${root}?limit=1&after=${encodeURIComponent(first.next!)}`,
          player,
        )
      ).json(),
    );
    assert.equal(second.definitions[0]?.reference.definitionId, "c-public");
    assert.equal(second.next, null);
    assert.ok(!JSON.stringify(first).includes("data"));
    const original = contentViewSchema.parse(
      (await get(definition, player)).json(),
    );
    assert.equal(original.revision, 0);
    assert.equal(original.overridden, false);
    const hidden = `${root}/${pack.id}/${pack.version}/b-hidden`;
    for (const path of [
      hidden,
      `${root}/${pack.id}/${pack.version}/unknown`,
      `${root}/unknown/1.0.0/a-public`,
    ]) {
      const response = await get(path, player);
      assert.equal(response.statusCode, 404);
      assert.ok(!response.body.includes("GM-ONLY"));
    }
    assert.equal(
      (await post(`${definition}/override`, override, player)).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          `${definition}/override`,
          override,
          gm,
          "https://foreign.invalid",
        )
      ).statusCode,
      403,
    );
    for (const bad of [
      { ...override, kind: "changed" },
      { ...override, data: { label: 3, tags: [] } },
      { ...override, data: { label: "x".repeat(70000), tags: [] } },
    ])
      assert.equal(
        (await post(`${definition}/override`, bad, gm)).statusCode,
        400,
      );
    const response = await post(`${definition}/override`, override, gm);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const changed = contentViewSchema.parse(response.json());
    assert.equal(changed.revision, 1);
    assert.deepEqual(changed.originSources, original.sources);
    assert.deepEqual(
      contentViewSchema.parse((await get(definition, player)).json()),
      changed,
    );
    assert.equal(
      (await post(`${definition}/override`, override, gm)).statusCode,
      409,
    );
    assert.equal((await get("table", player)).body, before);
    // Corrupt private payloads are not decoded by a public list or guessed private GET.
    assert.equal(
      (
        await post(
          `${hidden}/override`,
          { ...override, visibility: "gm", name: "Hidden edit" },
          gm,
        )
      ).statusCode,
      200,
    );
    const db = new DatabaseSync(databasePath);
    db.prepare(
      "UPDATE content_overrides SET data_json='broken hidden data' WHERE definition_id='b-hidden'",
    ).run();
    db.close();
    assert.equal((await get(hidden, player)).statusCode, 404);
    assert.equal(
      contentPageSchema.parse((await get(root, player)).json()).definitions
        .length,
      2,
    );
    assert.equal(
      (await post(`${hidden}/reset`, { expectedRevision: 1 }, gm)).statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          `${hidden}/override`,
          {
            ...override,
            expectedRevision: 2,
            name: "Explicitly shared homebrew",
          },
          gm,
        )
      ).statusCode,
      200,
    );
    const publicHomebrew = contentViewSchema.parse(
      (await get(hidden, player)).json(),
    );
    assert.deepEqual(publicHomebrew.originSources, []);
    assert.deepEqual(publicHomebrew.data, override.data);
    assert.ok(!JSON.stringify(publicHomebrew).includes("GM-ONLY-SOURCE"));
    assert.ok(
      !JSON.stringify(publicHomebrew).includes("PRIVATE-CONTENT-CANARY"),
    );
    assert.ok((await get(hidden, gm)).body.includes("GM-ONLY-SOURCE"));
    assert.equal(
      (await post(`${hidden}/reset`, { expectedRevision: 3 }, gm)).statusCode,
      200,
    );
    const wrongScope = `campaigns/00000000-0000-4000-8000-000000000000/content/${pack.id}/${pack.version}/a-public`;
    assert.equal((await get(wrongScope, player)).statusCode, 409);
    assert.equal((await get(`${root}?limit=51`, gm)).statusCode, 400);
    await app.close();
    app = await createApp(options);
    assert.deepEqual(
      contentViewSchema.parse((await get(definition, gm)).json()),
      changed,
    );
    const reset = await post(
      `${definition}/reset`,
      { expectedRevision: 1 },
      gm,
    );
    assert.equal(reset.statusCode, 200);
    const base = contentViewSchema.parse(reset.json());
    assert.equal(base.revision, 2);
    assert.equal(base.overridden, false);
    assert.deepEqual(base.data, original.data);
    assert.equal(
      (await post(`${definition}/override`, override, gm)).statusCode,
      409,
    );
    assert.equal((await get("table", player)).body, before);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
