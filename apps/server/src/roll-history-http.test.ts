import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serverMessageSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { rollArchivePageSchema } from "@tableloom/core/roll-history";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";

const KEY = "tableloom-roll-history-api-test-not-a-real-key";
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "History live update timed out");
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

test("history API preserves privacy across archive/cleanup, live retries, reconnect, revocation, and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-roll-history-api-"));
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
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/rolls`;
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
    const a = await connect(url, alice.cookie),
      b = await connect(url, bob.cookie),
      g = await connect(url, gm);
    sockets.push(a.ws, b.ws, g.ws);
    const command = {
      id: randomUUID(),
      type: "dice.roll",
      expression: "3d7 + 9",
      visibility: "gm",
    };
    a.ws.send(JSON.stringify(command));
    await until(() =>
      a.messages.some(
        (m) => m.type === "snapshot" && m.state.rolls.length === 1,
      ),
    );
    const privateRoll = a.messages.findLast((m) => m.type === "snapshot");
    assert.ok(privateRoll?.type === "snapshot");
    const result = privateRoll.state.rolls[0]!;
    const publicCommand = {
      id: randomUUID(),
      type: "dice.roll",
      expression: "d6",
    };
    g.ws.send(JSON.stringify(publicCommand));
    await until(() =>
      b.messages.some(
        (m) => m.type === "snapshot" && m.state.rolls.length === 1,
      ),
    );
    const publicRoll = b.messages.findLast((m) => m.type === "snapshot");
    assert.ok(publicRoll?.type === "snapshot");
    const shared = publicRoll.state.rolls[0]!;
    const bobBefore = (await get("table", bob.cookie)).body,
      context = { ...b.ws.context! };
    assert.equal((await get(`${root}/archive`)).statusCode, 401);
    assert.equal(
      (await post(`${root}/archive`, { ids: [result.id] })).statusCode,
      401,
    );
    assert.equal(
      (await post(`${root}/archive`, { ids: [result.id] }, bob.cookie))
        .statusCode,
      404,
    );
    assert.equal(
      (await post(`${root}/archive`, { ids: [shared.id] }, alice.cookie))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          `${root}/archive`,
          { ids: [result.id], ownerId: bob.member.id },
          alice.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          `${root}/delete`,
          { ids: [result.id, result.id] },
          alice.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (await get(`${root}/archive?limit=51`, alice.cookie)).statusCode,
      400,
    );
    const crossOrigin = await app.inject({
      method: "POST",
      url: `/api/${root}/archive`,
      headers: { origin: "https://foreign.invalid", cookie: alice.cookie },
      payload: { ids: [result.id] },
    });
    assert.equal(crossOrigin.statusCode, 403);
    const archived = await post(
      `${root}/archive`,
      { ids: [result.id] },
      alice.cookie,
    );
    assert.equal(archived.statusCode, 200);
    assert.deepEqual(archived.json(), { affected: 1 });
    await until(() =>
      a.messages.some(
        (m) =>
          m.type === "snapshot" &&
          m.state.rolls.length === 1 &&
          m.state.rolls[0]?.id === shared.id,
      ),
    );
    assert.equal((await get("table", bob.cookie)).body, bobBefore);
    assert.deepEqual(b.ws.context, context);
    const list = await get(`${root}/archive`, alice.cookie);
    assert.equal(list.headers["cache-control"], "no-store");
    assert.deepEqual(
      rollArchivePageSchema.parse(list.json()).entries[0]?.roll,
      result,
    );
    assert.equal(
      rollArchivePageSchema.parse(
        (await get(`${root}/archive`, bob.cookie)).json(),
      ).entries.length,
      0,
    );
    // Replaying the original dice command acknowledges current state without recreating a removed result.
    a.ws.send(JSON.stringify(command));
    await until(
      () =>
        a.messages.filter(
          (m) => m.type === "snapshot" && m.state.rolls.length === 1,
        ).length >= 2,
    );
    assert.equal((await get("table", alice.cookie)).json().rolls.length, 1);
    assert.equal(
      (await post(`${root}/archive`, { ids: [result.id] }, alice.cookie))
        .statusCode,
      404,
    );
    assert.equal(
      (await post(`${root}/archive/delete`, { ids: [result.id] }, bob.cookie))
        .statusCode,
      404,
    );
    assert.equal(
      (await post(`${root}/archive`, { ids: [shared.id] }, gm)).statusCode,
      200,
    );
    await until(() =>
      b.messages.some(
        (m) => m.type === "snapshot" && m.state.rolls.length === 0,
      ),
    );
    assert.deepEqual(
      rollArchivePageSchema
        .parse((await get(`${root}/archive`, bob.cookie)).json())
        .entries.map((e) => e.roll.id),
      [shared.id],
    );
    assert.equal(
      (await post(`${root}/archive/delete`, { ids: [shared.id] }, bob.cookie))
        .statusCode,
      403,
    );
    const other = (
      await post(
        "campaigns",
        {
          name: "Other",
          description: "",
          system: { id: "cyberpunk-red", version: "0.1.0" },
          contentPacks: [],
        },
        gm,
      )
    ).json();
    assert.equal(
      (await get(`campaigns/${other.id}/rolls/archive`, gm)).statusCode,
      409,
    );
    const selected = cookieOf(
      await post(`campaigns/${other.id}/select`, {}, gm),
    );
    assert.equal(
      rollArchivePageSchema.parse(
        (await get(`campaigns/${other.id}/rolls/archive`, selected)).json(),
      ).entries.length,
      0,
    );
    assert.equal(
      (
        await post(
          `campaigns/${other.id}/rolls/archive/delete`,
          { ids: [shared.id] },
          selected,
        )
      ).statusCode,
      404,
    );
    const defaultGM = cookieOf(
      await post(`campaigns/${DEFAULT_CAMPAIGN_ID}/select`, {}, selected),
    );
    const reconnect = await connect(url, bob.cookie);
    sockets.push(reconnect.ws);
    for (const peer of [b, reconnect])
      for (const secret of [result.id, result.expression])
        assert.ok(!peer.raw.join("").includes(secret));
    sockets.forEach((ws) => ws.terminate());
    await app.close();
    app = await createApp(options);
    assert.deepEqual(
      rollArchivePageSchema
        .parse((await get(`${root}/archive`, alice.cookie)).json())
        .entries.find((e) => e.roll.id === result.id)?.roll,
      result,
    );
    assert.equal((await get("table", alice.cookie)).json().rolls.length, 0);
    assert.equal(
      (await post(`access/members/${alice.member.id}/remove`, {}, defaultGM))
        .statusCode,
      200,
    );
    assert.equal((await get(`${root}/archive`, alice.cookie)).statusCode, 401);
    assert.equal(
      (
        await post(
          `${root}/archive/delete`,
          { ids: [result.id, shared.id] },
          defaultGM,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      rollArchivePageSchema.parse(
        (await get(`${root}/archive`, defaultGM)).json(),
      ).entries.length,
      0,
    );
  } finally {
    sockets.forEach((ws) => ws.terminate());
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
