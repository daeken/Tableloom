import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { fixture, populate } from "./campaign-transfer-fixture.js";
import { inspectCampaignTransfer } from "./campaign-preflight.js";
import { parseCampaignTransfer } from "./campaign-transfer-format.js";
import { installedModules } from "./modules.js";
import { documentSystems } from "./document-modules.js";
import { StoreError } from "./store.js";
import {
  parseOwnershipPlan,
  parseOwnershipReviewEnvelope,
  reviewCampaignOwnership,
  type OwnershipPlan,
} from "./campaign-ownership-plan.js";

function setup() {
  const f = fixture();
  populate(f);
  const file = f.snapshot(),
    inspect = (value = file) =>
      inspectCampaignTransfer(
        value,
        { systems: installedModules, contentPacks: f.catalog.metadata() },
        f.catalog,
        documentSystems,
        f.db,
      ),
    report = inspect();
  const plan: OwnershipPlan = {
    version: 1,
    archiveSha256: report.archiveSha256,
    acknowledge: "reviewed-private-content-and-access",
    acknowledgeMerges: false,
    assignments: report.ownership.subjects.map((subject) => ({
      sourceId: subject.sourceId,
      target:
        subject.sourceId === f.gm.member.id
          ? { kind: "existing", userId: f.gm.member.id, role: "gm" }
          : { kind: "new", name: "  New person  ", role: "player" },
    })),
  };
  const review = (value = plan, source = report) => {
    const before = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    try {
      return reviewCampaignOwnership(source, value, f.db, f.gm.member.id);
    } finally {
      assert.equal(
        f.db.prepare("SELECT total_changes() AS n").get()!.n,
        before,
      );
      assert.equal(f.db.isTransaction, false);
    }
  };
  return { ...f, file, inspect, report, plan, review };
}
const rejected = (action: () => unknown, status: number) =>
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof StoreError && error.statusCode === status,
  );

test("ownership review binds exact file bytes, normalizes a complete explicit plan and reads local names without allocating IDs or grants", () => {
  const f = setup();
  try {
    const original = JSON.stringify(f.plan),
      reviewed = f.review();
    assert.equal(reviewed.status, "ownership-review-only");
    assert.equal(reviewed.importReady, false);
    assert.deepEqual(reviewed.blockers, []);
    assert.equal(reviewed.ownershipReview.complete, true);
    assert.deepEqual(reviewed.ownershipReview.counts, {
      existingUsers: 1,
      newUsers: 1,
      unclaimed: 0,
      memberships: 2,
      membershipLimit: 1000,
    });
    assert.ok(!reviewed.pendingValidation.includes("ownership-plan"));
    for (const pending of [
      "resource-id-plan",
      "mapped-module-references",
      "mapped-history-graph",
      "mapped-storage-quotas",
      "atomic-import",
    ])
      assert.ok(reviewed.pendingValidation.includes(pending));
    const normalized = reviewed.ownershipReview.plan;
    assert.equal(
      normalized.assignments.find((a) => a.target.kind === "new")!.target.kind,
      "new",
    );
    assert.ok(JSON.stringify(normalized).includes("New person"));
    assert.ok(!JSON.stringify(normalized).includes("  New person  "));
    assert.equal(JSON.stringify(f.plan), original);
    assert.equal(
      f.review({ ...f.plan, assignments: [...f.plan.assignments].reverse() })
        .ownershipReview.planSha256,
      reviewed.ownershipReview.planSha256,
    );
    const envelope = parseOwnershipReviewEnvelope(
      JSON.stringify({ file: f.file, plan: normalized }),
    );
    assert.equal(envelope.file, f.file);
    assert.equal(
      createHash("sha256").update(envelope.file).digest("hex"),
      normalized.archiveSha256,
    );
    rejected(() => f.review({ ...f.plan, archiveSha256: "0".repeat(64) }), 409);
    rejected(() => f.review(f.plan, f.inspect(f.file + "\n")), 409);
    assert.equal(f.access.listMemberships(f.player.token).length, 1);
  } finally {
    f.db.close();
  }
});

test("every source identity including departed owners needs exactly one choice; names/source roles never create implicit access", () => {
  const f = setup();
  try {
    for (const assignments of [
      [],
      f.plan.assignments.slice(1),
      [...f.plan.assignments, f.plan.assignments[0]!],
      [
        { ...f.plan.assignments[0]!, sourceId: randomUUID() },
        ...f.plan.assignments.slice(1),
      ],
    ])
      rejected(() => f.review({ ...f.plan, assignments }), 400);
    const unclaimed: OwnershipPlan = {
      ...f.plan,
      assignments: f.plan.assignments.map((a) => ({
        sourceId: a.sourceId,
        target: { kind: "unclaimed" },
      })),
    };
    const report = f.review(unclaimed);
    assert.deepEqual(report.ownershipReview.counts, {
      existingUsers: 1,
      newUsers: 0,
      unclaimed: 2,
      memberships: 1,
      membershipLimit: 1000,
    });
    assert.deepEqual(report.ownershipReview.host, {
      userId: f.gm.member.id,
      role: "gm",
    });
    const named: OwnershipPlan = {
      ...f.plan,
      assignments: f.plan.assignments.map((a) => ({
        sourceId: a.sourceId,
        target: { kind: "new", name: f.gm.member.name, role: "player" },
      })),
    };
    assert.equal(f.review(named).ownershipReview.counts.newUsers, 2);
    const missingModule = {
      ...f.report,
      moduleReferenceValidation: {
        ...f.report.moduleReferenceValidation,
        complete: false,
      },
    };
    assert.equal(
      f.review(f.plan, missingModule).ownershipReview.complete,
      false,
    );
    assert.ok(
      f
        .review(f.plan, missingModule)
        .pendingValidation.includes("ownership-plan"),
    );
    // A retired embedded identity is still a source subject, with no inherited name or role.
    const file = parseCampaignTransfer(f.file),
      retired = randomUUID(),
      state = JSON.parse(file.records.campaign_records[0]!.state_json);
    state.notes[0].ownerId = retired;
    file.records.campaign_records[0]!.state_json = JSON.stringify(state);
    const source = f.inspect(JSON.stringify(file));
    assert.ok(
      source.ownership.subjects.some(
        (s) => s.sourceId === retired && s.name === null,
      ),
    );
    rejected(
      () =>
        f.review({ ...f.plan, archiveSha256: source.archiveSha256 }, source),
      400,
    );
  } finally {
    f.db.close();
  }
});

