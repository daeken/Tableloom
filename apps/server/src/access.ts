import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { memberSchema } from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
export type { Member } from "@tableloom/core/access";

const TABLE_ID = "main";
const DAY = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME = 7 * DAY;
const MAX_INVITATION_LIFETIME = 7 * DAY;
const nameSchema = z.string().trim().min(1).max(32);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export interface SessionGrant {
  member: Member;
  /** Bearer credential: only give this to the cookie layer, never a public DTO or log. */
  token: string;
  expiresAt: number;
}
export interface InvitationGrant {
  /** Shown once to the host; the database stores only its hash. */
  token: string;
  expiresAt: number;
  tableId: typeof TABLE_ID;
}

const messages = {
  invalid_key: "The host key is invalid.",
  setup_complete: "This server already has a host.",
  setup_required: "Set up the host first.",
  sign_in_required: "Sign in to the table first.",
  host_required: "Only the host can manage table access.",
  invalid_invitation: "This invitation is invalid, expired, or already used.",
  invitation_limit: "This table already has 100 active invitations.",
  member_limit: "This table has reached its member limit.",
  host_removal: "The host cannot be removed from the table.",
} as const;
export class AccessError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "AccessError";
  }
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

/**
 * Persistent access primitives for the initial table. HTTP/cookie/WebSocket
 * enforcement is deliberately separate and must call these methods per request.
 * The host key belongs to the self-hoster, not the shared application database.
 */
export class AccessStore {
  private readonly db: DatabaseSync;
  private readonly keyHash: Buffer;

