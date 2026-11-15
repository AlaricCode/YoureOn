/**
 * Huddles (§12.3, D-22, D-31): a 6-digit room code; joiners are added
 * unconfirmed; the creator's face scan confirms them (closed set = the
 * joined members). Only confirmed members can be bet participants.
 */
import { MAX_HUDDLE, RECENT_HUDDLE_S } from '@verdict/engine';
import { ApiError } from '../errors.js';
import { COLLECTIONS, userView, type UserRecord, type UserView } from '../persistence/records.js';
import type { Collection, JsonStore } from '../persistence/store.js';
import type { Clock } from '../util/clock.js';
import { randomDigits, uuid } from '../util/ids.js';

export interface HuddleMemberRecord {
  user_id: string;
  joined_at_ms: number;
  confirmed: boolean;
  confirmed_at_ms: number | null;
  /** cos_bps of the confirming face match (null for the creator) */
  confirmed_cos_bps: number | null;
}

export interface HuddleRecord {
  id: string;
  code: string;
  creator_user_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  /** join order; the creator is first */
  members: HuddleMemberRecord[];
}

/** §12.2 HuddleView */
export interface HuddleView {
  id: string;
  code: string;
  creator_user_id: string;
  members: { user: UserView; joined_at_ms: number; confirmed: boolean }[];
}

export const HUDDLE_CODE_TTL_MS = RECENT_HUDDLE_S * 1000;
/** Unconfirmed joiners a huddle holds at once (a leaked/guessed code cannot fill MAX_HUDDLE). */
export const MAX_PENDING_JOINS = 4;
/** An unconfirmed joiner older than this is dropped when a new joiner needs the slot. */
export const PENDING_JOIN_TTL_MS = 10 * 60_000;

export class HuddleService {
  readonly huddles: Collection<HuddleRecord>;
  readonly users: Collection<UserRecord>;
  private readonly listeners: ((h: HuddleRecord) => void)[] = [];

  constructor(
    store: JsonStore,
    private readonly clock: Clock,
  ) {
    this.huddles = store.collection<HuddleRecord>(COLLECTIONS.huddles);
    this.users = store.collection<UserRecord>(COLLECTIONS.users);
  }

  /** Called after every membership change (WS publish). */
  onChange(fn: (h: HuddleRecord) => void): void {
    this.listeners.push(fn);
  }

  private changed(h: HuddleRecord): HuddleRecord {
    for (const l of this.listeners) l(h);
    return h;
  }

  private codeLive(h: HuddleRecord, now: number): boolean {
    return now - h.created_at_ms <= HUDDLE_CODE_TTL_MS;
  }

  create(creatorId: string): HuddleRecord {
    const now = this.clock.nowMs();
    let code = randomDigits(6);
    for (let i = 0; i < 50 && this.huddles.find((h) => h.code === code && this.codeLive(h, now)); i++) code = randomDigits(6);
    if (this.huddles.find((h) => h.code === code && this.codeLive(h, now))) throw new ApiError('INTERNAL', 'no free huddle code');
    const h: HuddleRecord = {
      id: uuid(),
      code,
      creator_user_id: creatorId,
      created_at_ms: now,
      updated_at_ms: now,
      members: [{ user_id: creatorId, joined_at_ms: now, confirmed: true, confirmed_at_ms: now, confirmed_cos_bps: null }],
    };
    this.huddles.set(h.id, h);
    return this.changed(h);
  }

