import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {
  CampaignImportReviewClient,
  buildReviewPlan,
  reviewedChoiceCount,
} from "./campaign-import-review-client.js";
import type { ImportReviewState } from "./campaign-import-review-client.js";
import { ownershipPlanSchema } from "@tableloom/core/campaign-transfer";
import type {
  OwnershipPlan,
  TransferInspection,
  TransferImportResult,
} from "@tableloom/core/campaign-transfer";
const host = { id: randomUUID(), name: "Same name" },
  other = { id: randomUUID(), name: "Local friend" },
  sourceIds = [host.id, randomUUID()],
  campaign = {
    id: randomUUID(),
    activeSceneId: randomUUID(),
    version: 1,
    name: "Private campaign",
    description: "",
    system: { id: "kids-on-bikes", version: "0.1.0" },
    contentPacks: [],
  },
  fileText =
    "\n" +
    JSON.stringify(
      {
        format: "tableloom-campaign-export",
        version: 1,
        privacy: "all-campaign-content-including-private",
        identityPolicy: "source-identifiers-without-access-grants",
        assetEncoding: "base64",
        campaign,
        records: { opaque: "SECRET café 🗺" },
      },
      null,
      2,
    ) +
    "\n",
  digest = createHash("sha256").update(fileText).digest("hex"),
  inspection: TransferInspection = {
    status: "preflight-only",
    importReady: false,
    archiveSha256: digest,
    campaign: { id: campaign.id, name: campaign.name },
    resourceCounts: {
      campaign_records: 1,
      scene_records: 1,
      campaign_receipts: 0,
      command_bindings: 0,
      object_id_reservations: 0,
      module_documents: 0,
      content_overrides: 0,
      content_instances: 0,
      campaign_assets: 0,
      scene_backgrounds: 0,
      scene_background_history: 0,
      scene_background_history_refs: 0,
      scene_grids: 0,
      scene_history_entries: 0,
      roll_archive: 0,
      chat_messages: 0,
    },
    packages: {
      system: { ...campaign.system, status: "available" },
      contentPacks: [],
    },
    blockers: [],
    pendingValidation: [
      "ownership-plan",
      "resource-id-plan",
      "mapped-storage-quotas",
      "mapped-module-references",
      "mapped-history-graph",
      "atomic-import",
    ],
    ownership: {
      policy: "explicit-mapping-required",
      subjects: sourceIds.map((sourceId) => ({
        sourceId,
        name: "Same name",
        sourceRole: "gm",
      })),
    },
    moduleReferenceValidation: { records: 0, references: 0, complete: true },
  };
