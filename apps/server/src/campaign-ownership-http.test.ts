import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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
  parseOwnershipPlan,
} from "./campaign-ownership-plan.js";

function importPayload(
  file: string,
  rawPlan: OwnershipPlan,
  requestId = randomUUID(),
) {
  const plan = parseOwnershipPlan(rawPlan);
  return JSON.stringify({
    file,
    plan,
    requestId,
    resourcePolicy: "fresh-campaign-and-resource-identifiers",
    confirm: "create-new-campaign",
    expectedPlanSha256: createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex"),
  });
}

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
    const third = f.post(
      "/api/campaign-imports/prepare",
      JSON.stringify({
        file: f.file,
        plan: f.plan,
        resourcePolicy: "fresh-campaign-and-resource-identifiers",
      }),
      f.cookie,
    );
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

test("candidate preflight is host-only, requires the fresh-ID policy, returns summary only and never reserves or writes a campaign", async () => {
  const f = await setup();
  try {
    const path = "/api/campaign-imports/prepare",
      input = {
        file: f.file,
        plan: f.plan,
        resourcePolicy: "fresh-campaign-and-resource-identifiers",
      },
      payload = JSON.stringify(input),
      player = await f.player(),
      oversized = { "content-length": String(MAX_OWNERSHIP_REVIEW_BYTES + 1) };
    assert.equal((await f.post(path, "{}", "", oversized)).statusCode, 401);
    assert.equal(
      (await f.post(path, "{}", player.cookie, oversized)).statusCode,
      403,
    );
    assert.equal(
      (await f.post(path, "{}", f.cookie, oversized)).statusCode,
      413,
    );
    assert.equal((await f.post(path, f.payload(), f.cookie)).statusCode, 400);
    assert.equal(
      (
        await f.post(
          path,
          JSON.stringify({
            ...input,
            resourcePolicy: "reuse-source-identifiers",
          }),
          f.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.post(path, payload, f.cookie, {
          origin: "https://foreign.invalid",
        })
      ).statusCode,
      403,
    );
    const before = contents(f.db),
      sourceBefore = contents(f.source.db),
      response = await f.post(path, payload, f.cookie);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    const report = response.json();
    assert.equal(report.status, "candidate-preflight-only");
    assert.equal(report.importReady, false);
    assert.equal(report.resourcePlan.complete, true);
    assert.equal(report.candidateValidation.complete, true);
    assert.deepEqual(report.pendingValidation, ["atomic-import"]);
    assert.match(report.resourcePlan.candidateSha256, /^[a-f0-9]{64}$/);
    assert.equal(
      f.db
        .prepare("SELECT 1 FROM campaign_records WHERE id=?")
        .get(report.resourcePlan.targetCampaignId),
      undefined,
    );
    for (const privateKey of ["prepared", "candidate", "records", "newUsers"])
      assert.ok(!Object.hasOwn(report, privateKey));
    for (const secret of ["PRIVATE FIELD", "PRIVATE CHAT", key, f.file])
      assert.ok(!response.body.includes(secret));
    const again = await f.post(path, payload, f.cookie);
    assert.equal(again.statusCode, 200, again.body);
    assert.notEqual(
      again.json().resourcePlan.targetCampaignId,
      report.resourcePlan.targetCampaignId,
    );
    assert.equal(contents(f.db), before);
    assert.equal(contents(f.source.db), sourceBefore);
  } finally {
    await f.close();
  }
});

test("candidate preparation leaves all mapped checks pending when ownership still requires merge acknowledgement", async () => {
  const f = await setup();
  try {
    const plan = {
        ...f.plan,
        assignments: f.plan.assignments.map((a) => ({
          sourceId: a.sourceId,
          target: { kind: "existing", userId: f.hostId, role: "gm" },
        })),
      },
      before = contents(f.db),
      response = await f.post(
        "/api/campaign-imports/prepare",
        JSON.stringify({
          file: f.file,
          plan,
          resourcePolicy: "fresh-campaign-and-resource-identifiers",
        }),
        f.cookie,
      );
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().resourcePlan.complete, false);
    assert.equal(response.json().resourcePlan.targetCampaignId, null);
    assert.ok(
      response
        .json()
        .blockers.includes("identity_merge_acknowledgement_required"),
    );
    for (const pending of [
      "ownership-plan",
      "resource-id-plan",
      "mapped-history-graph",
      "mapped-storage-quotas",
      "mapped-module-references",
      "atomic-import",
    ])
      assert.ok(response.json().pendingValidation.includes(pending));
    assert.equal(contents(f.db), before);
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

test("import writes are host-only and explicitly confirmed, create one durable campaign on retries, preserve privacy and never switch the active session", async () => {
  const f = await setup();
  try {
    const path = "/api/campaign-imports/import",
      payload = importPayload(f.file, f.plan),
      player = await f.player(),
      oversized = { "content-length": String(MAX_OWNERSHIP_REVIEW_BYTES + 1) };
    assert.equal((await f.post(path, "{}", "", oversized)).statusCode, 401);
    assert.equal(
      (await f.post(path, "{}", player.cookie, oversized)).statusCode,
      403,
    );
    f.db
      .prepare("UPDATE access_memberships SET role='gm' WHERE user_id=?")
      .run(player.id);
    assert.equal((await f.post(path, payload, player.cookie)).statusCode, 403);
    f.db
      .prepare("UPDATE access_memberships SET role='player' WHERE user_id=?")
      .run(player.id);
    assert.equal(
      (await f.post(path, "{}", f.cookie, oversized)).statusCode,
      413,
    );
    assert.equal(
      (
        await f.post(path, payload, f.cookie, {
          origin: "https://foreign.invalid",
        })
      ).statusCode,
      403,
    );
    const missing = JSON.parse(payload);
    delete missing.confirm;
    assert.equal(
      (await f.post(path, JSON.stringify(missing), f.cookie)).statusCode,
      400,
    );
    assert.equal(
      (
        await f.post(
          path,
          JSON.stringify({ ...JSON.parse(payload), overwrite: true }),
          f.cookie,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.post(
          path,
          JSON.stringify({
            ...JSON.parse(payload),
            expectedPlanSha256: "0".repeat(64),
          }),
          f.cookie,
        )
      ).statusCode,
      409,
    );
    const sourceBefore = contents(f.source.db),
      destinationBefore = f.db
        .prepare("SELECT COUNT(*) AS n FROM campaign_records")
        .get()!.n;
    const response = await f.post(path, payload, f.cookie);
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["set-cookie"], undefined);
    const result = response.json();
    assert.equal(result.status, "imported");
    assert.equal(result.replayed, false);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM campaign_records").get()!.n,
      Number(destinationBefore) + 1,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/access",
          headers: { cookie: f.cookie },
        })
      ).json().member.tableId,
      f.source.gm.member.tableId,
    );
    for (const secret of ["PRIVATE FIELD", "PRIVATE CHAT", key, f.file])
      assert.ok(!response.body.includes(secret));
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM access_memberships WHERE user_id=? AND table_id=?",
        )
        .get(player.id, result.campaign.id)!.n,
      0,
    );
    const beforeReplay = contents(f.db),
      replay = await f.post(path, payload, f.cookie);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().campaign.id, result.campaign.id);
    assert.equal(contents(f.db), beforeReplay);
    assert.equal(contents(f.source.db), sourceBefore);
    // Claim the explicitly created member through the existing GM recovery workflow.
    const selected = await f.post(
      `/api/campaigns/${result.campaign.id}/select`,
      "{}",
      f.cookie,
    );
    assert.equal(selected.statusCode, 200, selected.body);
    const hostCookie = cookieOf(selected),
      member = f.db
        .prepare(
          "SELECT user_id FROM access_memberships WHERE table_id=? AND role='player'",
        )
        .get(result.campaign.id)!;
    const recovery = await f.post(
      `/api/access/members/${String(member.user_id)}/recovery`,
      "{}",
      hostCookie,
    );
    assert.equal(recovery.statusCode, 200, recovery.body);
    const joined = await f.post(
      "/api/access/join",
      JSON.stringify({ code: recovery.json().token, name: "Ignored name" }),
    );
    assert.equal(joined.statusCode, 200, joined.body);
    const importedPlayer = cookieOf(joined);
    const scene = f.db
      .prepare("SELECT id,state_json FROM scene_records WHERE campaign_id=?")
      .all(result.campaign.id)
      .find((row) => JSON.parse(String(row.state_json)).tokens.length)!;
    const active = await f.post(
      `/api/campaigns/${result.campaign.id}/activate`,
      JSON.stringify({
        sceneId: scene.id,
        expectedVersion: result.campaign.version,
      }),
      hostCookie,
    );
    assert.equal(active.statusCode, 200, active.body);
    const table = await f.app.inject({
      url: "/api/table",
      headers: { cookie: importedPlayer },
    });
    assert.equal(table.statusCode, 200);
    assert.equal(table.json().tokens[0].ownerId, joined.json().member.id);
    assert.equal(joined.json().member.role, "player");
    const background = await f.app.inject({
      url: `/api/campaigns/${result.campaign.id}/scene-map`,
      headers: { cookie: importedPlayer },
    });
    assert.equal(background.statusCode, 403);
    const map = f.db
      .prepare(
        "SELECT image_id FROM scene_backgrounds WHERE campaign_id=? AND scene_id=?",
      )
      .get(result.campaign.id, String(scene.id))!;
    const image = `/api/campaigns/${result.campaign.id}/scene-map/${String(scene.id)}/${String(map.image_id)}/content`;
    assert.equal(
      (await f.app.inject({ url: image, headers: { cookie: importedPlayer } }))
        .statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject({ url: image, headers: { cookie: hostCookie } }))
        .statusCode,
      200,
    );
    assert.ok(!table.body.includes(String(map.image_id)));
    assert.equal(
      f.db.prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get(),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("import rejects changed package bindings and revoked host sessions after asynchronous image checks without writing anything", async () => {
  const control = controlled(),
    f = await setup(control.inspector);
  try {
    const path = "/api/campaign-imports/import",
      payload = importPayload(f.file, f.plan),
      pending = f.post(path, payload, f.cookie);
    await until(() => control.inspector.busy);
    const binding = f.db
      .prepare(
        "SELECT digest FROM content_pack_bindings WHERE pack_id=? AND pack_version=?",
      )
      .get(f.source.pack.id, f.source.pack.version)!;
    f.db
      .prepare(
        "UPDATE content_pack_bindings SET digest=? WHERE pack_id=? AND pack_version=?",
      )
      .run("0".repeat(64), f.source.pack.id, f.source.pack.version);
    const changed = contents(f.db);
    control.finish();
    const rejected = await pending;
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal(contents(f.db), changed);
    f.db
      .prepare(
        "UPDATE content_pack_bindings SET digest=? WHERE pack_id=? AND pack_version=?",
      )
      .run(String(binding.digest), f.source.pack.id, f.source.pack.version);
    const again = f.post(path, payload, f.cookie);
    await until(() => control.inspector.busy);
    assert.equal(
      (await f.post("/api/access/logout", "{}", f.cookie)).statusCode,
      200,
    );
    const revoked = contents(f.db);
    control.finish();
    assert.equal((await again).statusCode, 401);
    assert.equal(contents(f.db), revoked);
    assert.equal(
      f.db.prepare("SELECT COUNT(*) AS n FROM campaign_import_requests").get()!
        .n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("import people directory is host-only, strictly paginated and read-only; membership-free attribution profiles are excluded", async () => {
  const f = await setup();
  try {
    const path = "/api/campaign-imports/people",
      get = (url = path, cookie = f.cookie) =>
        f.app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal((await get(path, "")).statusCode, 401);
    const player = await f.player();
    assert.equal((await get(path, player.cookie)).statusCode, 403);
    f.db
      .prepare("UPDATE access_memberships SET role='gm' WHERE user_id=?")
      .run(player.id);
    assert.equal(
      (await get(path, player.cookie)).statusCode,
      403,
      "A campaign GM is not the server host",
    );
    for (const query of [
      "?unexpected=1",
      "?after=not-a-uuid",
      `?q=${"x".repeat(33)}`,
    ])
      assert.equal((await get(path + query)).statusCode, 400);
    const tableId = String(
      f.db
        .prepare(
          "SELECT table_id FROM access_memberships WHERE user_id=? LIMIT 1",
        )
        .get(f.hostId)!.table_id,
    );
    const orphan = randomUUID();
    f.db
      .prepare("INSERT INTO access_users(id,name,created_at) VALUES(?,?,0)")
      .run(orphan, "Unclaimed identity");
    const people = Array.from({ length: 105 }, (_, i) => ({
      id: randomUUID(),
      name:
        i < 2
          ? "Same local name"
          : i === 2
            ? "Zoë literal%"
            : "Listed person " + i,
    }));
    for (const person of people) {
      f.db
        .prepare("INSERT INTO access_users(id,name,created_at) VALUES(?,?,0)")
        .run(person.id, person.name);
      f.db
        .prepare(
          "INSERT INTO access_memberships(user_id,table_id,role) VALUES(?,?,'player')",
        )
        .run(person.id, tableId);
    }
    const before = contents(f.db),
      first = await get();
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["cache-control"], "no-store");
    const a = first.json() as {
      host: { id: string; name: string };
      people: { id: string; name: string }[];
      nextCursor: string | null;
    };
    assert.equal(a.host.id, f.hostId);
    assert.equal(a.people.length, 100);
    assert.equal(a.nextCursor, a.people.at(-1)!.id);
    const second = await get(path + "?after=" + a.nextCursor),
      b = second.json() as typeof a;
    assert.equal(second.statusCode, 200);
    assert.equal(b.nextCursor, null);
    const combined = [...a.people, ...b.people];
    assert.equal(new Set(combined.map((p) => p.id)).size, 107);
    assert.ok(!combined.some((p) => p.id === orphan));
    assert.ok(
      combined.every((p) => Object.keys(p).sort().join(",") === "id,name"),
    );
    const matches = await get(path + "?q=Same%20local"),
      same = matches.json() as typeof a;
    assert.equal(same.people.length, 2);
    assert.notEqual(same.people[0]!.id, same.people[1]!.id);
    const literal = await get(path + "?q=%25");
    assert.equal(
      literal.json().people.length,
      1,
      "Search treats % literally rather than as a wildcard",
    );
    assert.equal(contents(f.db), before);
    const logout = await f.post("/api/access/logout", "{}", f.cookie);
    assert.equal(logout.statusCode, 200);
    assert.equal((await get()).statusCode, 401);
  } finally {
    await f.close();
  }
});

test("file-result status is host-only, byte-exact, read-only and available during image work; saved results survive changed retry choices", async () => {
  const c = controlled(),
    f = await setup(c.inspector),
    root = "/api/campaign-imports/status";
  try {
    assert.equal((await f.post(root, f.file)).statusCode, 401);
    assert.equal(
      (
        await f.post(root, f.file, f.cookie, {
          origin: "https://elsewhere.example",
        })
      ).statusCode,
      403,
    );
    const other = await f.player();
    f.db
      .prepare("UPDATE access_memberships SET role='gm' WHERE user_id=?")
      .run(other.id);
    assert.equal((await f.post(root, f.file, other.cookie)).statusCode, 403);
    assert.equal(
      (await f.post(root + "?unexpected=1", f.file, f.cookie)).statusCode,
      400,
    );
    assert.equal(
      (await f.post(root, Buffer.from([0xff]), f.cookie)).statusCode,
      400,
    );
    const before = contents(f.db),
      status = await f.post(root, f.file, f.cookie),
      ticket = status.json();
    assert.equal(status.statusCode, 200);
    assert.equal(status.headers["cache-control"], "no-store");
    assert.equal(status.headers["set-cookie"], undefined);
    assert.equal(ticket.hostId, f.hostId);
    assert.equal(ticket.result, null);
    assert.equal(
      ticket.archiveSha256,
      createHash("sha256").update(f.file).digest("hex"),
    );
    assert.equal(contents(f.db), before);
    const changed = await f.post(root, f.file + "\n", f.cookie);
    assert.notEqual(changed.json().requestId, ticket.requestId);
    const inspecting = f
      .post("/api/campaign-imports/preflight", f.file, f.cookie)
      .then((r) => r);
    await until(() => c.inspector.busy);
    const during = await f.post(root, f.file, f.cookie);
    assert.equal(during.statusCode, 200);
    assert.equal(during.json().requestId, ticket.requestId);
    assert.equal(contents(f.db), before);
    c.finish();
    assert.equal((await inspecting).statusCode, 200);
    const importing = f
      .post(
        "/api/campaign-imports/import",
        importPayload(f.file, f.plan, ticket.requestId),
        f.cookie,
      )
      .then((r) => r);
    await until(() => c.inspector.busy);
    c.finish();
    const imported = await importing;
    assert.equal(imported.statusCode, 201);
    const committed = contents(f.db),
      saved = await f.post(root, f.file, f.cookie);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().result.campaign.id, imported.json().campaign.id);
    assert.equal(saved.json().result.replayed, true);
    assert.equal(contents(f.db), committed);
    const revoked = await f.post("/api/access/logout", "{}", f.cookie);
    assert.equal(revoked.statusCode, 200);
    assert.equal((await f.post(root, f.file, f.cookie)).statusCode, 401);
  } finally {
    await f.close();
  }
});
