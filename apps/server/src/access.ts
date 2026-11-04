import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  memberSchema,
  membersSchema,
  invitationsSchema,
} from "@tableloom/core/access";
import type { Member } from "@tableloom/core/access";
export type { Member } from "@tableloom/core/access";
import { DEFAULT_CAMPAIGN_ID, MAX_CAMPAIGNS } from "@tableloom/core/campaigns";
import { transaction } from "./database.js";
import { initializeAccess } from "./access-schema.js";

const TABLE_ID = DEFAULT_CAMPAIGN_ID;
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
  id: string;
  /** Shown once to the host; the database stores only its hash. */
  token: string;
  expiresAt: number;
  tableId: string;
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
  invalid_member: "Choose an existing player at this table.",
  campaign_unavailable: "That campaign is unavailable.",
  campaign_exists: "This campaign already has an access scope.",
  campaign_limit: "This server has reached its campaign limit.",
  member_exists: "This identity already belongs to that campaign.",
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
 * Persistent identities and campaign-scoped credentials. HTTP/cookie/WebSocket
 * enforcement is deliberately separate and must call these methods per request.
 * The host key belongs to the self-hoster, not the shared application database.
 */
export class AccessStore {
  private readonly db: DatabaseSync;
  private readonly keyHash: Buffer;
  private readonly ownsConnection: boolean;

  constructor(
    databasePath: string | DatabaseSync,
    hostKey: string,
    private readonly now: () => number = Date.now,
  ) {
    z.string().min(32).max(512).parse(hostKey);
    this.keyHash = Buffer.from(hash(hostKey), "hex");
    this.ownsConnection = typeof databasePath === "string";
    this.db =
      typeof databasePath === "string"
        ? new DatabaseSync(databasePath)
        : databasePath;
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      this.transaction(() => initializeAccess(this.db));
    } catch (error) {
      if (this.ownsConnection) this.db.close();
      throw error;
    }
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
      JOIN access_campaigns c ON c.id = m.table_id
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

  /** Trusted service operation: combine with campaign creation in one DB transaction. */
  registerCampaign(sessionToken: string, campaignId: string): Member {
    z.uuid().parse(campaignId);
    return this.transaction(() => {
      const host = this.requireServerHost(sessionToken);
      if (
        this.db
          .prepare("SELECT id FROM access_campaigns WHERE id = ?")
          .get(campaignId)
      )
        throw new AccessError("campaign_exists");
      if (
        Number(
          this.db
            .prepare("SELECT COUNT(*) AS count FROM access_campaigns")
            .get()?.count,
        ) >= MAX_CAMPAIGNS
      )
        throw new AccessError("campaign_limit");
      this.db
        .prepare("INSERT INTO access_campaigns(id) VALUES (?)")
        .run(campaignId);
      return this.addMembership(host.id, campaignId, "gm");
    });
  }

  requireServerHost(sessionToken: string): Member {
    const host = this.requireHost(sessionToken);
    const owner = this.db
      .prepare("SELECT user_id FROM access_host WHERE id = 1")
      .get();
    if (host.id !== owner?.user_id) throw new AccessError("host_required");
    return host;
  }

  listMemberships(sessionToken: string): Member[] {
    const member = this.authenticate(sessionToken);
    if (!member) throw new AccessError("sign_in_required");
    return membersSchema.parse(
      this.db
        .prepare(
          `SELECT u.id, u.name, m.table_id AS tableId, m.role
      FROM access_memberships m JOIN access_users u ON m.user_id = u.id WHERE u.id = ? ORDER BY m.table_id`,
        )
        .all(member.id),
    );
  }

  resolveMembership(sessionToken: string, campaignId: string): Member {
    z.uuid().parse(campaignId);
    const current = this.authenticate(sessionToken);
    if (!current) throw new AccessError("sign_in_required");
    const target = this.getMember(current.id, campaignId);
    if (!target) throw new AccessError("campaign_unavailable");
    return target;
  }