function reviewed(plan: OwnershipPlan) {
  const selected = new Set<string>([host.id]),
    groups = new Map<string, string[]>();
  let newUsers = 0,
    unclaimed = 0;
  for (const a of plan.assignments) {
    if (a.target.kind === "existing") {
      selected.add(a.target.userId);
      const g = groups.get(a.target.userId) ?? [];
      g.push(a.sourceId);
      groups.set(a.target.userId, g);
    } else if (a.target.kind === "new") newUsers++;
    else unclaimed++;
  }
  return {
    ...inspection,
    status: "ownership-review-only",
    ownershipReview: {
      complete: true,
      plan,
      assignments: plan.assignments.map(({ sourceId, target }) => ({
        sourceId,
        target:
          target.kind === "existing"
            ? {
                ...target,
                name: target.userId === host.id ? host.name : other.name,
              }
            : target,
      })),
      planSha256: createHash("sha256")
        .update(JSON.stringify(plan))
        .digest("hex"),
      mergedTargets: [...groups]
        .filter(([, s]) => s.length > 1)
        .map(([userId, sourceIds]) => ({ userId, sourceIds })),
      host: { userId: host.id, role: "gm" },
      counts: {
        existingUsers: selected.size,
        newUsers,
        unclaimed,
        memberships: selected.size + newUsers,
        membershipLimit: 1000,
      },
    },
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const stableRequestId = randomUUID();
function backendState() {
  return {
    result: null as TransferImportResult | null,
    creations: 0,
    bodies: [] as string[],
  };
}
function commitFake(backend: ReturnType<typeof backendState>, body: string) {
  backend.bodies.push(body);
  const input = JSON.parse(body) as {
    requestId: string;
    expectedPlanSha256: string;
    plan: OwnershipPlan;
  };
  if (backend.result) {
    if (backend.result.ownershipPlanSha256 !== input.expectedPlanSha256)
      return json({ error: "different confirmed plan" }, 409);
    return json({ ...backend.result, replayed: true });
  }
  backend.creations++;
  const counts = reviewed(input.plan).ownershipReview.counts;
  backend.result = {
    status: "imported",
    requestId: input.requestId,
    archiveSha256: digest,
    ownershipPlanSha256: input.expectedPlanSha256,
    resourcePolicy: "fresh-campaign-and-resource-identifiers",
    importedAt: "2026-11-05T00:00:00.000Z",
    campaign: {
      ...campaign,
      id: randomUUID(),
      activeSceneId: randomUUID(),
      role: "gm",
    },
    summary: {
      createdPeople: counts.newUsers,
      attributionRecords: counts.unclaimed,
      memberships: counts.memberships,
      rows: 1,
    },
    replayed: false,
  };
  return json(backend.result, 201);
}
async function fixture(backend = backendState(), timeoutMs = 30000) {
  let view: ImportReviewState,
    intercept:
      ((path: string, init: RequestInit) => Promise<Response> | null) | null =
      null;
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new CampaignImportReviewClient(
    async (path, init) => {
      calls.push({ path, init });
      const override = intercept?.(path, init);
      if (override) return override;
      if (!init.method)
        return json({ host, people: [host, other], nextCursor: null });
      if (path.endsWith("/status"))
        return json({
          status: "import-request-status",
          hostId: host.id,
          requestId: stableRequestId,
          archiveSha256: digest,
          result: backend.result ? { ...backend.result, replayed: true } : null,
        });
      if (path.endsWith("/import"))
        return commitFake(backend, String(init.body));
      if (path.endsWith("/preflight")) return json(inspection);
      const raw = JSON.parse(String(init.body)) as { plan: OwnershipPlan };
      const plan = ownershipPlanSchema.parse(raw.plan);
      plan.assignments.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      const review = reviewed(plan);
      return json(
        path.endsWith("/ownership-review")
          ? review
          : {
              ...review,
              status: "candidate-preflight-only",
              pendingValidation: ["atomic-import"],
              resourcePlan: {
                policy: "fresh-campaign-and-resource-identifiers",
                complete: true,
                targetCampaignId: randomUUID(),
                candidateSha256: "a".repeat(64),
              },
              candidateValidation: { complete: true, failedStage: null },
            },
      );
    },
    (state) => {
      view = state;
    },
    timeoutMs,
  );
  client.start();
  await client.loadPeople();
  return {
    client,
    calls,
    backend,
    async ready() {
      await client.selectFile(new File([fileText], "private.json"));
      client.acknowledgeUpload(true);
      assert.equal(await client.inspect(), true);
      for (const id of sourceIds) client.choose(id, { kind: "unclaimed" });
      client.acknowledgeReview(true);
      assert.equal(await client.reviewOwnership(), true);
      assert.equal(await client.prepare(), true);
    },
    view: () => view!,
    override: (fn: typeof intercept) => {
      intercept = fn;
    },
    async inspect() {
      await client.selectFile(new File([fileText], "private.json"));
      client.acknowledgeUpload(true);
      assert.equal(await client.inspect(), true);
    },
    choices() {
      for (const id of sourceIds) client.choose(id, { kind: "unclaimed" });
      client.acknowledgeReview(true);
    },
  };
}

test("file inspection and ownership/candidate review require consent and explicit choices; source bytes are unchanged and no writes are requested", async () => {
  const f = await fixture();
  try {
    await f.client.selectFile(new File([fileText], "private.json"));
    assert.equal(await f.client.inspect(), false);
    assert.equal(f.calls.length, 1);
    f.client.acknowledgeUpload(true);
    assert.equal(await f.client.inspect(), true);
    assert.equal(f.calls[1]!.init.body, fileText);
    assert.equal(f.calls[1]!.init.cache, "no-store");
    assert.equal(f.calls[1]!.init.credentials, "same-origin");
    assert.equal(f.calls[1]!.init.redirect, "error");
    assert.deepEqual(
      f.view().choices,
      {},
      "Matching source IDs/names do not select existing people",
    );
    assert.equal(await f.client.reviewOwnership(), false);
    f.choices();
    assert.equal(reviewedChoiceCount(f.view()), 2);
    assert.ok(buildReviewPlan(f.view()));
    assert.equal(await f.client.reviewOwnership(), true);
    assert.equal(await f.client.prepare(), true);
    assert.equal(f.view().candidate!.resourcePlan.complete, true);
    assert.ok(f.calls.every((c) => !c.path.endsWith("/import")));
    const body = JSON.parse(String(f.calls.at(-1)!.init.body));
    assert.equal(body.file, fileText);
    assert.equal(
      body.resourcePolicy,
      "fresh-campaign-and-resource-identifiers",
    );
    assert.equal(body.plan.assignments.length, 2);
    assert.ok(
      body.plan.assignments.every(
        (a: { target: { kind: string } }) => a.target.kind === "unclaimed",
      ),
    );
  } finally {
    f.client.stop();
  }
});

test("new/existing choices validate names and local IDs, keep the host a GM, and require explicit merge and renewed access acknowledgement", async () => {
  const f = await fixture();
  try {
    await f.inspect();
    f.client.choose(sourceIds[0]!, { kind: "new", name: "", role: "player" });
    f.client.choose(sourceIds[1]!, { kind: "unclaimed" });
    f.client.acknowledgeReview(true);
    assert.equal(buildReviewPlan(f.view()), null);
    f.client.choose(sourceIds[0]!, {
      kind: "new",
      name: "  Reviewed new person  ",
      role: "player",
    });
    f.client.acknowledgeReview(true);
    assert.equal(
      buildReviewPlan(f.view())!.assignments.find(
        (a) => a.sourceId === sourceIds[0],
      )!.target.kind,
      "new",
    );
    const created = buildReviewPlan(f.view())!.assignments.find(
      (a) => a.target.kind === "new",
    )!.target;
    assert.ok(
      created.kind === "new" &&
        created.name === "Reviewed new person" &&
        created.role === "player",
    );
    for (const id of sourceIds)
      f.client.choose(id, {
        kind: "existing",
        userId: host.id,
        role: "player",
        label: "untrusted label",
      });
    assert.ok(
      Object.values(f.view().choices).every(
        (c) =>
          c.kind === "existing" && c.role === "gm" && c.label === host.name,
      ),
    );
    f.client.acknowledgeReview(true);
    assert.equal(buildReviewPlan(f.view()), null);
    f.client.acknowledgeMerges(true);
    assert.equal(f.view().reviewConsent, false);
    f.client.acknowledgeReview(true);
    assert.equal(await f.client.reviewOwnership(), true);
    assert.equal(await f.client.prepare(), true);
    f.client.choose(sourceIds[0]!, {
      kind: "existing",
      userId: other.id,
      role: "gm",
      label: "",
    });
    const replacement = f.view().choices[sourceIds[0]!]!;
    assert.ok(
      replacement.kind === "existing" && replacement.role === "player",
      "Replacing a forced host GM must not grant the next person GM access",
    );
    f.client.choose(sourceIds[1]!, { kind: "unclaimed" });
    assert.equal(f.view().review, null);
    assert.equal(f.view().candidate, null);
    assert.equal(f.view().reviewConsent, false);
    assert.equal(f.view().mergeConsent, false);
  } finally {
    f.client.stop();
  }
});

test("search/paging changes eligible results without losing a selected local person or allowing guessed IDs", async () => {
  const f = await fixture();
  try {
    await f.inspect();
    f.client.choose(sourceIds[0]!, {
      kind: "existing",
      userId: other.id,
      role: "player",
      label: "",
    });
    const chosen = f.view().choices[sourceIds[0]!]!;
    f.override((_path, init) =>
      !init.method
        ? Promise.resolve(json({ host, people: [], nextCursor: null }))
        : null,
    );
    await f.client.loadPeople("literal% café");
    assert.equal(
      new URL(f.calls.at(-1)!.path, "http://localhost").searchParams.get("q"),
      "literal% café",
    );
    assert.deepEqual(f.view().choices[sourceIds[0]!], chosen);
    f.client.choose(sourceIds[0]!, {
      kind: "existing",
      userId: other.id,
      role: "gm",
      label: "",
    });
    assert.equal(f.view().choices[sourceIds[0]!]!.kind, "existing");
    f.client.choose(sourceIds[1]!, {
      kind: "existing",
      userId: randomUUID(),
      role: "gm",
      label: "forged",
    });
    assert.equal(f.view().choices[sourceIds[1]!], undefined);
    f.override((_path, init) =>
      !init.method
        ? Promise.resolve(
            json({ host, people: [other, other], nextCursor: null }),
          )
        : null,
    );
    assert.equal(await f.client.loadPeople(), false);
    assert.ok(f.view().error);
    f.override((_path, init) =>
      !init.method
        ? Promise.resolve(
            json({
              host: { ...host, id: randomUUID() },
              people: [],
              nextCursor: null,
            }),
          )
        : null,
    );
    assert.equal(await f.client.loadPeople(), false);
    assert.equal(f.view().host, null);
    assert.equal(f.view().file, null);
    assert.deepEqual(f.view().choices, {});
  } finally {
    f.client.stop();
  }
});

test("invalid, oversized, unsupported and non-UTF-8 local files never leave the browser; replacing a file clears all previous approvals", async () => {
  const f = await fixture();
  try {
    await f.inspect();
    f.choices();
    await f.client.reviewOwnership();
    await f.client.prepare();
    const before = f.calls.length;
    for (const file of [
      new File([], "empty.json"),
      new File([new Uint8Array(32 * 1024 * 1024 + 1)], "large.json"),
      new File([new Uint8Array([0xff])], "invalid.json"),
      new File(
        [fileText.replace('"version": 1', '"version": 99')],
        "unsupported.json",
      ),
      new File(["\ufeff" + fileText], "bom.json"),
    ]) {
      assert.equal(await f.client.selectFile(file), false);
      assert.equal(f.view().file, null);
      assert.equal(f.view().review, null);
      assert.equal(f.view().candidate, null);
      assert.equal(f.view().uploadConsent, false);
      assert.deepEqual(f.view().choices, {});
    }
    assert.equal(f.calls.length, before);
    assert.equal(
      await f.client.selectFile(new File([fileText], "again.json")),
      true,
    );
    assert.equal(await f.client.inspect(), false);
  } finally {
    f.client.stop();
  }
});

test("wrong-file, changed-plan and incomplete image/candidate summaries cannot approve a review", async () => {
  const f = await fixture();
  try {
    await f.client.selectFile(new File([fileText], "private.json"));
    f.client.acknowledgeUpload(true);
    f.override((path) =>
      path.endsWith("/preflight")
        ? Promise.resolve(
            json({
              ...inspection,
              campaign: { ...inspection.campaign, id: randomUUID() },
            }),
          )
        : null,
    );
    assert.equal(await f.client.inspect(), false);
    assert.equal(f.view().inspection, null);
    f.override((path) =>
      path.endsWith("/preflight")
        ? Promise.resolve(
            json({ ...inspection, pendingValidation: ["image-decoding"] }),
          )
        : null,
    );
    assert.equal(await f.client.inspect(), false);
    f.override(null);
    assert.equal(await f.client.inspect(), true);
    f.choices();
    f.override((path, init) =>
      path.endsWith("/ownership-review")
        ? Promise.resolve(
            json(
              reviewed({
                ...JSON.parse(String(init.body)).plan,
                acknowledgeMerges: true,
              }),
            ),
          )
        : null,
    );
    assert.equal(await f.client.reviewOwnership(), false);
    assert.equal(f.view().review, null);
    f.override(null);
    f.client.acknowledgeReview(true);
    assert.equal(await f.client.reviewOwnership(), true);
    f.override((path, init) =>
      path.endsWith("/prepare")
        ? Promise.resolve(
            json({
              ...reviewed(JSON.parse(String(init.body)).plan),
              status: "candidate-preflight-only",
              pendingValidation: [],
              resourcePlan: {
                policy: "fresh-campaign-and-resource-identifiers",
                complete: true,
                targetCampaignId: null,
                candidateSha256: null,
              },
              candidateValidation: { complete: true, failedStage: null },
            }),
          )
        : null,
    );
    assert.equal(await f.client.prepare(), false);
    assert.equal(f.view().candidate, null);
    assert.ok(!f.view().error.includes("SECRET"));
  } finally {
    f.client.stop();
  }
});

test("late file checks after close or file replacement cannot restore old identities, private bytes or approvals", async () => {
  const f = await fixture();
  let release: ((response: Response) => void) | undefined, started: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    await f.client.selectFile(new File([fileText], "old.json"));
    f.client.acknowledgeUpload(true);
    f.override((path) =>
      path.endsWith("/preflight")
        ? new Promise((resolve) => {
            release = resolve;
            started();
          })
        : null,
    );
    const pending = f.client.inspect();
    await began;
    const signal = f.calls.at(-1)!.init.signal!;
    assert.equal(await f.client.inspect(), false);
    f.client.stop();
    f.client.start();
    f.override(null);
    await f.client.loadPeople();
    await f.client.selectFile(new File([fileText], "new.json"));
    release!(json(inspection));
    assert.equal(await pending, false);
    assert.equal(signal.aborted, true);
    assert.equal(f.view().file!.name, "new.json");
    assert.equal(f.view().inspection, null);
    assert.equal(f.view().uploadConsent, false);
    assert.equal(await f.client.prepare(), false);
  } finally {
    f.client.stop();
  }
});

test("revoked host access releases private file state; conflict/busy responses retain choices but require renewed review", async () => {
  for (const status of [401, 403, 409, 503]) {
    const f = await fixture();
    try {
      await f.inspect();
      f.choices();
      await f.client.reviewOwnership();
      f.override((path) =>
        path.endsWith("/prepare")
          ? Promise.resolve(json({ error: "SECRET backend details" }, status))
          : null,
      );
      assert.equal(await f.client.prepare(), false);
      assert.equal(f.view().candidate, null);
      assert.equal(f.view().review, null);
      assert.equal(f.view().reviewConsent, false);
      assert.ok(!f.view().error.includes("SECRET"));
      if (status === 401 || status === 403) {
        assert.equal(f.view().host, null);
        assert.equal(f.view().file, null);
        assert.deepEqual(f.view().choices, {});
      } else {
        assert.ok(f.view().file);
        assert.equal(Object.keys(f.view().choices).length, 2);
      }
    } finally {
      f.client.stop();
    }
  }
});

test("bounded reports reject excessive response bytes before rendering private data", async () => {
  const f = await fixture();
  try {
    f.override((_path, init) =>
      !init.method
        ? Promise.resolve(
            new Response("SECRET", {
              headers: {
                "content-type": "application/json",
                "content-length": String(2 * 1024 * 1024 + 1),
              },
            }),
          )
        : null,
    );
    assert.equal(await f.client.loadPeople(), false);
    assert.ok(!f.view().error.includes("SECRET"));
  } finally {
    f.client.stop();
  }
  let view: ImportReviewState;
  const timeout = new CampaignImportReviewClient(
    (_path, init) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("SECRET")),
          { once: true },
        );
      }),
    (state) => {
      view = state;
    },
    20,
  );
  timeout.start();
  assert.equal(await timeout.loadPeople(), false);
  assert.match(view!.error, /timed out/);
  assert.equal(view!.busy, null);
  timeout.stop();
});

