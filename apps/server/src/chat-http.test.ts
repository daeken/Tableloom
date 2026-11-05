import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "./app.js";
import { TestWebSocket, contextReady } from "./test-client.js";
import { chatPageSchema, chatMessageSchema } from "@tableloom/core/chat";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";
const KEY = "tableloom-chat-http-test-private-key";
test("chat stays campaign-scoped across authenticated selection even for the same host identity", async () => {
  const app = await createApp({ databasePath: ":memory:", hostKey: KEY });
  const cookieOf = (r: { headers: Record<string, unknown> }) =>
    String(r.headers["set-cookie"]).split(";")[0]!;
  const post = (path: string, body: unknown, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: {
        cookie,
        origin: "http://localhost",
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  const get = (path: string, cookie: string) =>
    app.inject({ url: `/api/${path}`, headers: { cookie } });
  try {
    const setup = await post("access/setup", { key: KEY, name: "GM" }),
      cookie = cookieOf(setup),
      id = setup.json().member.id;
    const oldRoot = `campaigns/${DEFAULT_CAMPAIGN_ID}/chat`;
    assert.equal(
      (
        await post(
          oldRoot,
          {
            id: crypto.randomUUID(),
            expectedAuthorId: id,
            body: "First campaign secret",
            audience: "gm",
          },
          cookie,
        )
      ).statusCode,
      200,
    );
    const made = await post(
      "campaigns",
      {
        name: "Other campaign",
        description: "",
        system: { id: "kids-on-brooms", version: "0.1.0" },
        contentPacks: [],
      },
      cookie,
    );
    assert.equal(made.statusCode, 201);
    const otherId = made.json().id,
      newCookie = cookieOf(
        await post(`campaigns/${otherId}/select`, {}, cookie),
      ),
      newRoot = `campaigns/${otherId}/chat`;
    assert.equal((await get(oldRoot, newCookie)).statusCode, 409);
    assert.equal(
      (
        await post(
          oldRoot,
          {
            id: crypto.randomUUID(),
            expectedAuthorId: id,
            body: "Delayed old panel",
            audience: "public",
          },
          newCookie,
        )
      ).statusCode,
      409,
    );
    assert.equal((await get(oldRoot, cookie)).statusCode, 401);
    const page = chatPageSchema.parse((await get(newRoot, newCookie)).json());
    assert.deepEqual(page.messages, []);
    assert.equal(page.campaignId, otherId);
    const back = cookieOf(
      await post(`campaigns/${DEFAULT_CAMPAIGN_ID}/select`, {}, newCookie),
    );
    assert.equal(
      chatPageSchema.parse((await get(oldRoot, back)).json()).messages[0]!.body,
      "First campaign secret",
    );
  } finally {
    await app.close();
  }
});
test("authenticated chat HTTP filters campaign/audience, guards origin/rate/spoofing, stays out of sockets/scenes, and survives restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tableloom-chat-")),
    options = { databasePath: join(dir, "table.sqlite"), hostKey: KEY };
  let app = await createApp(options);
  const sockets: TestWebSocket[] = [];
  const post = async (
      path: string,
      body: unknown,
      cookie = "",
      origin = "http://localhost",
    ) => {
      const authorId =
        path.endsWith("/chat") && cookie
          ? (
              await app.inject({ url: "/api/access", headers: { cookie } })
            ).json().member?.id
          : crypto.randomUUID();
      return app.inject({
        method: "POST",
        url: `/api/${path}`,
        headers: { cookie, origin, "content-type": "application/json" },
        payload: JSON.stringify(
          path.endsWith("/chat")
            ? { expectedAuthorId: authorId, ...(body as object) }
            : body,
        ),
      });
    },
    get = (path: string, cookie = "") =>
      app.inject({ url: `/api/${path}`, headers: { cookie } }),
    cookieOf = (r: { headers: Record<string, unknown> }) =>
      String(r.headers["set-cookie"]).split(";")[0]!,
    input = (body: string, audience: "public" | "gm" = "public") => ({
      id: crypto.randomUUID(),
      body,
      audience,
    });
  const root = `campaigns/${DEFAULT_CAMPAIGN_ID}/chat`;
  try {
    const url = await app.listen({ port: 0, host: "127.0.0.1" });
    const gm = cookieOf(await post("access/setup", { key: KEY, name: "GM" }));
    const joinUser = async (name: string) =>
      cookieOf(
        await post("access/join", {
          name,
          code: (await post("access/invitations", {}, gm)).json().token,
        }),
      );
    const a = await joinUser("Alice"),
      b = await joinUser("Bob");
    for (const cookie of [gm, a, b]) {
      const ws = new TestWebSocket(`${url.replace("http", "ws")}/api/live`, {
        headers: { Cookie: cookie, Origin: url },
      });
      sockets.push(ws);
      await once(ws, "open");
      await contextReady(ws);
    }
    await new Promise((r) => setTimeout(r, 30)); // Let the preceding join rosters drain before measuring chat.
    const frames: string[] = [];
    for (const ws of sockets)
      ws.on("message", (raw) => frames.push(raw.toString()));
    const before = (await get("table", a)).body;
    assert.equal((await get(root)).statusCode, 401);
    assert.equal((await post(root, input("unauth"))).statusCode, 401);
    assert.equal(
      (await post(root, input("wrong origin"), a, "https://elsewhere.example"))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await post(
          root,
          { ...input("forged"), authorId: crypto.randomUUID() },
          a,
        )
      ).statusCode,
      400,
    );
    const publicMessage = chatMessageSchema.parse(
      (await post(root, input("Public <b>literal</b>"), a)).json(),
    );
    const aPrivate = chatMessageSchema.parse(
      (await post(root, input("Alice secret", "gm"), a)).json(),
    );
    await post(root, input("Bob secret", "gm"), b);
    await post(root, input("GM secret", "gm"), gm);
    const aPage = chatPageSchema.parse((await get(root, a)).json()),
      bPage = chatPageSchema.parse((await get(root, b)).json()),
      gmPage = chatPageSchema.parse((await get(root, gm)).json());
    assert.deepEqual(
      aPage.messages.map((m) => m.id),
      [publicMessage.id, aPrivate.id],
    );
    assert.equal(bPage.messages.length, 2);
    assert.ok(!JSON.stringify(bPage).includes("Alice secret"));
    assert.equal(gmPage.messages.length, 4);
    assert.ok(!JSON.stringify(aPage).includes("Bob secret"));
    assert.equal((await get(root, a)).headers["cache-control"], "no-store");
    assert.equal(
      (await get(`${root}?authorId=${aPrivate.authorId}`, b)).statusCode,
      400,
    );
    assert.equal(
      (await get(`campaigns/${crypto.randomUUID()}/chat`, a)).statusCode,
      409,
    );
    assert.equal(
      (await post(`campaigns/${crypto.randomUUID()}/chat`, input("foreign"), a))
        .statusCode,
      409,
    );
    assert.equal(
      (await post(root, input("x".repeat(17000)), a)).statusCode,
      413,
    );
    for (let i = 0; i < 17; i++)
      assert.equal((await post(root, input(`rate${i}`), a)).statusCode, 200);
    assert.equal((await post(root, input("rate blocked"), a)).statusCode, 429);
    assert.equal(
      (await post(root, input("independent player"), b)).statusCode,
      200,
    );
    assert.equal(
      (
        await post(
          root,
          { ...input("wrong identity"), expectedAuthorId: crypto.randomUUID() },
          b,
        )
      ).statusCode,
      409,
    );
    assert.equal((await get("table", a)).body, before);
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(frames, []); // No private activity signal or chat bodies on the scene transport.
    const saved = chatPageSchema.parse((await get(root, a)).json());
    for (const ws of sockets) ws.terminate();
    await app.close();
    app = await createApp(options);
    assert.deepEqual(chatPageSchema.parse((await get(root, a)).json()), saved);
    const removed = await post(
      `access/members/${aPrivate.authorId}/remove`,
      {},
      gm,
    );
    assert.equal(removed.statusCode, 200);
    assert.equal((await get(root, a)).statusCode, 401);
    assert.equal((await post(root, input("removed"), a)).statusCode, 401);
    assert.ok(
      JSON.stringify(
        chatPageSchema.parse((await get(root, gm)).json()),
      ).includes("Alice secret"),
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
