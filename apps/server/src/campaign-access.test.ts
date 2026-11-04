import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AccessError, AccessStore } from "./access.js";
import { TableStore } from "./store.js";
import { transaction } from "./database.js";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";

const KEY = "tableloom-scoped-access-test-not-a-real-host-key";
const code = (expected: AccessError["code"]) => (error: unknown) =>
  error instanceof AccessError && error.code === expected;
function contexts(store: AccessStore) {
  const first = store.setupHost(KEY, "GM");
  const secondId = randomUUID();
  store.registerCampaign(first.token, secondId);
  const second = store.selectCampaign(first.token, secondId);
  assert.equal(store.authenticate(first.token), null);
  const recovered = store.recoverHost(KEY);
  return { first: recovered, second, secondId };
}

test("campaign selection uses existing memberships and rotates the session without changing its identity or other sessions", () => {
  const store = new AccessStore(":memory:", KEY);
  try {
    const { first, second, secondId } = contexts(store);
    const alice = store.redeemInvitation(
      store.createInvitation(first.token).token,
      "Alice",
    );
    assert.throws(
      () => store.selectCampaign(alice.token, secondId),
      code("campaign_unavailable"),
    );
    assert.throws(
      () => store.selectCampaign(alice.token, randomUUID()),
      code("campaign_unavailable"),
    );
    const invitation = store.createInvitation(second.token);
    const joined = store.redeemInvitation(
      invitation.token,
      "Cannot rename Alice",
      { sessionToken: alice.token },
    );
    assert.equal(joined.member.id, alice.member.id);
    assert.equal(joined.member.name, "Alice");
    assert.equal(joined.member.role, "player");
    assert.equal(joined.member.tableId, secondId);
    assert.deepEqual(store.authenticate(alice.token), alice.member);
    assert.deepEqual(
      store
        .listMemberships(alice.token)
        .map((member) => member.tableId)
        .sort(),
      [DEFAULT_CAMPAIGN_ID, secondId].sort(),
    );
    const switched = store.selectCampaign(alice.token, secondId);
    assert.deepEqual(switched.member, joined.member);
    assert.equal(store.authenticate(alice.token), null);
    assert.deepEqual(store.authenticate(joined.token), joined.member);
    assert.deepEqual(store.authenticate(switched.token), joined.member);
    assert.throws(
      () => store.registerCampaign(switched.token, randomUUID()),
      code("host_required"),
    );
    assert.throws(
      () => store.createInvitation(switched.token),
      code("host_required"),
    );
    assert.throws(
      () => store.listMembers(switched.token),
      code("host_required"),
    );
    assert.throws(
      () => store.registerCampaign(first.token, secondId),
      code("campaign_exists"),
    );
  } finally {
    store.close();
  }
});

test("membership removal, recovery, code management, and invitation limits stay inside their campaign", () => {
  const store = new AccessStore(":memory:", KEY);
  try {
    const { first, second, secondId } = contexts(store);
    const alice = store.redeemInvitation(
      store.createInvitation(first.token).token,
      "Alice",
    );
    const aliceSecond = store.redeemInvitation(
      store.createInvitation(second.token).token,
      "Ignored",
      { sessionToken: alice.token },
    );
    const outsider = store.redeemInvitation(
      store.createInvitation(second.token).token,
      "Second campaign only",
    );
    assert.equal(
      store
        .listMembers(first.token)
        .some((member) => member.id === outsider.member.id),
      false,
    );
    assert.equal(store.getMember(outsider.member.id), null);
    assert.equal(
      store.getMember(outsider.member.id, secondId)?.id,
      outsider.member.id,
    );
    assert.throws(
      () => store.createRecoveryInvitation(first.token, outsider.member.id),
      code("invalid_member"),
    );
    const secondCode = store.createRecoveryInvitation(
      second.token,
      alice.member.id,
    );
    store.revokeInvitation(first.token, secondCode.id); // Wrong scope cannot revoke it.
    assert.equal(store.listInvitations(second.token)[0]?.id, secondCode.id);
    const firstCode = store.createRecoveryInvitation(
      first.token,
      alice.member.id,
    );
    const recovered = store.redeemInvitation(firstCode.token, "Ignored");
    assert.equal(store.authenticate(alice.token), null);
    assert.deepEqual(store.authenticate(aliceSecond.token), aliceSecond.member);
    assert.equal(store.listInvitations(second.token)[0]?.id, secondCode.id);
    store.removeMember(first.token, alice.member.id);
    assert.equal(store.authenticate(recovered.token), null);
    assert.deepEqual(store.authenticate(aliceSecond.token), aliceSecond.member);
    assert.equal(
      store.redeemInvitation(secondCode.token, "Ignored").member.tableId,
      secondId,
    );
    assert.throws(
      () => store.removeMember(first.token, first.member.id),
      code("host_removal"),
    );
    for (let i = 0; i < 100; i++) store.createInvitation(first.token);
    assert.throws(
      () => store.createInvitation(first.token),
      code("invitation_limit"),
    );
    assert.equal(store.createInvitation(second.token).tableId, secondId);
  } finally {
    store.close();
  }
});

