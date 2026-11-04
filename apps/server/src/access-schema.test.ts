import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccessStore } from "./access.js";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";

const KEY = "tableloom-access-schema-fixture-not-a-real-key";
const NOW = 1000000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function legacy(db: DatabaseSync, managed: boolean) {
  db.exec(`CREATE TABLE access_users(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE access_host(id INTEGER PRIMARY KEY CHECK(id = 1), user_id TEXT NOT NULL REFERENCES access_users(id));
    CREATE TABLE access_memberships(user_id TEXT NOT NULL REFERENCES access_users(id), table_id TEXT NOT NULL CHECK(table_id = 'main'), role TEXT NOT NULL CHECK(role IN ('gm', 'player')), PRIMARY KEY(user_id, table_id));
    CREATE TABLE access_sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, table_id TEXT NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY(user_id, table_id) REFERENCES access_memberships(user_id, table_id) ON DELETE CASCADE);
    CREATE TABLE access_invitations(token_hash TEXT PRIMARY KEY, table_id TEXT NOT NULL CHECK(table_id = 'main'), created_by TEXT NOT NULL REFERENCES access_users(id), expires_at INTEGER NOT NULL, consumed_at INTEGER);
    CREATE INDEX access_sessions_expiry ON access_sessions(expires_at);
    CREATE INDEX access_invitations_expiry ON access_invitations(expires_at);`);
  if (managed)
    db.exec(
      "ALTER TABLE access_invitations ADD COLUMN id TEXT; ALTER TABLE access_invitations ADD COLUMN target_user_id TEXT REFERENCES access_users(id); CREATE UNIQUE INDEX access_invitation_id ON access_invitations(id);",
    );
  const hostId = randomUUID(),
    playerId = randomUUID();
  const hostToken = "h".repeat(43),
    playerToken = "p".repeat(43),
    invitationToken = "i".repeat(43),
    usedToken = "u".repeat(43),
    recoveryToken = "r".repeat(43);
  for (const [id, name, role] of [
    [hostId, "GM", "gm"],
    [playerId, "Player", "player"],
  ]) {
    db.prepare(
      "INSERT INTO access_users(id, name, created_at) VALUES (?, ?, ?)",
    ).run(id!, name!, NOW);
    db.prepare(
      "INSERT INTO access_memberships(user_id, table_id, role) VALUES (?, 'main', ?)",
    ).run(id!, role!);
  }
  db.prepare("INSERT INTO access_host(id, user_id) VALUES (1, ?)").run(hostId);
  for (const [token, userId] of [
    [hostToken, hostId],
    [playerToken, playerId],
  ])
    db.prepare(
      "INSERT INTO access_sessions(token_hash, user_id, table_id, expires_at) VALUES (?, ?, 'main', ?)",
    ).run(hash(token!), userId!, NOW + 86400000);
  const invitationId = randomUUID(),
    recoveryId = randomUUID();
  for (const [token, consumed] of [
    [invitationToken, null],
    [usedToken, NOW],
  ] as const) {
    db.prepare(
      "INSERT INTO access_invitations(token_hash, table_id, created_by, expires_at, consumed_at) VALUES (?, 'main', ?, ?, ?)",
    ).run(hash(String(token)), hostId, NOW + 86400000, consumed);
    if (managed)
      db.prepare(
        "UPDATE access_invitations SET id = ? WHERE token_hash = ?",
      ).run(
        token === invitationToken ? invitationId : randomUUID(),
        hash(String(token)),
      );
  }
  if (managed)
    db.prepare(
      "INSERT INTO access_invitations(token_hash, table_id, created_by, expires_at, consumed_at, id, target_user_id) VALUES (?, 'main', ?, ?, NULL, ?, ?)",
    ).run(hash(recoveryToken), hostId, NOW + 86400000, recoveryId, playerId);
  return {
    hostId,
    playerId,
    hostToken,
    playerToken,
    invitationToken,
    invitationId,
    usedToken,
    recoveryToken,
    recoveryId,
  };
}

