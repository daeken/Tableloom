import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { serverMessageSchema, tableViewSchema } from "@tableloom/core";
import type { ServerMessage } from "@tableloom/core";
import { accessStatusSchema, invitationSchema } from "@tableloom/core/access";
import {
  campaignListSchema,
  campaignMembershipSchema,
  DEFAULT_CAMPAIGN_ID,
} from "@tableloom/core/campaigns";
import { createApp } from "./app.js";
import { TableStore } from "./store.js";
const KEY = "tableloom-campaign-api-fixture-not-a-real-key";
type App = Awaited<ReturnType<typeof createApp>>;
const cookieOf = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";")[0]!;
const settings = {
  name: "Brooms campaign",
  description: "Only invited members see this",
  system: { id: "kids-on-brooms", version: "0.1.0" },
  contentPacks: [],
};
const post = (
  app: App,
  path: string,
  payload: unknown,
  cookie = "",
  origin = "http://localhost",
) =>
  app.inject({
    method: "POST",
    url: `/api/${path}`,
    headers: { origin, cookie, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
const get = (app: App, path: string, cookie = "") =>
  app.inject({ url: `/api/${path}`, headers: { cookie } });
async function host(app: App) {
  return cookieOf(await post(app, "access/setup", { name: "GM", key: KEY }));
}
async function joinPlayer(
  app: App,
  gm: string,
  name: string,
  current?: string,
) {
  const invitation = invitationSchema.parse(
    (await post(app, "access/invitations", {}, gm)).json(),
  );
  const joined = await post(
    app,
    "access/join",
    {
      name,
      code: invitation.token,
      ...(current ? { keepIdentity: true } : {}),
      role: "gm",
    },
    current,
  );
  assert.equal(joined.statusCode, 200);
  return {
    cookie: cookieOf(joined),
    member: accessStatusSchema.parse(joined.json()).member!,
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Campaign update did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function connect(url: string, cookie: string, campaignId?: string) {
  const ws = new WebSocket(
    `${url.replace("http", "ws")}/api/live${campaignId ? `?campaignId=${campaignId}` : ""}`,
    { headers: { Origin: url, Cookie: cookie } },
  );
  const raw: string[] = [],
    messages: ServerMessage[] = [];
  ws.on("message", (data) => {
    raw.push(data.toString());
    messages.push(serverMessageSchema.parse(JSON.parse(data.toString())));
  });
  await once(ws, "open");
  return { ws, raw, messages };
}

test("campaign APIs authorize membership, settings and selection; signed-in invitations preserve identity", async () => {
  const app = await createApp({ databasePath: ":memory:", hostKey: KEY });
  try {
    assert.equal((await get(app, "campaigns")).statusCode, 401);
    assert.equal((await post(app, "campaigns", settings)).statusCode, 401);
    const gmA = await host(app),
      alice = await joinPlayer(app, gmA, "Alice");
    assert.equal(
      (await post(app, "campaigns", settings, alice.cookie)).statusCode,
      403,
    );
    const made = await post(app, "campaigns", settings, gmA);
    assert.equal(made.statusCode, 201);
    assert.equal(made.headers["cache-control"], "no-store");
    const campaign = campaignMembershipSchema.parse(made.json());
    assert.equal(campaign.role, "gm");
    assert.equal(
      (await get(app, "access", gmA)).json().member.tableId,
      DEFAULT_CAMPAIGN_ID,
    );
    assert.equal(
      campaignListSchema.parse((await get(app, "campaigns", gmA)).json())
        .length,
      2,
    );
    assert.equal(
      campaignListSchema.parse(
        (await get(app, "campaigns", alice.cookie)).json(),
      ).length,
      1,
    );
    for (const id of [campaign.id, randomUUID()]) {
      const denied = await get(app, `campaigns/${id}`, alice.cookie);
      assert.equal(denied.statusCode, 404);
      assert.ok(!denied.body.includes(settings.name));
      assert.equal(
        (await post(app, `campaigns/${id}/select`, {}, alice.cookie))
          .statusCode,
        404,
      );
    }
    assert.equal(
      (
        await post(
          app,
          `campaigns/${campaign.id}/settings`,
          { expectedVersion: 1, settings },
          gmA,
        )
      ).statusCode,
      409,
    );
    const selected = await post(
      app,
      `campaigns/${campaign.id}/select`,
      {},
      gmA,
    );
    const gmB = cookieOf(selected);
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json().member.tableId, campaign.id);
    assert.equal(
      selected.json().member.id,
      (await get(app, "access", gmB)).json().member.id,
    );
    assert.match(
      String(selected.headers["set-cookie"]),
      /HttpOnly; SameSite=Strict/,
    );
    assert.ok(!selected.body.includes(gmB.split("=")[1]!));
    assert.equal((await get(app, "table", gmA)).statusCode, 401);
    const bOnly = await joinPlayer(app, gmB, "B only");
    assert.equal(bOnly.member.role, "player");
    assert.equal(bOnly.member.tableId, campaign.id);
    assert.equal(
      (await get(app, `campaigns/${DEFAULT_CAMPAIGN_ID}`, bOnly.cookie))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await post(
          app,
          `campaigns/${campaign.id}/settings`,
          { expectedVersion: 1, settings },
          bOnly.cookie,
        )
      ).statusCode,
      403,
    );
    const linked = await joinPlayer(
      app,
      gmB,
      "Cannot rename Alice",
      alice.cookie,
    );
    assert.equal(linked.member.id, alice.member.id);
    assert.equal(linked.member.name, "Alice");
    assert.equal(linked.member.role, "player");
    assert.equal((await get(app, "table", alice.cookie)).statusCode, 401);
    assert.equal(
      campaignListSchema.parse(
        (await get(app, "campaigns", linked.cookie)).json(),
      ).length,
      2,
    );
    const back = await post(
      app,
      `campaigns/${DEFAULT_CAMPAIGN_ID}/select`,
      {},
      linked.cookie,
    );
    assert.equal(back.json().member.id, alice.member.id);
    assert.equal(back.json().member.tableId, DEFAULT_CAMPAIGN_ID);
    const changed = {
      ...settings,
      name: "Renamed room",
      system: { id: "kids-on-bikes", version: "0.1.0" },
    };
    assert.equal(
      (
        await post(
          app,
          `campaigns/${campaign.id}/settings`,
          { expectedVersion: 1, settings: changed },
          gmB,
        )
      ).statusCode,
      200,
    );
    assert.equal(
      tableViewSchema.parse((await get(app, "table", gmB)).json()).systemId,
      "kids-on-bikes",
    );
    assert.equal(
      (
        await post(
          app,
          `campaigns/${campaign.id}/settings`,
          { expectedVersion: 1, settings },
          gmB,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await post(
          app,
          "campaigns",
          { ...settings, system: { id: "kids-on-brooms", version: "9.9.9" } },
          gmB,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          app,
          "campaigns",
          { ...settings, path: "./arbitrary.ts" },
          gmB,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          app,
          `campaigns/${campaign.id}/select`,
          { role: "gm" },
          linked.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (await post(app, "campaigns", settings, gmB, "https://elsewhere.example"))
        .statusCode,
      403,
    );
    assert.equal(
      campaignListSchema.parse((await get(app, "campaigns", gmB)).json())
        .length,
      2,
    );
  } finally {
    await app.close();
  }
});

test("failed campaign creation or selection rolls back records and retains the original session", async () => {
  const directory = mkdtempSync(
      join(tmpdir(), "tableloom-campaign-api-rollback-"),
    ),
    databasePath = join(directory, "table.sqlite");
  const app = await createApp({ databasePath, hostKey: KEY }),
    db = new DatabaseSync(databasePath);
  try {
    const gm = await host(app);
    db.exec(
      "CREATE TRIGGER reject_api_membership BEFORE INSERT ON access_memberships WHEN NEW.table_id != '00000000-0000-4000-8000-000000000001' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    assert.equal((await post(app, "campaigns", settings, gm)).statusCode, 500);
    assert.equal((await get(app, "campaigns", gm)).json().length, 1);
    for (const table of [
      "campaign_records",
      "scene_records",
      "access_campaigns",
    ])
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
        1,
      );
    db.exec("DROP TRIGGER reject_api_membership");
    const campaign = campaignMembershipSchema.parse(
      (await post(app, "campaigns", settings, gm)).json(),
    );
    db.exec(
      "CREATE TRIGGER reject_api_session BEFORE INSERT ON access_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    const failed = await post(app, `campaigns/${campaign.id}/select`, {}, gm);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.headers["set-cookie"], undefined);
    assert.equal(
      (await get(app, "access", gm)).json().member.tableId,
      DEFAULT_CAMPAIGN_ID,
    );
    assert.equal((await get(app, "table", gm)).statusCode, 200);
    db.exec("DROP TRIGGER reject_api_session");
    assert.equal(
      (await post(app, `campaigns/${campaign.id}/select`, {}, gm)).statusCode,
      200,
    );
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live rooms isolate snapshots, presence, receipts, ownership recipients, and selection across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-live-campaigns-")),
    databasePath = join(directory, "table.sqlite");
  let app = await createApp({ databasePath, hostKey: KEY });
  const sockets: WebSocket[] = [];
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const originalGM = await host(app);
    const campaign = campaignMembershipSchema.parse(
      (await post(app, "campaigns", settings, originalGM)).json(),
    );
    const gmB = cookieOf(
      await post(app, `campaigns/${campaign.id}/select`, {}, originalGM),
    );
    const gmA = cookieOf(await post(app, "access/recover", { key: KEY }));
    const alice = await joinPlayer(app, gmA, "Alice"),
      bob = await joinPlayer(app, gmA, "Bob");
    const linked = await joinPlayer(app, gmB, "Ignored name", alice.cookie);
    const aliceA = cookieOf(
      await post(
        app,
        `campaigns/${DEFAULT_CAMPAIGN_ID}/select`,
        {},
        linked.cookie,
      ),
    );
    const recovery = invitationSchema.parse(
      (
        await post(app, `access/members/${alice.member.id}/recovery`, {}, gmB)
      ).json(),
    );
    const aliceB = cookieOf(
      await post(app, "access/join", { name: "Ignored", code: recovery.token }),
    );
    const dave = await joinPlayer(app, gmB, "Dave");
    const ga = await connect(url, gmA, DEFAULT_CAMPAIGN_ID),
      a = await connect(url, aliceA, DEFAULT_CAMPAIGN_ID),
      ba = await connect(url, bob.cookie, DEFAULT_CAMPAIGN_ID);
    const gb = await connect(url, gmB, campaign.id),
      ab = await connect(url, aliceB, campaign.id),
      db = await connect(url, dave.cookie, campaign.id);
    sockets.push(ga.ws, a.ws, ba.ws, gb.ws, ab.ws, db.ws);
    const roomA = [ga, a, ba],
      roomB = [gb, ab, db];
    await until(() =>
      [...roomA, ...roomB].every((client) =>
        client.messages.some(
          (m) => m.type === "presence" && m.participants === 3,
        ),
      ),
    );
    for (const client of [...roomA, ...roomB])
      assert.ok(
        client.messages.every((m) => m.type === "error" || m.participants <= 3),
      );
    const tokenA = randomUUID(),
      tokenB = randomUUID(),
      publicA = randomUUID(),
      privateA = randomUUID(),
      publicB = randomUUID();
    a.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "token.add",
        token: {
          id: tokenA,
          name: "A only token",
          position: { x: 0, y: 0 },
          color: "#405f4d",
        },
      }),
    );
    a.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "note.add",
        note: {
          id: publicA,
          title: "A public clue",
          body: "A campaign public text",
          visibility: "public",
        },
      }),
    );
    a.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "note.add",
        note: {
          id: privateA,
          title: "Alice private A",
          body: "A campaign private text",
          visibility: "gm",
        },
      }),
    );
    await until(() =>
      ga.messages.some(
        (m) => m.type === "snapshot" && m.state.notes.length === 2,
      ),
    );
    db.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "token.add",
        token: {
          id: tokenB,
          name: "B only token",
          position: { x: 10, y: 20 },
          color: "#405f4d",
        },
      }),
    );
    db.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "note.add",
        note: {
          id: publicB,
          title: "B public clue",
          body: "B campaign public text",
          visibility: "public",
        },
      }),
    );
    await until(() =>
      gb.messages.some(
        (m) => m.type === "snapshot" && m.state.notes.length === 1,
      ),
    );
    const sharedCommandId = randomUUID();
    a.ws.send(
      JSON.stringify({
        id: sharedCommandId,
        type: "dice.roll",
        expression: "d13",
      }),
    );
    await until(() =>
      roomA.every((client) =>
        client.messages.some(
          (m) => m.type === "snapshot" && m.state.rolls.length === 1,
        ),
      ),
    );
    db.ws.send(
      JSON.stringify({
        id: sharedCommandId,
        type: "dice.roll",
        expression: "d19",
      }),
    );
    await until(() =>
      roomB.every((client) =>
        client.messages.some(
          (m) => m.type === "snapshot" && m.state.rolls.length === 1,
        ),
      ),
    );
    for (const client of roomA)
      for (const hidden of [
        tokenB,
        publicB,
        "B campaign public text",
        "B only token",
        "1d19",
      ])
        assert.ok(!client.raw.join("").includes(hidden));
    for (const client of roomB)
      for (const hidden of [
        tokenA,
        publicA,
        privateA,
        "A campaign public text",
        "A campaign private text",
        "1d13",
      ])
        assert.ok(!client.raw.join("").includes(hidden));
    assert.ok(!ba.raw.join("").includes("A campaign private text"));
    for (const [cookie, expected, hidden] of [
      [gmA, "A campaign private text", "B campaign public text"],
      [aliceB, "B campaign public text", "A campaign private text"],
    ]) {
      const response = await get(app, "table", cookie);
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.includes(expected!));
      assert.ok(!response.body.includes(hidden!));
    }
    const guessed = randomUUID(),
      guessedStart = ab.messages.length;
    ab.ws.send(
      JSON.stringify({
        id: guessed,
        type: "note.delete",
        noteId: privateA,
        expectedVersion: 1,
      }),
    );
    await until(() =>
      ab.messages
        .slice(guessedStart)
        .some((m) => m.type === "error" && m.message.includes("unavailable")),
    );
    const invalidTransferId = randomUUID(),
      transferStart = gb.messages.length;
    gb.ws.send(
      JSON.stringify({
        id: invalidTransferId,
        type: "object.assign",
        objectId: tokenB,
        expectedOwnerId: dave.member.id,
        ownerId: bob.member.id,
      }),
    );
    await until(() =>
      gb.messages
        .slice(transferStart)
        .some(
          (m) => m.type === "error" && m.message.includes("current member"),
        ),
    );
    gb.ws.send(
      JSON.stringify({
        id: invalidTransferId,
        type: "object.assign",
        objectId: tokenB,
        expectedOwnerId: dave.member.id,
        ownerId: alice.member.id,
      }),
    );
    await until(() =>
      roomB.every((client) =>
        client.messages.some(
          (m) =>
            m.type === "snapshot" &&
            m.state.tokens[0]?.ownerId === alice.member.id,
        ),
      ),
    );
    const countA = ga.messages.length;
    const bMutationStart = ab.messages.length;
    ab.ws.send(
      JSON.stringify({
        id: randomUUID(),
        type: "token.move",
        tokenId: tokenB,
        position: { x: 77, y: 88 },
      }),
    );
    await until(() =>
      ab.messages
        .slice(bMutationStart)
        .some(
          (m) => m.type === "snapshot" && m.state.tokens[0]?.position.x === 77,
        ),
    );
    assert.equal(ga.messages.length, countA); // No room-A traffic for a room-B mutation.
    const oldClosed = once(a.ws, "close");
    const selected = await post(
      app,
      `campaigns/${campaign.id}/select`,
      {},
      aliceA,
    );
    assert.equal(selected.statusCode, 200);
    const selectedCookie = cookieOf(selected);
    assert.equal((await oldClosed)[0], 4001);
    assert.equal((await get(app, "table", aliceA)).statusCode, 401);
    const moved = await connect(url, selectedCookie, campaign.id);
    sockets.push(moved.ws);
    await until(() => moved.messages.some((m) => m.type === "snapshot"));
    assert.ok(!moved.raw.join("").includes(privateA));
    assert.ok(!moved.raw.join("").includes("A campaign private text"));
    await until(() =>
      roomB.every((client) =>
        client.messages.some(
          (m) => m.type === "presence" && m.participants === 4,
        ),
      ),
    );
    assert.ok(
      ga.messages.every((m) => m.type === "error" || m.participants <= 3),
    );
    const mismatched = await app.inject({
      url: `/api/live?campaignId=${DEFAULT_CAMPAIGN_ID}`,
      headers: { origin: "http://localhost", cookie: selectedCookie },
    });
    assert.equal(mismatched.statusCode, 409);
    const removed = once(db.ws, "close");
    assert.equal(
      (await post(app, `access/members/${dave.member.id}/remove`, {}, gmB))
        .statusCode,
      200,
    );
    assert.equal((await removed)[0], 4001);
    assert.equal((await get(app, "table", bob.cookie)).statusCode, 200);
    await app.close();
    app = await createApp({ databasePath, hostKey: KEY });
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    const again = await connect(url, selectedCookie, campaign.id);
    sockets.push(again.ws);
    await until(() =>
      again.messages.some(
        (m) => m.type === "snapshot" && m.state.tokens[0]?.position.x === 77,
      ),
    );
    assert.ok(!again.raw.join("").includes(privateA));
    const aView = tableViewSchema.parse((await get(app, "table", gmA)).json()),
      bView = tableViewSchema.parse(
        (await get(app, "table", selectedCookie)).json(),
      );
    assert.equal(aView.tokens[0]?.id, tokenA);
    assert.equal(aView.rolls[0]?.expression, "1d13");
    assert.equal(bView.rolls[0]?.expression, "1d19");
    assert.equal(bView.notes[0]?.id, publicB);
    const verifier = new TableStore(databasePath);
    try {
      assert.equal(verifier.hasCommand(sharedCommandId, campaign.id), true);
      assert.equal(verifier.hasCommand(sharedCommandId), true);
      assert.equal(verifier.hasCommand(guessed, campaign.id), false);
    } finally {
      verifier.close();
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a socket for an earlier active scene cannot apply a delayed command to a newly activated scene", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-scene-context-")),
    databasePath = join(directory, "table.sqlite");
  const app = await createApp({ databasePath, hostKey: KEY }),
    store = new TableStore(databasePath);
  let socket: WebSocket | undefined;
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" }),
      gm = await host(app);
    const live = await connect(url, gm, DEFAULT_CAMPAIGN_ID);
    socket = live.ws;
    await until(() => live.messages.some((m) => m.type === "snapshot"));
    const campaign = store.getCampaign(),
      scene = store.createScene(campaign.id, { name: "Another scene" });
    store.activateScene(campaign.id, scene.id, campaign.version);
    const commandId = randomUUID(),
      closed = once(live.ws, "close");
    live.ws.send(
      JSON.stringify({
        id: commandId,
        type: "token.add",
        token: {
          id: randomUUID(),
          name: "Stale scene marker",
          position: { x: 0, y: 0 },
          color: "#405f4d",
        },
      }),
    );
    assert.equal((await closed)[0], 4002);
    assert.equal(store.hasCommand(commandId), false);
    assert.equal(store.load().tokens.length, 0);
  } finally {
    socket?.terminate();
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
