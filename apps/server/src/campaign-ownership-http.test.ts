import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, populate, key } from "./campaign-transfer-fixture.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import { installedModules } from "./modules.js";
import { documentSystems } from "./document-modules.js";
import { createApp } from "./app.js";
import { CampaignImageInspector } from "./campaign-image-inspection.js";
import { MAX_CAMPAIGN_EXPORT_BYTES } from "./campaign-export.js";
import {
  MAX_OWNERSHIP_REVIEW_BYTES,
  type OwnershipPlan,
} from "./campaign-ownership-plan.js";

const root = "/api/campaign-imports/ownership-review";
const cookieOf = (r: { headers: Record<string, unknown> }) =>
  String(r.headers["set-cookie"]).split(";")[0]!;
function controlled() {
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
    finish() {
      assert.ok(worker);
      worker.postMessage("finish");
    },
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Image check did not start");
    await new Promise((done) => setTimeout(done, 5));
  }
}
function contents(db: DatabaseSync) {
  return JSON.stringify(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => {
        const name = String(row.name);
        return [
          name,
          db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
        ];
      }),
  );
}
async function setup(imageInspector?: CampaignImageInspector) {
  const source = fixture();
  populate(source);
  const file = source.snapshot(),
    report = inspectCampaignTransfer(
      file,
      { systems: installedModules, contentPacks: source.catalog.metadata() },
      source.catalog,
      documentSystems,
      source.db,
    ),
    directory = mkdtempSync(join(tmpdir(), "tableloom-ownership-")),
    path = join(directory, "destination.sqlite"),
    app = await createApp({
      databasePath: path,
      hostKey: key,
      contentPacks: [source.pack],
      ...(imageInspector ? { imageInspector } : {}),
    }),
    db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  const post = (
    url: string,
    payload: string | Buffer,
    cookie = "",
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        cookie,
        ...headers,
      },
      payload,
    });
  const setup = await post(
      "/api/access/setup",
      JSON.stringify({ key, name: "Destination host" }),
    ),
    cookie = cookieOf(setup),
    hostId = setup.json().member.id as string;
  const plan: OwnershipPlan = {
    version: 1,
    archiveSha256: report.archiveSha256,
    acknowledge: "reviewed-private-content-and-access",
    acknowledgeMerges: false,
    assignments: report.ownership.subjects.map((s) => ({
      sourceId: s.sourceId,
      target:
        s.sourceId === source.gm.member.id
          ? { kind: "existing", userId: hostId, role: "gm" }
          : { kind: "new", name: "Reviewed person", role: "player" },
    })),
  };
  const payload = () => JSON.stringify({ file, plan });
  return {
    source,
    app,
    db,
    file,
    plan,
    cookie,
    hostId,
    post,
    payload,
    async player() {
      const invitation = (
        await post("/api/access/invitations", "{}", cookie)
      ).json().token;
      const joined = await post(
        "/api/access/join",
        JSON.stringify({ code: invitation, name: "Local player" }),
      );
      return {
        id: joined.json().member.id as string,
        cookie: cookieOf(joined),
      };
    },
    async close() {
      db.close();
      await app.close();
      source.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("ownership review is host-only before large-body parsing, same-origin, no-store and makes no source/destination changes", async () => {
  const f = await setup();
  try {
    const player = await f.player(),
      oversized = { "content-length": String(MAX_OWNERSHIP_REVIEW_BYTES + 1) };
    assert.equal((await f.post(root, "{}", "", oversized)).statusCode, 401);
    assert.equal(
      (await f.post(root, "{}", player.cookie, oversized)).statusCode,
      403,
    );
    f.db
      .prepare("UPDATE access_memberships SET role='gm' WHERE user_id=?")
      .run(player.id);
    assert.equal(
      (await f.post(root, "{}", player.cookie, oversized)).statusCode,
      403,
    );
    assert.equal(
      (await f.post(root, "{}", f.cookie, oversized)).statusCode,
      413,
    );
    assert.equal(
      (
        await f.post(root, f.payload(), f.cookie, {
          origin: "https://foreign.invalid",
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.post(root + "?execute=true", f.payload(), f.cookie)).statusCode,
      400,
    );
    assert.equal(
      (await f.post(root, Buffer.from([0xff]), f.cookie)).statusCode,
      400,
    );
    const before = contents(f.db),
      sourceBefore = contents(f.source.db);
    const reviewed = await f.post(root, f.payload(), f.cookie);
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal(reviewed.headers["cache-control"], "no-store");
    assert.equal(reviewed.json().status, "ownership-review-only");
    assert.equal(reviewed.json().importReady, false);
    assert.equal(reviewed.json().ownershipReview.complete, true);
    assert.ok(!reviewed.json().pendingValidation.includes("ownership-plan"));
    assert.ok(reviewed.json().pendingValidation.includes("atomic-import"));
    for (const secret of ["PRIVATE FIELD", "PRIVATE CHAT", key, f.file])
      assert.ok(!reviewed.body.includes(secret));
    assert.equal(contents(f.db), before);
    assert.equal(contents(f.source.db), sourceBefore);
    const bad = {
      file: f.file,
      plan: { ...f.plan, archiveSha256: "0".repeat(64) },
    };
    assert.equal(
      (await f.post(root, JSON.stringify(bad), f.cookie)).statusCode,
      409,
    );
    assert.equal(contents(f.db), before);
  } finally {
    await f.close();
  }
});

test("ownership selection and host authorization are refreshed after image work; busy checks remain isolated", async () => {
  const control = controlled(),
    f = await setup(control.inspector);
  try {
    const player = await f.player();
    f.plan.assignments.find(
      (a) => a.sourceId === f.source.player.member.id,
    )!.target = { kind: "existing", userId: player.id, role: "player" };
    const first = f.post(root, f.payload(), f.cookie);
    await until(() => control.inspector.busy);
    assert.equal((await f.post(root, "not JSON", f.cookie)).statusCode, 409);
    assert.equal(
      (await f.app.inject({ url: "/api/table", headers: { cookie: f.cookie } }))
        .statusCode,
      200,
    );
    f.db
      .prepare(
        "UPDATE access_users SET name='Renamed during image work' WHERE id=?",
      )
      .run(player.id);
    control.finish();
    const fresh = await first;
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.ok(
      fresh
        .json()
        .ownershipReview.assignments.some(
          (a: { target: { name?: string } }) =>
            a.target.name === "Renamed during image work",
        ),
    );
    const second = f.post(root, f.payload(), f.cookie);
    await until(() => control.inspector.busy);
    f.db
      .prepare("DELETE FROM access_memberships WHERE user_id=?")
      .run(player.id);
    f.db.prepare("DELETE FROM access_users WHERE id=?").run(player.id);
    control.finish();
    const unavailable = await second;
    assert.equal(unavailable.statusCode, 409);
    assert.ok(!unavailable.body.includes(player.id));
    const third = f.post(root, f.payload(), f.cookie);
    await until(() => control.inspector.busy);
    assert.equal(
      (await f.post("/api/access/logout", "{}", f.cookie)).statusCode,
      200,
    );
    control.finish();
    assert.equal((await third).statusCode, 401);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM campaign_records").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("review preserves exact source bytes through a larger escaped envelope while raw preflight and ordinary JSON retain their limits", async () => {
  const f = await setup();
  try {
    const file =
        f.file +
        "\n".repeat(16 * 1024 * 1024 + 128 * 1024 - Buffer.byteLength(f.file)),
      plan = {
        ...f.plan,
        archiveSha256: createHash("sha256").update(file).digest("hex"),
      },
      payload = Buffer.from(JSON.stringify({ file, plan }));
    assert.ok(
      payload.length > MAX_CAMPAIGN_EXPORT_BYTES &&
        payload.length < MAX_OWNERSHIP_REVIEW_BYTES,
    );
    const before = contents(f.db);
    const reviewed = await f.post(root, payload, f.cookie);
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal(reviewed.json().archiveSha256, plan.archiveSha256);
    assert.equal(
      (await f.post("/api/campaign-imports/preflight", payload, f.cookie))
        .statusCode,
      413,
    );
    assert.equal(
      (await f.post("/api/access/logout", payload, f.cookie)).statusCode,
      413,
    );
    assert.equal(contents(f.db), before);
  } finally {
    await f.close();
  }
});