  join(userId: string, code: unknown): HuddleRecord {
    if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) throw new ApiError('CODE_INVALID');
    const now = this.clock.nowMs();
    const matches = this.huddles.filter((h) => h.code === code && this.codeLive(h, now));
    const h = matches.sort((a, b) => b.created_at_ms - a.created_at_ms)[0];
    if (!h) throw new ApiError('CODE_INVALID');
    if (h.members.some((m) => m.user_id === userId)) return h;
    // Pending quota: stale unconfirmed joiners make room; fresh ones are capped.
    const fresh = (m: HuddleMemberRecord) => m.confirmed || now - m.joined_at_ms < PENDING_JOIN_TTL_MS;
    const live = h.members.filter(fresh);
    const pending = live.filter((m) => !m.confirmed).length;
    if (live.length >= MAX_HUDDLE || pending >= MAX_PENDING_JOINS) throw new ApiError('HUDDLE_FULL');
    const next = this.huddles.update(h.id, (x) => {
      x.members = x.members.filter(fresh);
      x.members.push({ user_id: userId, joined_at_ms: now, confirmed: false, confirmed_at_ms: null, confirmed_cos_bps: null });
      x.updated_at_ms = now;
    });
    return this.changed(next);
  }

  isConfirmed(huddleId: string, userId: string): boolean {
    return !!this.huddles.get(huddleId)?.members.some((m) => m.user_id === userId && m.confirmed);
  }

  /** The huddle, visible only to its members (others get NOT_FOUND). */
  requireForMember(huddleId: string, userId: string): HuddleRecord {
    const h = this.huddles.get(huddleId);
    if (!h || !h.members.some((m) => m.user_id === userId)) throw new ApiError('NOT_FOUND', `huddle ${huddleId}`);
    return h;
  }

  /** The huddle, for a confirmed member (unconfirmed members get WRONG_STATE). */
  requireForConfirmed(huddleId: string, userId: string): HuddleRecord {
    const h = this.requireForMember(huddleId, userId);
    if (!h.members.find((m) => m.user_id === userId)!.confirmed) throw new ApiError('WRONG_STATE', 'not a confirmed member');
    return h;
  }

  confirm(huddleId: string, userIds: { user_id: string; cos_bps: number }[]): HuddleRecord {
    const now = this.clock.nowMs();
    let changed = false;
    const next = this.huddles.update(huddleId, (h) => {
      for (const { user_id, cos_bps } of userIds) {
        const m = h.members.find((x) => x.user_id === user_id);
        if (m && !m.confirmed) {
          m.confirmed = true;
          m.confirmed_at_ms = now;
          m.confirmed_cos_bps = cos_bps;
          changed = true;
        }
      }
      if (changed) h.updated_at_ms = now;
    });
    return changed ? this.changed(next) : next;
  }

  /**
   * Removes a member. The creator may remove anyone but themself; a member
   * may remove themself (leave).
   */
  removeMember(huddleId: string, callerId: string, targetId: string): HuddleRecord {
    const h = this.requireForMember(huddleId, callerId);
    if (targetId === h.creator_user_id) throw new ApiError('WRONG_STATE', 'the creator cannot be removed');
    if (callerId !== h.creator_user_id && callerId !== targetId) throw new ApiError('WRONG_STATE', 'only the creator removes others');
    if (!h.members.some((m) => m.user_id === targetId)) throw new ApiError('NOT_FOUND', `member ${targetId}`);
    const next = this.huddles.update(huddleId, (x) => {
      x.members = x.members.filter((m) => m.user_id !== targetId);
      x.updated_at_ms = this.clock.nowMs();
    });
    return this.changed(next);
  }

  user(userId: string): UserRecord {
    const u = this.users.get(userId);
    if (!u) throw new ApiError('NOT_FOUND', `user ${userId}`);
    return u;
  }

  view(h: HuddleRecord): HuddleView {
    return {
      id: h.id,
      code: h.code,
      creator_user_id: h.creator_user_id,
      members: h.members.flatMap((m) => {
        const u = this.users.get(m.user_id);
        return u ? [{ user: userView(u), joined_at_ms: m.joined_at_ms, confirmed: m.confirmed }] : [];
      }),
    };
  }

  /** Joined members (join order) as user records. */
  joinedUsers(h: HuddleRecord): UserRecord[] {
    return h.members.flatMap((m) => this.users.get(m.user_id) ?? []);
  }

  /** Confirmed members in join order with `firstId` (the bet creator) first (§2.7 CompileContext). */
  confirmedUsers(h: HuddleRecord, firstId?: string): UserRecord[] {
    const ids = h.members.filter((m) => m.confirmed).map((m) => m.user_id);
    const ordered = firstId && ids.includes(firstId) ? [firstId, ...ids.filter((i) => i !== firstId)] : ids;
    return ordered.flatMap((id) => this.users.get(id) ?? []);
  }

  /**
   * Pay closed set (§8.3): confirmed members of the caller's huddles created
   * within RECENT_HUDDLE_S (caller confirmed there too), excluding the caller.
   * Most recent huddle first, then join order; deduplicated.
   */
  recentCoMembers(userId: string): UserRecord[] {
    const now = this.clock.nowMs();
    const hs = this.huddles
      .filter((h) => now - h.created_at_ms <= RECENT_HUDDLE_S * 1000 && h.members.some((m) => m.user_id === userId && m.confirmed))
      .sort((a, b) => b.created_at_ms - a.created_at_ms);
    const out: UserRecord[] = [];
    const seen = new Set<string>([userId]);
    for (const h of hs) {
      for (const m of h.members) {
        if (!m.confirmed || seen.has(m.user_id)) continue;
        seen.add(m.user_id);
        const u = this.users.get(m.user_id);
        if (u) out.push(u);
      }
    }
    return out;
  }
}