test("creation needs a final confirmation, keeps the reviewed source/plan and never creates a second copy after success", async () => {
  const f = await fixture();
  try {
    await f.ready();
    assert.equal(await f.client.create(), false);
    assert.equal(f.backend.creations, 0);
    f.client.acknowledgeCreation(true);
    assert.equal(await f.client.create(), true);
    assert.equal(f.backend.creations, 1);
    assert.equal(f.view().execution, "complete");
    assert.equal(f.view().result!.replayed, false);
    const input = JSON.parse(f.backend.bodies[0]!);
    assert.equal(input.file, fileText);
    assert.equal(input.requestId, stableRequestId);
    assert.equal(input.confirm, "create-new-campaign");
    assert.equal(
      input.expectedPlanSha256,
      f.view().review!.ownershipReview.planSha256,
    );
    assert.notEqual(f.view().result!.campaign.id, campaign.id);
    assert.equal(await f.client.create(), false);
    assert.equal(await f.client.retry(), false);
    assert.equal(
      await f.client.selectFile(new File([fileText], "again.json")),
      false,
    );
    assert.equal(f.backend.creations, 1);
  } finally {
    f.client.stop();
  }
});

test("a lost response after commit recovers the saved result without another writer call", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.override((path, init) => {
      if (!path.endsWith("/import")) return null;
      commitFake(f.backend, String(init.body));
      return Promise.reject(new Error("SECRET connection lost"));
    });
    f.client.acknowledgeCreation(true);
    assert.equal(await f.client.create(), false);
    assert.equal(f.view().execution, "uncertain");
    assert.match(f.view().error, /may have finished/);
    assert.ok(!f.view().error.includes("SECRET"));
    const choices = structuredClone(f.view().choices);
    f.client.choose(sourceIds[0]!, {
      kind: "new",
      name: "Changed",
      role: "gm",
    });
    assert.deepEqual(f.view().choices, choices);
    assert.equal(
      await f.client.selectFile(new File([fileText], "new.json")),
      false,
    );
    f.override(null);
    assert.equal(await f.client.retry(), true);
    assert.equal(f.view().result!.replayed, true);
    assert.equal(f.backend.bodies.length, 1);
    assert.equal(f.backend.creations, 1);
  } finally {
    f.client.stop();
  }
});