  /** Rotate only this session; its campaign never changes in place under a live socket. */
  selectCampaign(sessionToken: string, campaignId: string): SessionGrant {
    return this.transaction(() => {
      const target = this.resolveMembership(sessionToken, campaignId);
      const grant = this.createSession(target);
      this.revokeSession(sessionToken);
      return grant;
    });
  }

  createInvitation(sessionToken: string, lifetime = DAY): InvitationGrant {
    return this.issueInvitation(sessionToken, null, lifetime);
  }

  /** The GM selects the identity. Names supplied by the returning player cannot retarget it. */
  createRecoveryInvitation(
    sessionToken: string,
    memberId: string,
    lifetime = DAY,
  ): InvitationGrant {
    z.uuid().parse(memberId);
    return this.issueInvitation(sessionToken, memberId, lifetime);
  }

  listMembers(sessionToken: string): Member[] {
    const host = this.requireHost(sessionToken);
    return membersSchema.parse(
      this.db
        .prepare(
          `SELECT u.id, u.name, m.table_id AS tableId, m.role
      FROM access_memberships m JOIN access_users u ON m.user_id = u.id
      WHERE m.table_id = ? ORDER BY u.created_at, u.id`,
        )
        .all(host.tableId),
    );
  }

  listInvitations(sessionToken: string) {
    const host = this.requireHost(sessionToken);
    return invitationsSchema.parse(
      this.db
        .prepare(
          `SELECT id, table_id AS tableId, expires_at AS expiresAt,
      target_user_id AS memberId FROM access_invitations
      WHERE table_id = ? AND consumed_at IS NULL AND expires_at > ? ORDER BY expires_at, id`,
        )
        .all(host.tableId, this.now()),
    );
  }

  revokeInvitation(sessionToken: string, invitationId: string): void {
    const host = this.requireHost(sessionToken);
    z.uuid().parse(invitationId);
    this.db
      .prepare("DELETE FROM access_invitations WHERE id = ? AND table_id = ?")
      .run(invitationId, host.tableId);
  }

  private issueInvitation(
    sessionToken: string,
    memberId: string | null,
    lifetime: number,
  ): InvitationGrant {
    z.number().int().min(60000).max(MAX_INVITATION_LIFETIME).parse(lifetime);
    return this.transaction(() => {
      const host = this.requireHost(sessionToken);
      this.prune();
      if (memberId !== null) {
        const member = this.getMember(memberId, host.tableId);
        if (!member || member.role !== "player")
          throw new AccessError("invalid_member");
        // Only the latest recovery code for an identity remains usable.
        this.db
          .prepare(
            "DELETE FROM access_invitations WHERE table_id = ? AND target_user_id = ?",
          )
          .run(host.tableId, memberId);
      }
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM access_invitations WHERE table_id = ? AND consumed_at IS NULL",
        )
        .get(host.tableId);
      if (Number(count?.count) >= 100)
        throw new AccessError("invitation_limit");
      const token = newToken();
      const id = randomUUID();
      const expiresAt = this.now() + lifetime;
      this.db
        .prepare(
          "INSERT INTO access_invitations (token_hash, table_id, created_by, expires_at, id, target_user_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(hash(token), host.tableId, host.id, expiresAt, id, memberId);
      return { id, token, expiresAt, tableId: host.tableId };
    });
  }