for (const managed of [false, true])
  test(`legacy ${managed ? "managed" : "original"} access migrates once without replacing identities or credentials`, () => {
    const directory = mkdtempSync(join(tmpdir(), "tableloom-access-schema-")),
      path = join(directory, "table.sqlite");
    const db = new DatabaseSync(path),
      fixture = legacy(db, managed);
    let store: AccessStore | undefined;
    try {
      const originalHashes = db
        .prepare("SELECT token_hash FROM access_sessions ORDER BY token_hash")
        .all()
        .map((row) => row.token_hash);
      store = new AccessStore(path, KEY, () => NOW);
      const host = store.authenticate(fixture.hostToken)!,
        player = store.authenticate(fixture.playerToken)!;
      assert.equal(host.id, fixture.hostId);
      assert.equal(player.id, fixture.playerId);
      assert.equal(host.tableId, DEFAULT_CAMPAIGN_ID);
      assert.equal(player.tableId, DEFAULT_CAMPAIGN_ID);
      assert.deepEqual(
        db
          .prepare("SELECT token_hash FROM access_sessions ORDER BY token_hash")
          .all()
          .map((row) => row.token_hash),
        originalHashes,
      );
      assert.equal(store.recoverHost(KEY).member.id, fixture.hostId);
      const pending = store.listInvitations(fixture.hostToken);
      assert.equal(pending.length, managed ? 2 : 1);
      if (managed) {
        assert.ok(
          pending.some((invitation) => invitation.id === fixture.invitationId),
        );
        assert.ok(
          pending.some(
            (invitation) =>
              invitation.id === fixture.recoveryId &&
              invitation.memberId === fixture.playerId,
          ),
        );
      }
      store.close();
      store = new AccessStore(path, KEY, () => NOW);
      assert.deepEqual(store.listInvitations(fixture.hostToken), pending); // Backfilled IDs are stable.
      assert.equal(
        store.redeemInvitation(fixture.invitationToken, "New player").member
          .tableId,
        DEFAULT_CAMPAIGN_ID,
      );
      assert.throws(() => store!.redeemInvitation(fixture.usedToken, "Replay"));
      if (managed) {
        assert.equal(
          store.redeemInvitation(fixture.recoveryToken, "Ignored").member.id,
          fixture.playerId,
        );
        assert.equal(store.authenticate(fixture.playerToken), null);
      }
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'legacy_access_%'",
          )
          .get()?.count,
        0,
      );
      const serialized = JSON.stringify(
        db.prepare("SELECT * FROM access_invitations").all(),
      );
      assert.ok(!serialized.includes(fixture.invitationToken));
      assert.ok(!serialized.includes(KEY));
    } finally {
      store?.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("access migration rolls back mid-copy failures, and unknown/incomplete versions never reconstruct data", () => {
  const directory = mkdtempSync(join(tmpdir(), "tableloom-access-failure-")),
    path = join(directory, "table.sqlite");
  const db = new DatabaseSync(path),
    fixture = legacy(db, true);
  let store: AccessStore | undefined;
  try {
    db.exec("PRAGMA foreign_keys = OFF"); // Deliberately construct a corrupt legacy relationship.
    db.prepare(
      "UPDATE access_invitations SET target_user_id = ? WHERE id = ?",
    ).run(randomUUID(), fixture.recoveryId);
    const original = {
      memberships: db.prepare("SELECT * FROM access_memberships").all(),
      sessions: db.prepare("SELECT * FROM access_sessions").all(),
      invitations: db.prepare("SELECT * FROM access_invitations").all(),
    };
    assert.throws(() => new AccessStore(path, KEY, () => NOW));
    assert.deepEqual(
      db.prepare("SELECT * FROM access_memberships").all(),
      original.memberships,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM access_sessions").all(),
      original.sessions,
    );
    assert.deepEqual(
      db.prepare("SELECT * FROM access_invitations").all(),
      original.invitations,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'access_campaigns'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'access_storage_version'",
        )
        .get(),
      undefined,
    );
    db.prepare(
      "UPDATE access_invitations SET target_user_id = ? WHERE id = ?",
    ).run(fixture.playerId, fixture.recoveryId);
    store = new AccessStore(path, KEY, () => NOW);
    store.close();
    store = undefined;
    db.exec("UPDATE access_storage_version SET version = 99");
    assert.throws(() => new AccessStore(db, KEY), /Invalid input/);
    assert.equal(
      db.prepare("SELECT version FROM access_storage_version").get()?.version,
      99,
    ); // Borrowed connection stays open.
    db.exec(
      "UPDATE access_storage_version SET version = 1; DROP TABLE access_sessions;",
    );
    assert.throws(() => new AccessStore(path, KEY), /incomplete/);
    assert.equal(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'access_sessions'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM access_memberships").get()
        ?.count,
      2,
    );
  } finally {
    store?.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