test("retry after an uncommitted failure sends the exact same serialized request and status-only checks cannot start a write", async () => {
  const f = await fixture();
  let first = "";
  try {
    await f.ready();
    f.override((path, init) => {
      if (!path.endsWith("/import")) return null;
      first = String(init.body);
      return Promise.resolve(json({ error: "SECRET unavailable" }, 503));
    });
    f.client.acknowledgeCreation(true);
    assert.equal(await f.client.create(), false);
    assert.equal(f.backend.creations, 0);
    assert.equal(await f.client.checkSavedResult(), false);
    assert.match(f.view().error, /earlier request may still finish/);
    assert.equal(f.backend.creations, 0);
    f.override(null);
    assert.equal(await f.client.retry(), true);
    assert.equal(f.backend.bodies[0], first);
    assert.equal(f.backend.creations, 1);
  } finally {
    f.client.stop();
  }
});

test("reopening with the same file recovers before preflight, and an existing different review is disclosed instead of creating another copy", async () => {
  const backend = backendState(),
    f = await fixture(backend);
  await f.ready();
  f.client.acknowledgeCreation(true);
  assert.equal(await f.client.create(), true);
  const target = f.view().result!.campaign.id;
  f.client.stop();
  const reopened = await fixture(backend);
  try {
    reopened.override((path) =>
      path.endsWith("/preflight")
        ? Promise.reject(
            new Error(
              "A full campaign registry or changed module must not prevent receipt recovery",
            ),
          )
        : null,
    );
    await reopened.client.selectFile(new File([fileText], "same-file.json"));
    reopened.client.acknowledgeUpload(true);
    assert.equal(await reopened.client.inspect(), true);
    assert.equal(reopened.view().result!.campaign.id, target);
    assert.equal(reopened.view().execution, "complete");
    assert.equal(reopened.view().inspection, null);
    assert.equal(backend.creations, 1);
  } finally {
    reopened.client.stop();
  }
  const race = await fixture();
  try {
    await race.ready();
    const alternate = buildReviewPlan(race.view())!;
    alternate.assignments[0]!.target = {
      kind: "existing",
      userId: host.id,
      role: "gm",
    };
    const planSha256 = createHash("sha256")
      .update(JSON.stringify(alternate))
      .digest("hex");
    commitFake(
      race.backend,
      JSON.stringify({
        requestId: stableRequestId,
        expectedPlanSha256: planSha256,
        plan: alternate,
      }),
    );
    race.client.acknowledgeCreation(true);
    assert.equal(await race.client.create(), true);
    assert.equal(race.view().differentPlan, true);
    assert.equal(race.backend.creations, 1);
    assert.equal(race.backend.bodies.length, 1);
  } finally {
    race.client.stop();
  }
});

