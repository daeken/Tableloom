import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { fixture, key } from "./campaign-transfer-fixture.js";
import { parseCampaignTransfer } from "./campaign-transfer-format.js";
import { CampaignImageInspector } from "./campaign-image-inspection.js";
import { createApp } from "./app.js";
import { pngFixture, pngChunk } from "./png-fixture.js";

const cookieOf = (r: { headers: Record<string, unknown> }) =>
  String(r.headers["set-cookie"]).split(";")[0]!;
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Worker state did not settle");
    await new Promise((done) => setTimeout(done, 5));
  }
}
function controlledInspector() {
  let worker: Worker | undefined;
  const inspector = new CampaignImageInspector({
    workerFactory: () => {
      worker = new Worker(
        `const port=require('node:worker_threads').parentPort; let job; port.on('message', value => { if(value==='finish') port.postMessage({status:'ok',count:job.images.length,pixels:job.images.reduce((n,i)=>n+i.metadata.width*i.metadata.height,0)}); else job=value; });`,
        { eval: true, execArgv: [] },
      );
      return worker;
    },
  });
  return {
    inspector,
    finish: () => {
      assert.ok(worker);
      worker.postMessage("finish");
    },
  };
}
async function setup(imageInspector?: CampaignImageInspector) {
  const source = fixture();
  source.assets.upload(
    source.gm.member,
    "PRIVATE HTTP IMAGE CANARY",
    pngFixture(),
  );
  const file = source.snapshot(),
    app = await createApp({
      databasePath: ":memory:",
      hostKey: key,
      ...(imageInspector ? { imageInspector } : {}),
    });
  const post = (path: string, body: string, cookie = "") =>
    app.inject({
      method: "POST",
      url: `/api/${path}`,
      headers: {
        origin: "http://localhost",
        cookie,
        "content-type": "application/json",
      },
      payload: body,
    });
  const host = cookieOf(
    await post("access/setup", JSON.stringify({ key, name: "Destination GM" })),
  );
  return {
    source,
    app,
    file,
    host,
    post,
    preflight: (body = file) => post("campaign-imports/preflight", body, host),
    close: async () => {
      await app.close();
      source.db.close();
    },
  };
}

test("HTTP preflight decodes canonical images, rejects hash-consistent corruption/metadata and remains read-only", async () => {
  const f = await setup();
  try {
    const before = (
      await f.app.inject({ url: "/api/table", headers: { cookie: f.host } })
    ).body;
    const accepted = await f.preflight();
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.headers["cache-control"], "no-store");
    assert.equal(accepted.json().imageValidation.checked, 1);
    assert.equal(accepted.json().imageValidation.pixels, 32 * 24);
    assert.ok(!accepted.json().pendingValidation.includes("image-decoding"));
    assert.equal(accepted.json().importReady, false);
    for (const bytes of [
      pngFixture(32, 24, { packed: Buffer.from([0x78, 0x9c, 0]) }),
      pngFixture(32, 24, {
        extra: pngChunk(
          "tEXt",
          Buffer.from("secret\0PRIVATE HTTP IMAGE CANARY"),
        ),
      }),
    ]) {
      const archive = parseCampaignTransfer(f.file),
        row = archive.records.campaign_assets[0]!;
      row.bytes = bytes.toString("base64");
      row.byte_length = bytes.length;
      row.sha256 = createHash("sha256").update(bytes).digest("hex");
      const denied = await f.preflight(JSON.stringify(archive));
      assert.equal(denied.statusCode, 400);
      assert.ok(!denied.body.includes("PRIVATE HTTP IMAGE CANARY"));
    }
    assert.equal((await f.preflight()).statusCode, 200);
    assert.equal(
      (await f.app.inject({ url: "/api/table", headers: { cookie: f.host } }))
        .body,
      before,
    );
  } finally {
    await f.close();
  }
});

test("HTTP checks host revocation again after asynchronous image inspection", async () => {
  const controlled = controlledInspector(),
    f = await setup(controlled.inspector);
  try {
    const pending = f.preflight();
    await until(() => controlled.inspector.busy);
    assert.equal((await f.post("access/logout", "{}", f.host)).statusCode, 200);
    controlled.finish();
    const denied = await pending;
    assert.equal(denied.statusCode, 401);
    assert.ok(!denied.body.includes("imageValidation"));
    assert.equal(controlled.inspector.busy, false);
  } finally {
    await f.close();
  }
});

test("HTTP busy rejection happens before large upload parsing and does not block unrelated requests", async () => {
  const controlled = controlledInspector(),
    f = await setup(controlled.inspector);
  try {
    const pending = f.preflight();
    await until(() => controlled.inspector.busy);
    const busy = await f.preflight(" ".repeat(33 * 1024 * 1024));
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.headers["cache-control"], "no-store");
    assert.equal((await f.app.inject({ url: "/api/health" })).statusCode, 200);
    controlled.finish();
    assert.equal((await pending).statusCode, 200);
    assert.equal(controlled.inspector.busy, false);
  } finally {
    await f.close();
  }
});

test("a disconnected HTTP client cancels image work and releases its worker before another check", async () => {
  const controlled = controlledInspector(),
    f = await setup(controlled.inspector);
  try {
    const url = await f.app.listen({ host: "127.0.0.1", port: 0 }),
      abort = new AbortController();
    const cancelled = assert.rejects(
      fetch(url + "/api/campaign-imports/preflight", {
        method: "POST",
        signal: abort.signal,
        headers: {
          Origin: url,
          Cookie: f.host,
          "Content-Type": "application/json",
        },
        body: f.file,
      }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await until(() => controlled.inspector.busy);
    abort.abort();
    await cancelled;
    await until(() => !controlled.inspector.busy);
    const retry = f.preflight();
    await until(() => controlled.inspector.busy);
    controlled.finish();
    assert.equal((await retry).statusCode, 200);
  } finally {
    await f.close();
  }
});

test(
  "server shutdown cancels an active image check before waiting for request drainage",
  { timeout: 3000 },
  async () => {
    const controlled = controlledInspector(),
      f = await setup(controlled.inspector);
    try {
      const pending = f.preflight();
      await until(() => controlled.inspector.busy);
      await f.app.close();
      assert.equal((await pending).statusCode, 409);
      assert.equal(controlled.inspector.busy, false);
    } finally {
      await f.close();
    }
  },
);