test("identity merges require acknowledgement and consistent destination roles; source GM status cannot downgrade the server host", () => {
  const f = setup();
  try {
    const merged: OwnershipPlan = {
      ...f.plan,
      assignments: f.plan.assignments.map((a) => ({
        sourceId: a.sourceId,
        target: { kind: "existing", userId: f.gm.member.id, role: "gm" },
      })),
    };
    const waiting = f.review(merged);
    assert.equal(waiting.ownershipReview.complete, false);
    assert.ok(
      waiting.blockers.includes("identity_merge_acknowledgement_required"),
    );
    assert.ok(waiting.pendingValidation.includes("ownership-plan"));
    assert.equal(waiting.ownershipReview.mergedTargets[0]!.sourceIds.length, 2);
    const reviewed = f.review({ ...merged, acknowledgeMerges: true });
    assert.equal(reviewed.ownershipReview.complete, true);
    assert.equal(reviewed.ownershipReview.counts.memberships, 1);
    assert.notEqual(
      reviewed.ownershipReview.planSha256,
      waiting.ownershipReview.planSha256,
    );
    const conflict = structuredClone(merged);
    conflict.assignments[0]!.target = {
      kind: "existing",
      userId: f.gm.member.id,
      role: "player",
    };
    rejected(() => f.review(conflict), 400);
    const other = structuredClone(merged);
    other.assignments[0]!.target = {
      kind: "existing",
      userId: f.player.member.id,
      role: "gm",
    };
    other.assignments[1]!.target = {
      kind: "existing",
      userId: f.player.member.id,
      role: "player",
    };
    rejected(() => f.review(other), 400);
  } finally {
    f.db.close();
  }
});

test("review checks current local identities and host ownership and rolls back failed snapshots", () => {
  const f = setup();
  try {
    const plan = structuredClone(f.plan);
    plan.assignments[0]!.target = {
      kind: "existing",
      userId: randomUUID(),
      role: "player",
    };
    rejected(() => f.review(plan), 409);
    rejected(
      () => reviewCampaignOwnership(f.report, f.plan, f.db, f.player.member.id),
      403,
    );
    assert.equal(f.db.isTransaction, false);
    f.db
      .prepare("UPDATE access_users SET name='Renamed locally' WHERE id=?")
      .run(f.gm.member.id);
    const reviewed = f.review();
    assert.ok(
      reviewed.ownershipReview.assignments.some(
        (a) =>
          a.target.kind === "existing" && a.target.name === "Renamed locally",
      ),
    );
    f.db.exec("BEGIN");
    assert.throws(
      () => reviewCampaignOwnership(f.report, f.plan, f.db, f.gm.member.id),
      /own destination read snapshot/,
    );
    assert.equal(f.db.isTransaction, true);
    f.db.exec("ROLLBACK");
  } finally {
    f.db.close();
  }
});

test("planned membership capacity includes the independent host GM and accepts the exact 1,000-person boundary", () => {
  const f = setup();
  try {
    const file = parseCampaignTransfer(f.file);
    while (file.members.length < 1000)
      file.members.push({
        id: randomUUID(),
        name: "Source person",
        role: "player",
      });
    const report = f.inspect(JSON.stringify(file)),
      plan: OwnershipPlan = {
        ...f.plan,
        archiveSha256: report.archiveSha256,
        assignments: report.ownership.subjects.map((s) => ({
          sourceId: s.sourceId,
          target: { kind: "new", name: "Reviewed person", role: "player" },
        })),
      };
    const full = f.review(plan, report);
    assert.equal(full.ownershipReview.complete, false);
    assert.equal(full.ownershipReview.counts.memberships, 1001);
    assert.ok(full.blockers.includes("import_member_capacity_reached"));
    plan.assignments[0]!.target = {
      kind: "existing",
      userId: f.gm.member.id,
      role: "gm",
    };
    const fits = f.review(plan, report);
    assert.equal(fits.ownershipReview.counts.memberships, 1000);
    assert.equal(fits.ownershipReview.complete, true);
  } finally {
    f.db.close();
  }
});

test("ownership request contracts reject unknown fields, missing acknowledgement, excessive plans and invalid source encoding", () => {
  const f = setup();
  try {
    for (const value of [
      { ...f.plan, version: 2 },
      { ...f.plan, execute: true },
      { ...f.plan, acknowledge: "yes" },
      { ...f.plan, assignments: Array(1001).fill(f.plan.assignments[0]) },
      {
        ...f.plan,
        assignments: [
          {
            sourceId: randomUUID(),
            target: { kind: "new", name: "", role: "gm" },
          },
        ],
      },
    ])
      assert.throws(() => parseOwnershipPlan(value));
    for (const body of [
      "{}",
      JSON.stringify({ file: "\ud800", plan: f.plan }),
      JSON.stringify({ file: f.file, plan: f.plan, execute: true }),
    ])
      rejected(() => parseOwnershipReviewEnvelope(body), 400);
  } finally {
    f.db.close();
  }
});
