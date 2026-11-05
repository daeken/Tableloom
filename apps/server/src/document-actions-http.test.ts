import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  defineDocumentAction,
  defineServerSystem,
} from "@tableloom/module-sdk/server";
import { system as shared } from "@tableloom/cyberpunk-red";
import { documentSchema } from "@tableloom/core/documents";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { createApp } from "./app.js";

test("document action HTTP boundary enforces origin/scope/privacy, validates input/output and survives restart without private snapshot changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tableloom-action-http-")),
    key = "action-http-fixture-not-a-real-key";
  let calls = 0;
  const system = defineServerSystem({
    ...shared,
    documentActions: [
      defineDocumentAction(shared, {
        id: "replace-notes",
        inputSchema: z
          .string()
          .min(1)
          .max(100)
          .transform((text) => ({ text: text.trim() })),
        run: ({ data, input }) => {
          calls++;
          return { ...data, notes: input.text };
        },
      }),
    ],
  });
  const options = {
    databasePath: join(dir, "table.sqlite"),
    hostKey: key,
    documentSystems: [system],
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
    });
  const get = (path: string, cookie = "") =>
    app.inject({ url: `/api/${path}`, headers: { cookie } });
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";")[0]!;
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/documents`;
  try {
    const gm = cookieOf(await post("access/setup", { key, name: "GM" }));
    const join = async (name: string) => {
      const code = (await post("access/invitations", {}, gm)).json().token;
      const response = await post("access/join", { name, code });
      return { cookie: cookieOf(response), member: response.json().member };
    };
    const alice = await join("Alice"),
      bob = await join("Bob");
    const d = documentSchema.parse(
      (
        await post(
          root,
          {
            title: "Secret fixture",
            system: {
              id: shared.manifest.id,
              version: shared.manifest.version,
            },
          },
          alice.cookie,
        )
      ).json(),
    );
    const path = `${root}/${d.id}/actions`,
      body = {
        expectedVersion: 1,
        action: "replace-notes",
        input: "  Private action body  ",
      };
    const before = (await get("table", bob.cookie)).body;
    assert.equal((await post(path, body)).statusCode, 401);
    assert.equal(
      (await post(path, body, alice.cookie, "https://foreign.invalid"))
        .statusCode,
      403,
    );
    const hidden = await post(path, body, bob.cookie);
    assert.equal(hidden.statusCode, 404);
    assert.ok(!hidden.body.includes(d.title));
    assert.equal(
      (
        await post(
          `campaigns/00000000-0000-4000-8000-000000000000/documents/${d.id}/actions`,
          body,
          alice.cookie,
        )
      ).statusCode,
      409,
    );
    for (const change of [
      { ...body, expectedVersion: 2 },
      { ...body, input: 3 },
      { ...body, action: "../code" },
      { ...body, ownerId: bob.member.id },
      { ...body, input: "x".repeat(65537) },
    ])
      assert.ok(
        [400, 409].includes(
          (await post(path, change, alice.cookie)).statusCode,
        ),
      );
    assert.equal(calls, 0);
    const response = await post(path, body, alice.cookie);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const updated = documentSchema.parse(response.json());
    assert.deepEqual(updated, {
      ...d,
      version: 2,
      data: { name: "", notes: "Private action body" },
    });
    assert.equal((await post(path, body, alice.cookie)).statusCode, 409);
    assert.equal(calls, 1);
    assert.equal((await get("table", bob.cookie)).body, before);
    await app.close();
    app = await createApp(options);
    assert.deepEqual(
      documentSchema.parse((await get(`${root}/${d.id}`, alice.cookie)).json()),
      updated,
    );
    assert.equal((await post(path, body, alice.cookie)).statusCode, 409);
    assert.equal(calls, 1);
    assert.equal((await get(`${root}/${d.id}`, bob.cookie)).statusCode, 404);
    assert.equal(
      (await post(path, { ...body, expectedVersion: 2, action: "missing" }, gm))
        .statusCode,
      400,
    );
    assert.equal(
      (await post(`access/members/${alice.member.id}/remove`, {}, gm))
        .statusCode,
      200,
    );
    assert.equal(
      (await post(path, { ...body, expectedVersion: 2 }, alice.cookie))
        .statusCode,
      401,
    );
    assert.equal(
      (await post(path, { ...body, expectedVersion: 2, input: "GM edit" }, gm))
        .statusCode,
      200,
    );
    assert.equal(calls, 2);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
