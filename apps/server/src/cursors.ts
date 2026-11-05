import { contextKey, type CommandContext } from "@tableloom/core/campaigns";
import {
  CURSOR_TTL_MS,
  type CursorPosition,
  type ParticipantCursor,
} from "@tableloom/core";
import type { Member } from "@tableloom/core/access";
interface Entry {
  owner: object;
  memberId: string;
  context: CommandContext;
  position: NonNullable<CursorPosition>;
  expires: number;
}
/** Memory only, at most one pointer per identity. A hide/close never revives an older tab. */
export class CursorStore {
  private entries = new Map<string, Map<string, Entry>>();
  private contexts = new Map<string, string>();
  update(
    owner: object,
    member: Member,
    context: CommandContext,
    position: CursorPosition,
    now: number,
    renewOnly = false,
  ): boolean {
    if (member.tableId !== context.campaignId) return false;
    this.activate(context);
    let campaign = this.entries.get(member.tableId);
    if (!campaign) {
      campaign = new Map();
      this.entries.set(member.tableId, campaign);
    }
    const previous = campaign.get(member.id);
    if (renewOnly) {
      if (
        previous?.owner !== owner ||
        previous.expires <= now ||
        !position ||
        previous.position.x !== position.x ||
        previous.position.y !== position.y
      )
        return false;
      previous.expires = now + CURSOR_TTL_MS;
      return false;
    }
    if (!previous && position !== null && campaign.size >= 1000) return false;
    if (!position) {
      if (previous?.owner !== owner) return false;
      campaign.delete(member.id);
      return true;
    }
    const changed =
      !previous ||
      previous.owner !== owner ||
      previous.position.x !== position.x ||
      previous.position.y !== position.y;
    campaign.set(member.id, {
      owner,
      memberId: member.id,
      context: { ...context },
      position: { ...position },
      expires: now + CURSOR_TTL_MS,
    });
    return changed;
  }
  activate(context: CommandContext): boolean {
    const key = contextKey(context),
      previous = this.contexts.get(context.campaignId);
    this.contexts.set(context.campaignId, key);
    if (previous === key) return false;
    const changed = Boolean(this.entries.get(context.campaignId)?.size);
    this.entries.delete(context.campaignId);
    return changed;
  }
  remove(owner: object): Set<string> {
    const changed = new Set<string>();
    for (const [id, entries] of this.entries)
      for (const [member, entry] of entries)
        if (entry.owner === owner) {
          entries.delete(member);
          changed.add(id);
        }
    return changed;
  }
  expire(now: number): Set<string> {
    const changed = new Set<string>();
    for (const [id, entries] of this.entries)
      for (const [member, entry] of entries)
        if (entry.expires <= now) {
          entries.delete(member);
          changed.add(id);
        }
    return changed;
  }
  project(
    context: CommandContext,
    viewerId: string,
    authorized: (owner: object) => Member | null,
    now: number,
  ): ParticipantCursor[] {
    const key = contextKey(context),
      result: ParticipantCursor[] = [];
    for (const entry of this.entries.get(context.campaignId)?.values() ?? []) {
      const member = authorized(entry.owner);
      if (
        entry.memberId !== viewerId &&
        entry.expires > now &&
        contextKey(entry.context) === key &&
        member?.id === entry.memberId &&
        member.tableId === context.campaignId
      )
        result.push({
          memberId: entry.memberId,
          position: { ...entry.position },
        });
    }
    return result.sort((a, b) =>
      a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0,
    );
  }
  campaigns(): string[] {
    return [...this.entries]
      .filter(([, entries]) => entries.size > 0)
      .map(([id]) => id);
  }
  has(campaignId: string): boolean {
    return Boolean(this.entries.get(campaignId)?.size);
  }
}