test("failed session switches or existing-identity joins preserve credentials and unused codes", () => {
  const db = new DatabaseSync(":memory:"),
    store = new AccessStore(db, KEY);
  try {
    const { first, second, secondId } = contexts(store);
    const alice = store.redeemInvitation(
      store.createInvitation(first.token).token,
      "Alice",
    );
    const invitation = store.createInvitation(second.token);
    db.exec(
      "CREATE TRIGGER reject_scoped_session BEFORE INSERT ON access_sessions BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    assert.throws(() => store.selectCampaign(first.token, secondId));
    assert.deepEqual(store.authenticate(first.token), first.member);
    assert.throws(() =>
      store.redeemInvitation(invitation.token, "Ignored", {
        sessionToken: alice.token,
      }),
    );
    assert.equal(store.getMember(alice.member.id, secondId), null);
    assert.deepEqual(store.authenticate(alice.token), alice.member);
    assert.equal(store.listInvitations(second.token)[0]?.id, invitation.id);
    db.exec("DROP TRIGGER reject_scoped_session");
    assert.equal(
      store.redeemInvitation(invitation.token, "Ignored", {
        sessionToken: alice.token,
      }).member.id,
      alice.member.id,
    );
    const redundant = store.createInvitation(second.token);
    assert.throws(
      () =>
        store.redeemInvitation(redundant.token, "Ignored", {
          sessionToken: alice.token,
        }),
      code("member_exists"),
    );
    assert.equal(store.listInvitations(second.token)[0]?.id, redundant.id);
    const other = store.redeemInvitation(redundant.token, "Someone else");
    assert.notEqual(other.member.id, alice.member.id);
    const restricted = store.createInvitation(second.token);
    assert.throws(
      () =>
        store.redeemInvitation(restricted.token, "Wrong destination", {
          campaignId: DEFAULT_CAMPAIGN_ID,
        }),
      code("invalid_invitation"),
    );
    assert.equal(store.listInvitations(second.token)[0]?.id, restricted.id);
  } finally {
    store.close();
    db.close();
  }
});

test("shared campaign/access transactions roll back all records and preserve outer work around nested failures", () => {
  const db = new DatabaseSync(":memory:"),
    campaigns = new TableStore(db),
    access = new AccessStore(db, KEY);
  try {
    const host = access.setupHost(KEY, "GM");
    const settings = {
      name: "New campaign",
      description: "",
      system: { id: "kids-on-bikes", version: "0.1.0" },
      contentPacks: [],
    };
    db.exec(
      "CREATE TRIGGER reject_new_membership BEFORE INSERT ON access_memberships WHEN NEW.table_id != '00000000-0000-4000-8000-000000000001' BEGIN SELECT RAISE(ABORT, 'test failure'); END;",
    );
    assert.throws(() =>
      transaction(db, () => {
        const campaign = campaigns.createCampaign(settings);
        access.registerCampaign(host.token, campaign.id);
      }),
    );
    assert.equal(campaigns.listCampaigns().length, 1);
    assert.equal(access.listMemberships(host.token).length, 1);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM scene_records").get()?.count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM access_campaigns").get()?.count,
      1,
    );
    db.exec("DROP TRIGGER reject_new_membership");
    const created = transaction(db, () => {
      const campaign = campaigns.createCampaign(settings);
      assert.throws(
        () => access.registerCampaign(host.token, DEFAULT_CAMPAIGN_ID),
        code("campaign_exists"),
      );
      access.registerCampaign(host.token, campaign.id);
      return campaign;
    });
    assert.equal(campaigns.listCampaigns().length, 2);
    assert.equal(access.resolveMembership(host.token, created.id).role, "gm");
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    access.close();
    campaigns.close(); // A borrowed connection belongs to the caller.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM campaign_records").get()?.count,
      2,
    );
  } finally {
    db.close();
  }
});
