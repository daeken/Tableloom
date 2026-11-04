import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_CAMPAIGN_ID } from "@tableloom/core/campaigns";

const baseTables = [
  "access_users",
  "access_host",
  "access_memberships",
  "access_sessions",
  "access_invitations",
];
const legacyScope = z.literal("main");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative();
const userSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(32),
  created_at: timestamp,
});
const membershipSchema = z.object({
  user_id: z.uuid(),
  table_id: legacyScope,
  role: z.enum(["gm", "player"]),
});
const sessionSchema = z.object({
  token_hash: hash,
  user_id: z.uuid(),
  table_id: legacyScope,
  expires_at: timestamp,
});
const invitationSchema = z.object({
  token_hash: hash,
  table_id: legacyScope,
  created_by: z.uuid(),
  expires_at: timestamp,
  consumed_at: timestamp.nullable(),
  id: z.uuid().nullish(),
  target_user_id: z.uuid().nullish(),
});

/** Must run inside a transaction, including all ALTER/COPY/DROP operations. */
export function initializeAccess(db: DatabaseSync) {
  const has = (name: string) =>
    Boolean(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(name),
    );
  if (has("access_storage_version")) {
    z.literal(1).parse(
      db
        .prepare("SELECT version FROM access_storage_version WHERE id = 1")
        .get()?.version,
    );
    if ([...baseTables, "access_campaigns"].some((name) => !has(name)))
      throw new Error("Campaign access storage is incomplete.");
    return;
  }
  if (has("access_campaigns"))
    throw new Error("Campaign access storage is missing its schema version.");
  const legacy = baseTables.some(has);
  if (legacy && !baseTables.every(has))
    throw new Error("Legacy access storage is incomplete.");
  const users = legacy
    ? z.array(userSchema).parse(db.prepare("SELECT * FROM access_users").all())
    : [];
  const members = legacy
    ? z
        .array(membershipSchema)
        .parse(db.prepare("SELECT * FROM access_memberships").all())
    : [];
  const sessions = legacy
    ? z
        .array(sessionSchema)
        .parse(db.prepare("SELECT * FROM access_sessions").all())
    : [];
  const invites = legacy
    ? z
        .array(invitationSchema)
        .parse(db.prepare("SELECT * FROM access_invitations").all())
    : [];
  if (legacy) {
    const host = db
      .prepare("SELECT user_id FROM access_host WHERE id = 1")
      .get();
    if (
      users.length &&
      (!host ||
        !members.some(
          (member) => member.user_id === host.user_id && member.role === "gm",
        ))
    )
      throw new Error("Legacy access is missing its host membership.");
    db.exec(`ALTER TABLE access_sessions RENAME TO legacy_access_sessions;
      ALTER TABLE access_invitations RENAME TO legacy_access_invitations;
      ALTER TABLE access_memberships RENAME TO legacy_access_memberships;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_users (
      id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 32), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS access_host (
      id INTEGER PRIMARY KEY CHECK(id = 1), user_id TEXT NOT NULL REFERENCES access_users(id)
    );
    CREATE TABLE access_campaigns (id TEXT PRIMARY KEY CHECK(length(id) = 36));
    CREATE TABLE access_memberships (
      user_id TEXT NOT NULL REFERENCES access_users(id),
      table_id TEXT NOT NULL REFERENCES access_campaigns(id),
      role TEXT NOT NULL CHECK(role IN ('gm', 'player')), PRIMARY KEY(user_id, table_id)
    );
    CREATE TABLE access_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, table_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      FOREIGN KEY(user_id, table_id) REFERENCES access_memberships(user_id, table_id) ON DELETE CASCADE
    );
    CREATE TABLE access_invitations (
      token_hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, table_id TEXT NOT NULL REFERENCES access_campaigns(id),
      created_by TEXT NOT NULL REFERENCES access_users(id), expires_at INTEGER NOT NULL, consumed_at INTEGER,
      target_user_id TEXT,
      FOREIGN KEY(target_user_id, table_id) REFERENCES access_memberships(user_id, table_id) ON DELETE CASCADE
    );
    CREATE TABLE access_storage_version (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO access_campaigns(id) VALUES (?)").run(
    DEFAULT_CAMPAIGN_ID,
  );
  for (const member of members)
    db.prepare(
      "INSERT INTO access_memberships(user_id, table_id, role) VALUES (?, ?, ?)",
    ).run(member.user_id, DEFAULT_CAMPAIGN_ID, member.role);
  for (const session of sessions)
    db.prepare(
      "INSERT INTO access_sessions(token_hash, user_id, table_id, expires_at) VALUES (?, ?, ?, ?)",
    ).run(
      session.token_hash,
      session.user_id,
      DEFAULT_CAMPAIGN_ID,
      session.expires_at,
    );
  for (const invite of invites)
    db.prepare(
      "INSERT INTO access_invitations(token_hash, id, table_id, created_by, expires_at, consumed_at, target_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      invite.token_hash,
      invite.id ?? randomUUID(),
      DEFAULT_CAMPAIGN_ID,
      invite.created_by,
      invite.expires_at,
      invite.consumed_at,
      invite.target_user_id ?? null,
    );
  if (legacy)
    db.exec(
      "DROP TABLE legacy_access_sessions; DROP TABLE legacy_access_invitations; DROP TABLE legacy_access_memberships;",
    );
  db.exec(`CREATE INDEX access_sessions_expiry ON access_sessions(expires_at);
    CREATE INDEX access_invitations_expiry ON access_invitations(expires_at);
    CREATE INDEX access_invitation_scope ON access_invitations(table_id, expires_at);
    CREATE INDEX access_membership_user ON access_memberships(user_id);
    INSERT INTO access_storage_version(id, version) VALUES (1, 1);`);
  for (const table of [
    "access_host",
    "access_memberships",
    "access_sessions",
    "access_invitations",
  ])
    if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length)
      throw new Error("Access migration contains an invalid relationship.");
}