test("closing during the pre-write result check drops late completion and cannot issue an import", async () => {
  const f = await fixture();
  let release: ((r: Response) => void) | undefined, started: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  try {
    await f.ready();
    f.override((path) =>
      path.endsWith("/status")
        ? new Promise((resolve) => {
            release = resolve;
            started();
          })
        : null,
    );
    f.client.acknowledgeCreation(true);
    const pending = f.client.create();
    await began;
    const signal = f.calls.at(-1)!.init.signal!;
    f.client.stop();
    assert.equal(signal.aborted, true);
    release!(
      json({
        status: "import-request-status",
        hostId: host.id,
        requestId: stableRequestId,
        archiveSha256: digest,
        result: null,
      }),
    );
    assert.equal(await pending, false);
    assert.equal(f.backend.creations, 0);
    assert.ok(f.calls.every((c) => !c.path.endsWith("/import")));
    assert.equal(f.view().result, null);
  } finally {
    f.client.stop();
  }
});

test("malformed committed responses remain uncertain, while permission loss releases private state and requires recovery after sign-in", async () => {
  const f = await fixture();
  try {
    await f.ready();
    f.override((path, init) => {
      if (!path.endsWith("/import")) return null;
      commitFake(f.backend, String(init.body));
      return Promise.resolve(
        json({ ...f.backend.result, ownershipPlanSha256: "f".repeat(64) }),
      );
    });
    f.client.acknowledgeCreation(true);
    assert.equal(await f.client.create(), false);
    assert.equal(f.view().execution, "uncertain");
    assert.equal(f.view().result, null);
    f.override(null);
    assert.equal(await f.client.checkSavedResult(), true);
    assert.equal(f.backend.creations, 1);
  } finally {
    f.client.stop();
  }
  const revoked = await fixture();
  try {
    await revoked.ready();
    revoked.override((path) =>
      path.endsWith("/import")
        ? Promise.resolve(json({ error: "SECRET denied" }, 403))
        : null,
    );
    revoked.client.acknowledgeCreation(true);
    assert.equal(await revoked.client.create(), false);
    assert.equal(revoked.view().host, null);
    assert.equal(revoked.view().file, null);
    assert.deepEqual(revoked.view().choices, {});
    assert.match(revoked.view().error, /may have finished/);
    assert.equal(await revoked.client.retry(), false);
  } finally {
    revoked.client.stop();
  }
});

