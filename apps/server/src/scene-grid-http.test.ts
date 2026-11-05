import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverMessageSchema, type ServerMessage } from "@tableloom/core";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
import { DEFAULT_GRID, gridStateSchema } from "@tableloom/core/scene-grid";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";
const KEY = "tableloom-grid-http-private-host-key";
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < end, "Grid snapshot timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("GM grid changes synchronize independently to players, guard context/auth/origin/stale requests and retain private offstage settings across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-grid-")),
    options = { databasePath: join(directory, "table.sqlite"), hostKey: KEY };
  let app = await createApp(options);
  const sockets: TestWebSocket[] = [];
  const post = (
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
      }),
    get = (path: string, cookie = "") =>
      app.inject({ url: `/api/${path}`, headers: { cookie } }),
    cookieOf = (r: { headers: Record<string, unknown> }) =>
      String(r.headers["set-cookie"]).split(";")[0]!;
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
    return {
      ws,
      messages,
      snapshots: () => messages.filter((m) => m.type === "snapshot"),
      latest: () => messages.filter((m) => m.type === "snapshot").at(-1)!,
    };
  }
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/scene-grid`,
    campaignRoot = `campaigns/${DEFAULT_CAMPAIGN_ID}`;
  try {
    let url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" })),
      player = cookieOf(
        await post("access/join", {
          name: "Player",
          code: (await post("access/invitations", {}, gm)).json().token,
        }),
      );
    let g = await connect(url, gm),
      p = await connect(url, player);
    const initial = gridStateSchema.parse((await get(root, gm)).json()),
      view = (await get("table", player)).body,
      settings = { spacing: 80.5, origin: { x: 15, y: -25 }, visible: false },
      input = { context: initial.context, expectedVersion: 0, settings };
    assert.deepEqual(initial.settings, DEFAULT_GRID);
    assert.deepEqual(g.latest().grid, p.latest().grid);
    assert.deepEqual(
      gridStateSchema.parse((await get(root, player)).json()),
      initial,
    );
    assert.equal((await get(root)).statusCode, 401);
    assert.equal((await post(root, input)).statusCode, 401);
    assert.equal((await post(root, input, player)).statusCode, 403);
    assert.equal(
      (await post(root, input, gm, "https://elsewhere.example")).statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          root,
          { ...input, settings: { ...settings, snap: true } },
          gm,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          root,
          {
            ...input,
            context: { ...input.context, sceneId: crypto.randomUUID() },
          },
          gm,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (await get(`campaigns/${crypto.randomUUID()}/scene-grid`, gm)).statusCode,
      409,
    );
    const changed = gridStateSchema.parse((await post(root, input, gm)).json());
    assert.equal(changed.version, 1);
    await until(
      () => p.latest().grid.version === 1 && g.latest().grid.version === 1,
    );
    assert.deepEqual(p.latest().grid, { version: 1, settings });
    assert.equal((await get("table", player)).body, view);
    assert.equal((await post(root, input, gm)).statusCode, 409); // Uncertain HTTP retries cannot reapply.
    assert.equal(
      (await post(root, { ...input, expectedVersion: 1 }, gm)).statusCode,
      409,
    );
    const count = p.snapshots().length;
    const offstage = (
      await post(`${campaignRoot}/scenes`, { name: "Unrevealed room" }, gm)
    ).json();
    assert.equal(
      (
        await post(
          root,
          { ...input, context: { ...input.context, sceneId: offstage.id } },
          gm,
        )
      ).statusCode,
      409,
    );
    const hiddenSettings = {
        spacing: 222,
        origin: { x: 9876, y: -5432 },
        visible: true,
      },
      db = new DatabaseSync(options.databasePath);
    db.prepare("INSERT INTO scene_grids VALUES(?,?,1,?)").run(
      DEFAULT_CAMPAIGN_ID,
      offstage.id,
      JSON.stringify(hiddenSettings),
    );
    db.close();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(p.snapshots().length, count);
    assert.ok(!JSON.stringify(p.messages).includes("9876"));
    assert.ok(!JSON.stringify(p.messages).includes("Unrevealed room"));
    // Scene activation switches grids, and an away/back generation invalidates a retained draft.
    const active = (
      await post(
        `${campaignRoot}/activate`,
        { sceneId: offstage.id, expectedVersion: initial.context.generation },
        gm,
      )
    ).json();
    await until(() => p.latest().context.sceneId === offstage.id);
    assert.deepEqual(p.latest().grid.settings, hiddenSettings);
    await post(
      `${campaignRoot}/activate`,
      { sceneId: initial.context.sceneId, expectedVersion: active.version },
      gm,
    );
    await until(() => p.latest().context.sceneId === initial.context.sceneId);
    assert.deepEqual(p.latest().grid.settings, settings);
    assert.equal(
      (
        await post(
          root,
          { ...input, expectedVersion: 1, settings: DEFAULT_GRID },
          gm,
        )
      ).statusCode,
      409,
    );
    const current = gridStateSchema.parse((await get(root, gm)).json());
    assert.equal(
      (
        await post(
          root,
          {
            context: current.context,
            expectedVersion: 1,
            settings: { ...settings, visible: true },
          },
          gm,
        )
      ).statusCode,
      200,
    );
    await until(() => p.latest().grid.version === 2);
    assert.equal(p.latest().grid.settings.visible, true);
    for (const ws of sockets) ws.terminate();
    await app.close();
    app = await createApp(options);
    url = await app.listen({ port: 0, host: "127.0.0.1" });
    g = await connect(url, gm);
    p = await connect(url, player);
    assert.deepEqual(p.latest().grid, {
      version: 2,
      settings: { ...settings, visible: true },
    });
    assert.deepEqual(g.latest().grid, p.latest().grid);
    assert.ok(!JSON.stringify(p.messages).includes("9876"));
    assert.deepEqual(
      gridStateSchema.parse((await get(root, gm)).json()).context,
      current.context,
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