  redeemInvitation(
    token: string,
    name: string,
    options: { sessionToken?: string; campaignId?: string } = {},
  ): SessionGrant {
    const parsedName = nameSchema.parse(name);
    if (options.campaignId !== undefined) z.uuid().parse(options.campaignId);
    if (!tokenSchema.safeParse(token).success)
      throw new AccessError("invalid_invitation");
    return this.transaction(() => {
      const signedIn = options.sessionToken
        ? this.authenticate(options.sessionToken)
        : null;
      if (options.sessionToken && !signedIn)
        throw new AccessError("sign_in_required");
      const result = this.db
        .prepare(
          `UPDATE access_invitations SET consumed_at = ?
        WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING target_user_id, table_id`,
        )
        .get(this.now(), hash(token), this.now());
      if (!result) throw new AccessError("invalid_invitation");
      const campaignId = z.uuid().parse(result.table_id);
      if (options.campaignId !== undefined && campaignId !== options.campaignId)
        throw new AccessError("invalid_invitation");
      let member: Member;
      if (result.target_user_id !== null) {
        const existing = this.getMember(
          z.uuid().parse(result.target_user_id),
          campaignId,
        );
        if (!existing || existing.role !== "player")
          throw new AccessError("invalid_invitation");
        member = existing;
        // Recovery revokes this identity's sessions in this campaign only.
        this.db
          .prepare(
            "DELETE FROM access_sessions WHERE user_id = ? AND table_id = ?",
          )
          .run(member.id, campaignId);
      } else if (signedIn) {
        member = this.addMembership(signedIn.id, campaignId, "player");
      } else member = this.addMember(parsedName, "player", campaignId);
      return this.createSession(member);
    });
  }

  /** Removing membership also revokes sessions through a database foreign key. */
  removeMember(sessionToken: string, memberId: string): void {
    z.uuid().parse(memberId);
    this.transaction(() => {
      const host = this.requireHost(sessionToken);
      const serverHost = this.db
        .prepare("SELECT user_id FROM access_host WHERE id = 1")
        .get();
      if (memberId === host.id || memberId === serverHost?.user_id)
        throw new AccessError("host_removal");
      this.db
        .prepare(
          "DELETE FROM access_invitations WHERE target_user_id = ? AND table_id = ?",
        )
        .run(memberId, host.tableId);
      this.db
        .prepare(
          "DELETE FROM access_memberships WHERE user_id = ? AND table_id = ?",
        )
        .run(memberId, host.tableId);
    });
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
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

  /** Internal membership lookup; never accept a recipient object from a client. */
  getMember(id: string, campaignId = TABLE_ID): Member | null {
    z.uuid().parse(id);
    z.uuid().parse(campaignId);
    const row = this.db
      .prepare(
        `SELECT u.id, u.name, m.table_id AS tableId, m.role
      FROM access_users u JOIN access_memberships m ON u.id = m.user_id
      WHERE u.id = ? AND m.table_id = ?`,
      )
      .get(id, campaignId);
    return row ? memberSchema.parse(row) : null;
  }

  private addMember(
    name: string,
    role: Member["role"],
    campaignId = TABLE_ID,
  ): Member {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO access_users(id, name, created_at) VALUES (?, ?, ?)",
      )
      .run(id, name, this.now());
    return this.addMembership(id, campaignId, role);
  }

  private addMembership(
    userId: string,
    campaignId: string,
    role: Member["role"],
  ): Member {
    z.uuid().parse(campaignId);
    if (
      !this.db
        .prepare("SELECT id FROM access_campaigns WHERE id = ?")
        .get(campaignId)
    )
      throw new AccessError("campaign_unavailable");
    if (this.getMember(userId, campaignId))
      throw new AccessError("member_exists");
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM access_memberships WHERE table_id = ?",
      )
      .get(campaignId);
    if (Number(count?.count) >= 1000) throw new AccessError("member_limit");
    this.db
      .prepare(
        "INSERT INTO access_memberships(user_id, table_id, role) VALUES (?, ?, ?)",
      )
      .run(userId, campaignId, role);
    return this.getMember(userId, campaignId)!;
  }

  private createSession(member: Member): SessionGrant {
    this.prune();
    const token = newToken();
    const expiresAt = this.now() + SESSION_LIFETIME;
    this.db
      .prepare(
        "INSERT INTO access_sessions (token_hash, user_id, table_id, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(hash(token), member.id, member.tableId, expiresAt);
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
    return transaction(this.db, action);
  }
}
