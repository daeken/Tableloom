import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AccessError, AccessStore } from "./access.js";

// Synthetic test credential, never used by a running Tableloom server.
const KEY = "tableloom-test-host-key-never-use-in-production";
const DAY = 86400000;
function code(expected: AccessError["code"]) {
  return (error: unknown) =>
    error instanceof AccessError && error.code === expected;
}

test("host setup requires the machine owner's key, validates names, and can happen once", () => {
  const store = new AccessStore(":memory:", KEY);
  try {
    assert.equal(store.setupRequired, true);
    assert.throws(() => store.setupHost("wrong", "Host"), code("invalid_key"));
    assert.throws(() => store.setupHost(KEY, " "));
    assert.equal(store.setupRequired, true);
    const session = store.setupHost(KEY, "  Host  ");
    assert.equal(session.member.name, "Host");
    assert.equal(session.member.role, "gm");
    assert.equal(session.member.tableId, "main");
    assert.equal(store.setupRequired, false);
    assert.deepEqual(store.authenticate(session.token), session.member);
    assert.throws(
      () => store.setupHost(KEY, "Another host"),
      code("setup_complete"),
    );
    assert.equal(store.authenticate("arbitrary-name"), null);
    assert.equal(store.authenticate("a".repeat(43)), null);
  } finally {
    store.close();
  }
});

test("only an authenticated host can issue invitations or remove table members", () => {
  const store = new AccessStore(":memory:", KEY);
  try {
    assert.throws(
      () => store.createInvitation("missing"),
      code("sign_in_required"),
    );
    const host = store.setupHost(KEY, "GM");
    const invitation = store.createInvitation(host.token);
    const player = store.redeemInvitation(invitation.token, "Player");
    assert.equal(player.member.role, "player");
    assert.equal(player.member.tableId, invitation.tableId);
    assert.throws(
      () => store.createInvitation(player.token),
      code("host_required"),
    );
    assert.throws(
      () => store.removeMember(player.token, host.member.id),
      code("host_required"),
    );
    assert.throws(
      () => store.removeMember(host.token, host.member.id),
      code("host_removal"),
    );
    assert.throws(() => store.createInvitation(host.token, -1));
    assert.throws(() => store.createInvitation(host.token, 8 * DAY));
  } finally {
    store.close();
  }
});

test("invitation use is atomic, single-use, and survives restart across database connections", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-access-"));
  const path = join(directory, "table.sqlite");
  let first = new AccessStore(path, KEY);
  const second = new AccessStore(path, KEY);
  try {
    const host = first.setupHost(KEY, "GM");
    assert.equal(second.setupRequired, false);
    assert.throws(
      () => second.setupHost(KEY, "Other GM"),
      code("setup_complete"),
    );
    const invitation = first.createInvitation(host.token);
    assert.throws(() => first.redeemInvitation(invitation.token, ""));
    const player = second.redeemInvitation(invitation.token, "Robin");
    assert.throws(
      () => first.redeemInvitation(invitation.token, "Other player"),
      code("invalid_invitation"),
    );
    first.close();
    first = new AccessStore(path, KEY);
    assert.deepEqual(first.authenticate(host.token), host.member);
    assert.deepEqual(first.authenticate(player.token), player.member);
    assert.throws(
      () => first.redeemInvitation(invitation.token, "Third player"),
      code("invalid_invitation"),
    );
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invitations and sessions expire at the deadline, and host recovery retains identity", () => {
  let now = 1000000;
  const store = new AccessStore(":memory:", KEY, () => now);
  try {
    assert.throws(() => store.recoverHost(KEY), code("setup_required"));
    const host = store.setupHost(KEY, "GM");
    const invitation = store.createInvitation(host.token, 60000);
    now = invitation.expiresAt;
    assert.throws(
      () => store.redeemInvitation(invitation.token, "Late player"),
      code("invalid_invitation"),
    );
    assert.deepEqual(store.authenticate(host.token), host.member);
    now = host.expiresAt;
    assert.equal(store.authenticate(host.token), null);
    assert.throws(
      () => store.createInvitation(host.token),
      code("sign_in_required"),
    );
    assert.throws(() => store.recoverHost("x".repeat(43)), code("invalid_key"));
    const recovered = store.recoverHost(KEY);
    assert.deepEqual(recovered.member, host.member);
    assert.notEqual(recovered.token, host.token);
    assert.deepEqual(store.authenticate(recovered.token), host.member);
  } finally {
    store.close();
  }
});