  constructor(
    databasePath: string,
    hostKey: string,
    private readonly now: () => number = Date.now,
  ) {
    z.string().min(32).max(512).parse(hostKey);
    this.keyHash = Buffer.from(hash(hostKey), "hex");
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS access_users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 32),
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS access_memberships (
        user_id TEXT NOT NULL REFERENCES access_users(id),
        table_id TEXT NOT NULL CHECK(table_id = 'main'),
        role TEXT NOT NULL CHECK(role IN ('gm', 'player')),
        PRIMARY KEY (user_id, table_id)
      );
      CREATE TABLE IF NOT EXISTS access_host (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        user_id TEXT NOT NULL REFERENCES access_users(id)
      );
      CREATE TABLE IF NOT EXISTS access_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        table_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY(user_id, table_id) REFERENCES access_memberships(user_id, table_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS access_sessions_expiry ON access_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS access_invitations (
        token_hash TEXT PRIMARY KEY,
        table_id TEXT NOT NULL CHECK(table_id = 'main'),
        created_by TEXT NOT NULL REFERENCES access_users(id),
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS access_invitations_expiry ON access_invitations(expires_at);`);
  }

  get setupRequired(): boolean {
    return !this.db
      .prepare("SELECT user_id FROM access_host WHERE id = 1")
      .get();
  }

  setupHost(key: string, name: string): SessionGrant {
    this.verifyHostKey(key);
    const parsedName = nameSchema.parse(name);
    return this.transaction(() => {
      if (!this.setupRequired) throw new AccessError("setup_complete");
      const member = this.addMember(parsedName, "gm");
      this.db
        .prepare("INSERT INTO access_host (id, user_id) VALUES (1, ?)")
        .run(member.id);
      return this.createSession(member);
    });
  }

  /** Lets the machine owner regain their existing identity after session loss. */
  recoverHost(key: string): SessionGrant {
    this.verifyHostKey(key);
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT u.id, u.name, m.table_id AS tableId, m.role
        FROM access_host h JOIN access_users u ON h.user_id = u.id
        JOIN access_memberships m ON u.id = m.user_id AND m.table_id = ?
        WHERE h.id = 1`,
        )
        .get(TABLE_ID);
      if (!row) throw new AccessError("setup_required");
      return this.createSession(memberSchema.parse(row));
    });
  }

  authenticate(token: string): Member | null {
    if (!tokenSchema.safeParse(token).success) return null;
    const row = this.db
      .prepare(
        `SELECT u.id, u.name, m.table_id AS tableId, m.role
      FROM access_sessions s JOIN access_users u ON s.user_id = u.id
      JOIN access_memberships m ON s.user_id = m.user_id AND s.table_id = m.table_id
      WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hash(token), this.now());
    return row ? memberSchema.parse(row) : null;
  }

  revokeSession(token: string): void {
    if (tokenSchema.safeParse(token).success) {
      this.db
        .prepare("DELETE FROM access_sessions WHERE token_hash = ?")
        .run(hash(token));
    }
  }

  createInvitation(sessionToken: string, lifetime = DAY): InvitationGrant {
    z.number().int().min(60000).max(MAX_INVITATION_LIFETIME).parse(lifetime);
    return this.transaction(() => {
      const host = this.requireHost(sessionToken);
      this.prune();
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM access_invitations WHERE table_id = ? AND consumed_at IS NULL",
        )
        .get(TABLE_ID);
      if (Number(count?.count) >= 100)
        throw new AccessError("invitation_limit");
      const token = newToken();
      const expiresAt = this.now() + lifetime;
      this.db
        .prepare(
          "INSERT INTO access_invitations (token_hash, table_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run(hash(token), TABLE_ID, host.id, expiresAt);
      return { token, expiresAt, tableId: TABLE_ID };
    });
  }

  redeemInvitation(token: string, name: string): SessionGrant {
    const parsedName = nameSchema.parse(name);
    if (!tokenSchema.safeParse(token).success)
      throw new AccessError("invalid_invitation");
    return this.transaction(() => {
      // A conditional write in the same transaction as identity/session creation
      // makes invitations single-use across multiple server connections too.
      const result = this.db
        .prepare(
          `UPDATE access_invitations SET consumed_at = ?
        WHERE token_hash = ? AND table_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        )
        .run(this.now(), hash(token), TABLE_ID, this.now());
      if (Number(result.changes) !== 1)
        throw new AccessError("invalid_invitation");
      const member = this.addMember(parsedName, "player");
      return this.createSession(member);
    });
  }

  /** Removing membership also revokes sessions through a database foreign key. */
  removeMember(sessionToken: string, memberId: string): void {
    z.uuid().parse(memberId);
    this.transaction(() => {
      const host = this.requireHost(sessionToken);
      if (memberId === host.id) throw new AccessError("host_removal");
      this.db
        .prepare(
          "DELETE FROM access_memberships WHERE user_id = ? AND table_id = ?",
        )
        .run(memberId, TABLE_ID);
    });
  }

  close(): void {
    this.db.close();
  }

  private verifyHostKey(key: string): void {
    if (
      key.length < 32 ||
      key.length > 512 ||
      !timingSafeEqual(this.keyHash, Buffer.from(hash(key), "hex"))
    ) {
      throw new AccessError("invalid_key");
    }
  }

  private requireHost(token: string): Member {
    const member = this.authenticate(token);
    if (!member) throw new AccessError("sign_in_required");
    if (member.role !== "gm") throw new AccessError("host_required");
    return member;
  }

  private addMember(name: string, role: Member["role"]): Member {
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM access_memberships WHERE table_id = ?",
      )
      .get(TABLE_ID);
    if (Number(count?.count) >= 1000) throw new AccessError("member_limit");
    const member = memberSchema.parse({
      id: randomUUID(),
      name,
      tableId: TABLE_ID,
      role,
    });
    this.db
      .prepare(
        "INSERT INTO access_users (id, name, created_at) VALUES (?, ?, ?)",
      )
      .run(member.id, name, this.now());
    this.db
      .prepare(
        "INSERT INTO access_memberships (user_id, table_id, role) VALUES (?, ?, ?)",
      )
      .run(member.id, TABLE_ID, role);
    return member;
  }

  private createSession(member: Member): SessionGrant {
    this.prune();
    const token = newToken();
    const expiresAt = this.now() + SESSION_LIFETIME;
    this.db
      .prepare(
        "INSERT INTO access_sessions (token_hash, user_id, table_id, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(hash(token), member.id, TABLE_ID, expiresAt);
    return { member, token, expiresAt };
  }

  private prune(): void {
    this.db
      .prepare("DELETE FROM access_sessions WHERE expires_at <= ?")
      .run(this.now());
    this.db
      .prepare("DELETE FROM access_invitations WHERE expires_at <= ?")
      .run(this.now());
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
