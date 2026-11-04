import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentSchema, documentPageSchema } from "@tableloom/core/documents";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";

const KEY = "tableloom-documents-http-fixture-not-a-real-key";
const pin = { id: "cyberpunk-red", version: "0.1.0" };

test("document API enforces scope, privacy, ownership, optimistic edits, revocation, and restart without growing snapshots", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-documents-http-"));
  const options = {
    databasePath: join(directory, "table.sqlite"),
    hostKey: KEY,
  };
  let app = await createApp(options);
  const sockets: TestWebSocket[] = [];
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
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/documents`;
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" }));
    const joinPlayer = async (name: string) => {
      const code = (await post("access/invitations", {}, gm)).json().token;
      const response = await post("access/join", { name, code });
      return { cookie: cookieOf(response), member: response.json().member };
    };
    const alice = await joinPlayer("Alice"),
      bob = await joinPlayer("Bob");
    const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
      headers: { Cookie: bob.cookie, Origin: url },
    });
    sockets.push(ws);
    const raw: string[] = [],
      messages: ServerMessage[] = [];
    ws.on("message", (data) => {
      raw.push(data.toString());
      messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
    });
    await once(ws, "open");
    await contextReady(ws);
    const context = { ...ws.context! },
      initial = (await get("table", bob.cookie)).body;
    assert.equal((await get(root)).statusCode, 401);
    assert.equal(
      (await post(root, { title: "No session", system: pin })).statusCode,
      401,
    );
    assert.equal(
      (
        await post(
          root,
          { title: "Spoof", system: pin, ownerId: randomUUID() },
          alice.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          root,
          {
            title: "Invalid",
            system: pin,
            data: { name: "", notes: "", mechanics: 1 },
          },
          alice.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          root,
          {
            title: "Oversize",
            system: pin,
            data: { name: "", notes: "x".repeat(65536) },
          },
          alice.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          root,
          { title: "Stale pin", system: { ...pin, version: "9.9.9" } },
          alice.cookie,
        )
      ).statusCode,
      409,
    );
    const response = await post(
      root,
      {
        title: "Unrevealed document title",
        system: pin,
        data: { name: "Scout", notes: "Unrevealed document body" },
      },
      alice.cookie,
    );
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers["cache-control"], "no-store");
    let document = documentSchema.parse(response.json());
    assert.equal(document.ownerId, alice.member.id);
    assert.equal(document.visibility, "gm");
    assert.equal((await get(`${root}/${document.id}`, gm)).statusCode, 200);
    assert.deepEqual(
      documentPageSchema.parse((await get(root, bob.cookie)).json()),
      { documents: [], next: null },
    );
    for (const suffix of ["", "/delete", "/migrate"]) {
      const denied = suffix
        ? await post(
            `${root}/${document.id}${suffix}`,
            { expectedVersion: 1 },
            bob.cookie,
          )
        : await get(`${root}/${document.id}`, bob.cookie);
      assert.equal(denied.statusCode, 404);
      assert.ok(!denied.body.includes(document.title));
    }
    assert.equal((await get(`${root}?limit=51`, bob.cookie)).statusCode, 400);
    assert.equal((await get(`${root}?after=bad`, bob.cookie)).statusCode, 400);
    assert.equal(
      (await get(`${root}?secret=true`, bob.cookie)).statusCode,
      400,
    );
    const update = {
      expectedVersion: 1,
      title: document.title,
      visibility: "public",
      data: document.data,
    };
    const foreignOrigin = await app.inject({
      method: "POST",
      url: `/api/${root}/${document.id}`,
      headers: { origin: "https://foreign.invalid", cookie: alice.cookie },
      payload: update,
    });
    assert.equal(foreignOrigin.statusCode, 403);
    document = documentSchema.parse(
      (await post(`${root}/${document.id}`, update, alice.cookie)).json(),
    );
    const page = documentPageSchema.parse(
      (await get(`${root}?limit=1`, bob.cookie)).json(),
    );
    assert.equal(page.documents[0]?.id, document.id);
    assert.equal("data" in page.documents[0]!, false);
    assert.deepEqual(
      documentSchema.parse(
        (await get(`${root}/${document.id}`, bob.cookie)).json(),
      ),
      document,
    );
    assert.equal(
      (
        await post(
          `${root}/${document.id}`,
          { ...update, expectedVersion: 2 },
          bob.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          `${root}/${document.id}/delete`,
          { expectedVersion: 2 },
          bob.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          `${root}/${document.id}/migrate`,
          { expectedVersion: 2 },
          alice.cookie,
        )
      ).statusCode,
      403,
    );
    assert.equal(
      (await post(`${root}/${document.id}/migrate`, { expectedVersion: 2 }, gm))
        .statusCode,
      409,
    );
    assert.equal(
      (await post(`${root}/${document.id}`, update, gm)).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          `${root}/${document.id}/delete`,
          { expectedVersion: 1 },
          alice.cookie,
        )
      ).statusCode,
      409,
    );
    document = documentSchema.parse(
      (
        await post(
          `${root}/${document.id}`,
          { ...update, expectedVersion: 2, visibility: "gm" },
          gm,
        )
      ).json(),
    );
    assert.equal(
      (await get(`${root}/${document.id}`, bob.cookie)).statusCode,
      404,
    );
    assert.equal((await get("table", bob.cookie)).body, initial);
    assert.deepEqual(ws.context, context);
    // A public live command is an ordering barrier: no document bodies/metadata enter any snapshot.
    ws.send(
      JSON.stringify({ id: randomUUID(), type: "dice.roll", expression: "d6" }),
    );
    const deadline = Date.now() + 4000;
    while (
      !messages.some((m) => m.type === "snapshot" && m.state.rolls.length === 1)
    ) {
      assert.ok(Date.now() < deadline, "Live ordering barrier timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const secret of [
      document.id,
      document.title,
      "Unrevealed document body",
    ])
      assert.ok(!raw.join("").includes(secret));
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
    assert.equal(
      (await get(`campaigns/${other.id}/documents`, gm)).statusCode,
      409,
    );
    const selected = cookieOf(
      await post(`campaigns/${other.id}/select`, {}, gm),
    );
    const foreign = documentSchema.parse(
      (
        await post(
          `campaigns/${other.id}/documents`,
          {
            title: "Other campaign public",
            system: other.system,
            visibility: "public",
          },
          selected,
        )
      ).json(),
    );
    assert.equal(
      (await get(`${root}/${foreign.id}`, alice.cookie)).statusCode,
      404,
    );
    assert.equal(
      (await get(`campaigns/${other.id}/documents/${document.id}`, selected))
        .statusCode,
      404,
    );
    const defaultGM = cookieOf(
      await post(`campaigns/${DEFAULT_CAMPAIGN_ID}/select`, {}, selected),
    );
    ws.terminate();
    await app.close();
    app = await createApp(options);
    assert.deepEqual(
      documentSchema.parse(
        (await get(`${root}/${document.id}`, alice.cookie)).json(),
      ),
      document,
    );
    assert.equal(
      (await get(`${root}/${document.id}`, bob.cookie)).statusCode,
      404,
    );
    assert.equal(
      (await post(`access/members/${alice.member.id}/remove`, {}, defaultGM))
        .statusCode,
      200,
    );
    assert.equal(
      (await get(`${root}/${document.id}`, alice.cookie)).statusCode,
      401,
    );
    assert.equal(
      (await get(`${root}/${document.id}`, defaultGM)).statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          `${root}/${document.id}/delete`,
          { expectedVersion: document.version },
          defaultGM,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      (await get(`${root}/${document.id}`, defaultGM)).statusCode,
      404,
    );
  } finally {
    sockets.forEach((ws) => ws.terminate());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