test("logout and membership removal revoke credentials immediately", () => {
  const store = new AccessStore(":memory:", KEY);
  try {
    const host = store.setupHost(KEY, "GM");
    const player = store.redeemInvitation(
      store.createInvitation(host.token).token,
      "Player",
    );
    store.removeMember(host.token, player.member.id);
    assert.equal(store.authenticate(player.token), null);
    assert.deepEqual(store.authenticate(host.token), host.member);
    store.revokeSession(host.token);
    assert.equal(store.authenticate(host.token), null);
    assert.throws(
      () => store.createInvitation(host.token),
      code("sign_in_required"),
    );
    store.revokeSession("malformed");
    assert.equal(store.setupRequired, false);
    assert.deepEqual(store.recoverHost(KEY).member, host.member);
  } finally {
    store.close();
  }
});

test("database stores hashes rather than raw session/invitation tokens or host keys", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-access-hashes-"));
  const path = join(directory, "table.sqlite");
  const store = new AccessStore(path, KEY);
  const db = new DatabaseSync(path);
  try {
    const host = store.setupHost(KEY, "GM");
    const invitation = store.createInvitation(host.token);
    const rows = JSON.stringify({
      sessions: db.prepare("SELECT * FROM access_sessions").all(),
      invitations: db.prepare("SELECT * FROM access_invitations").all(),
      host: db.prepare("SELECT * FROM access_host").all(),
    });
    assert.ok(!rows.includes(host.token));
    assert.ok(!rows.includes(invitation.token));
    assert.ok(!rows.includes(KEY));
    assert.ok(
      rows.includes(createHash("sha256").update(host.token).digest("hex")),
    );
    assert.ok(
      rows.includes(
        createHash("sha256").update(invitation.token).digest("hex"),
      ),
    );
  } finally {
    store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed session insert rolls back invitation consumption and identity creation", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-access-rollback-"));
  const path = join(directory, "table.sqlite");
  const store = new AccessStore(path, KEY);
  const db = new DatabaseSync(path);
  try {
    const host = store.setupHost(KEY, "GM");
    const invitation = store.createInvitation(host.token);
    db.exec(
      "CREATE TRIGGER reject_test_session BEFORE INSERT ON access_sessions BEGIN SELECT RAISE(ABORT, 'test write failure'); END;",
    );
    assert.throws(() => store.redeemInvitation(invitation.token, "Player"));
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM access_users").get()?.count,
      1,
    );
    assert.equal(
      db.prepare("SELECT consumed_at FROM access_invitations").get()
        ?.consumed_at,
      null,
    );
    db.exec("DROP TRIGGER reject_test_session");
    const player = store.redeemInvitation(invitation.token, "Player");
    assert.deepEqual(store.authenticate(player.token), player.member);
  } finally {
    store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("active invitation capacity is bounded and expires cleanly", () => {
  let now = 1000000;
  const store = new AccessStore(":memory:", KEY, () => now);
  try {
    const host = store.setupHost(KEY, "GM");
    for (let i = 0; i < 100; i++) store.createInvitation(host.token, 60000);
    assert.throws(
      () => store.createInvitation(host.token),
      code("invitation_limit"),
    );
    now += 60000;
    assert.equal(store.createInvitation(host.token).tableId, "main");
  } finally {
    store.close();
  }
});