test("two tabs confirming the same file use one request ID and receive one campaign", async () => {
  const backend = backendState(),
    a = await fixture(backend),
    b = await fixture(backend);
  try {
    await a.ready();
    await b.ready();
    a.client.acknowledgeCreation(true);
    b.client.acknowledgeCreation(true);
    assert.deepEqual(
      await Promise.all([a.client.create(), b.client.create()]),
      [true, true],
    );
    assert.equal(backend.creations, 1);
    assert.equal(a.view().result!.campaign.id, b.view().result!.campaign.id);
    assert.ok(
      backend.bodies.every(
        (body) => JSON.parse(body).requestId === stableRequestId,
      ),
    );
  } finally {
    a.client.stop();
    b.client.stop();
  }
});

test("an import timeout keeps a frozen request that can be retried without changing its ID or plan", async () => {
  const f = await fixture(backendState(), 20);
  let first = "";
  try {
    await f.ready();
    f.override((path, init) => {
      if (!path.endsWith("/import")) return null;
      first = String(init.body);
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => reject(new Error("SECRET timeout")),
          { once: true },
        );
      });
    });
    f.client.acknowledgeCreation(true);
    assert.equal(await f.client.create(), false);
    assert.equal(f.view().execution, "uncertain");
    assert.equal(f.view().busy, null);
    f.override(null);
    assert.equal(await f.client.retry(), true);
    assert.equal(f.backend.bodies[0], first);
    assert.equal(f.backend.creations, 1);
  } finally {
    f.client.stop();
  }
});
