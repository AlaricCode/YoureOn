// The GG moment and the spoken review request on the projector (pure state; gg-moment.tsx
// draws it).
//
//   bet.gg            the loser's GG (concede) went out: a big "<LOSER>: GG" stamp, the pair's
//                     head-to-head record ticking over, then the payout counting up when it lands
//   review.requested  someone asked the judge to check the ruling again: "REVIEW REQUESTED", a
//                     countdown to confirm_by while the loser's phone asks for tap + Face ID
//   review.closed     the loser kept the ruling (declined), or confirm_by passed (lapsed)
//
// Plus two rules from events the stage already gets: tx.submitted kind 'appeal' (or APPEALED /
// chain.BetAppealed) means the loser confirmed (the review became the appeal, the panel follows),
// and bet.state RULED with prev CONCEDED means the concede was reverted (the GG did not go
// through). Everything here is a pure function of the bet's events and the stage clock, so the
// moment is the same on a reload, in ?preview and in tests.
import type { GgRecord, PairRecord } from '@youre-on/shared/gg';
import type { RealtimeEvent } from '@youre-on/shared/realtime';
import type { Sfx } from './sound';

type Party = 'A' | 'B';

export interface GgView {
  /** The party that said GG (the ruling's loser). */
  by: Party;
  winner: Party;
  /** What the concede pays (micro-USDC), from bet.gg; the payout's own amounts win once paid. */
  to_a: string;
  to_b: string;
  record: GgRecord | null;
  /** The bet.gg event ts (server clock): the moment's t0. */
  at: string;
  seq: number;
  /** bet.state RULED after CONCEDED: the concede failed and was reverted (null = it stands). */
  reverted_at: string | null;
}

export type ReviewStatus = 'open' | 'confirmed' | 'declined' | 'lapsed' | 'gg';

export interface ReviewView {
  review_id: string;
  /** The ruling's loser: the only phone that is asked. */
  for_party: Party;
  source: string;
  requested_at: string;
  /** appeal_deadline − 1 s (unix ms, server clock): after this nobody can confirm. */
  confirm_by_ms: number;
  status: ReviewStatus;
}

/** The two BetView fields this module owns. */
export interface GgSlice {
  gg: GgView | null;
  review: ReviewView | null;
}

/** The winner's number rolls this long after the stamp lands. */
export const GG_RECORD_TICK_MS = 700;
/** The moment holds this long after the payout appears. */
export const GG_HOLD_AFTER_PAID_MS = 6_000;
/** …and is never up longer than this without a payout (a slow chain falls back to PAID). */
export const GG_MAX_MS = 12_000;
/** A reverted GG stays up this long with "GG didn't go through". */
export const GG_REVERT_MS = 3_000;
/** The payout's count-up. */
export const COUNT_UP_MS = 1_200;
/** The stage drops a stage.cue cheer this soon after playing its own (the agent may cue one). */
export const CHEER_DEDUPE_MS = 4_000;
/** A bet.gg older than this (by the stage clock) is a replay: no gavel. */
export const GG_SOUND_FRESH_MS = 15_000;

const isParty = (p: unknown): p is Party => p === 'A' || p === 'B';

/** Folds the GG / review events (and the two rules above) into the bet's slice. */
export function foldGg<T extends GgSlice>(v: T, e: RealtimeEvent): T {
  switch (e.type) {
    case 'bet.gg': {
      const p = e.payload;
      const gg: GgView = {
        by: p.by,
        winner: p.winner,
        to_a: p.to_a,
        to_b: p.to_b,
        record: p.record,
        at: e.ts,
        seq: e.seq,
        reverted_at: null,
      };
      return { ...v, gg, review: closeOpen(v.review, 'gg') };
    }
    case 'review.requested': {
      const p = e.payload;
      if (v.review?.review_id === p.review_id) return v;
      const at = Date.parse(p.confirm_by);
      if (!isParty(p.for_party) || !Number.isFinite(at)) return v;
      return {
        ...v,
        review: {
          review_id: p.review_id,
          for_party: p.for_party,
          source: p.source,
          requested_at: p.requested_at,
          confirm_by_ms: at,
          status: 'open',
        },
      };
    }
    case 'review.closed': {
      const r = v.review;
      if (!r || r.review_id !== e.payload.review_id || r.status !== 'open') return v;
      return { ...v, review: { ...r, status: e.payload.reason } };
    }
    case 'tx.submitted':
    case 'tx.confirmed':
      return e.payload.kind === 'appeal' ? { ...v, review: closeOpen(v.review, 'confirmed') } : v;
    case 'chain.BetAppealed':
      return { ...v, review: closeOpen(v.review, 'confirmed') };
    case 'bet.state': {
      const p = e.payload;
      if (p.state === 'APPEALED') return { ...v, review: closeOpen(v.review, 'confirmed') };
      if (p.state === 'RULED' && p.prev === 'CONCEDED' && v.gg && !v.gg.reverted_at)
        return {
          ...v,
          gg: { ...v.gg, reverted_at: e.ts },
          // the GG did not go through: a review the GG closed is open again (until confirm_by)
          review: v.review?.status === 'gg' ? { ...v.review, status: 'open' } : v.review,
        };
      return v;
    }
    default:
      return v;
  }
}

const closeOpen = (r: ReviewView | null, status: ReviewStatus): ReviewView | null =>
  r && r.status === 'open' ? { ...r, status } : r;

/** A GG that stands (not reverted). */
export const liveGg = (b: GgSlice): GgView | null => (b.gg && !b.gg.reverted_at ? b.gg : null);

// ---- the moment's clock ---------------------------------------------------------------------

/** Ease-out (cubic): fast, then settles. */
export const easeOut = (x: number): number => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);

/** Whole cents (micro-USDC): the count-up steps through these, never "$9.99998". */
const CENT = 10_000n;

/**
 * A micro-USDC amount counting from `from` to `to` over `ms` from `t0` (ease-out), as a decimal
 * string in whole cents on the way. Before t0 it is `from`, from t0 + ms exactly `to`.
 */
export function countUpMicro(
  from: string | bigint,
  to: string | bigint,
  t0: number,
  now: number,
  ms = COUNT_UP_MS,
): string {
  const a = BigInt(from);
  const b = BigInt(to);
  if (now <= t0) return a.toString();
  if (now >= t0 + ms) return b.toString();
  const k = BigInt(Math.round(easeOut((now - t0) / ms) * 1_000_000));
  const v = a + ((b - a) * k) / 1_000_000n;
  return ((v / CENT) * CENT).toString();
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** The payout this GG moment shows: it landed no later than GG_MAX_MS after the GG. */
export function ggPaidAt(b: GgSlice & { paid_at: string | null }): number | null {
  const g = liveGg(b);
  const t0 = g ? ms(g.at) : null;
  const paid = ms(b.paid_at);
  return t0 !== null && paid !== null && paid <= t0 + GG_MAX_MS ? paid : null;
}

/** When the GG moment comes down (stage clock), or null when the bet has none. */
export function ggMomentEnd(b: GgSlice & { paid_at: string | null }): number | null {
  if (!b.gg) return null;
  const t0 = ms(b.gg.at);
  if (t0 === null) return null;
  const rev = ms(b.gg.reverted_at);
  if (rev !== null) return Math.min(rev, t0 + GG_MAX_MS) + GG_REVERT_MS;
  const paid = ggPaidAt(b);
  return paid !== null ? paid + GG_HOLD_AFTER_PAID_MS : t0 + GG_MAX_MS;
}

/**
 * Is the GG moment up? From the GG (a little before, for clock skew) until ggMomentEnd. A replayed
 * GG (cold start, reconnect) is long past its end, so it never shows.
 */
export function ggMomentOn(b: (GgSlice & { paid_at: string | null }) | null, now: number): boolean {
  if (!b?.gg) return false;
  const t0 = ms(b.gg.at);
  const end = ggMomentEnd(b);
  return t0 !== null && end !== null && now >= t0 - 2_000 && now < end;
}

/** The GG moment covers this payout: the PAID overlay stays down (one moment, not two). */
export const ggCoversPayout = (b: (GgSlice & { paid_at: string | null }) | null): boolean =>
  !!b && ggPaidAt(b) !== null;

/** Where the moment is at `now`. */
export interface GgFrame {
  /** The winner's number has rolled over (t0 + GG_RECORD_TICK_MS). */
  ticked: boolean;
  /** The record to show (before until it ticks, then after); null when the server sent none. */
  record: PairRecord | null;
  /** The payout has landed (and the count-up is running / done). */
  paid: boolean;
  /** The winner's +amount, counting up from 0 once paid (micro-USDC string). */
  shown: { A: string; B: string };
  /** The concede was reverted. */
  reverted: boolean;
}

export function ggFrame(
  b: GgSlice & {
    paid_at: string | null;
    payout: { to_a: string; to_b: string } | null;
  },
  now: number,
): GgFrame | null {
  const g = b.gg;
  if (!g) return null;
  const t0 = ms(g.at) ?? now;
  const ticked = now >= t0 + GG_RECORD_TICK_MS;
  const paidAt = ggPaidAt(b);
  const final = b.payout ?? { to_a: g.to_a, to_b: g.to_b };
  return {
    ticked,
    record: g.record ? (ticked ? g.record.after : g.record.before) : null,
    paid: paidAt !== null,
    shown: {
      A: paidAt !== null ? countUpMicro(0n, final.to_a, paidAt, now) : '0',
      B: paidAt !== null ? countUpMicro(0n, final.to_b, paidAt, now) : '0',
    },
    reverted: g.reverted_at !== null,
  };
}

// ---- labels ---------------------------------------------------------------------------------

/** The PAID panel's headline word for how the money moved (the chain event stays small). */
export function payoutLabel(event: string): string {
  switch (event) {
    case 'BetConceded':
      return 'GG';
    case 'BetFinalized':
      return 'Ruling stands';
    case 'AppealResolved':
      return 'After appeal';
    case 'BetRefunded':
    case 'Refund':
      return 'Refunded';
    case 'BetCancelled':
      return 'Cancelled';
    default:
      return 'Paid';
  }
}

/** "4-7" and the chips under it. */
export function recordChips(
  r: PairRecord,
  names: Record<Party, string>,
): Array<{ kind: 'streak' | 'rival'; text: string }> {
  const out: Array<{ kind: 'streak' | 'rival'; text: string }> = [];
  if (r.streak && r.streak.length >= 2)
    out.push({ kind: 'streak', text: `${names[r.streak.party]} ×${r.streak.length}` });
  if (r.rival) out.push({ kind: 'rival', text: 'RIVALS' });
  return out;
}

/** Seconds left to confirm, ceil'd (the banner's countdown); 0 once confirm_by has passed. */
export const reviewSecondsLeft = (r: ReviewView, now: number): number =>
  Math.max(0, Math.ceil((r.confirm_by_ms - now) / 1000));

/**
 * What the review banner shows: the server's status, except an open review whose confirm_by has
 * passed reads as lapsed (the server's lapse timer may have been lost to a restart), and the GG
 * hides it.
 */
export function reviewShown(r: ReviewView | null, now: number): ReviewStatus | null {
  if (!r || r.status === 'gg') return null;
  if (r.status === 'open' && now >= r.confirm_by_ms) return 'lapsed';
  return r.status;
}

/**
 * The banner takes the appeal bar's place in the ruling while it has something to say: until the
 * payout, and once confirmed only until the appeal lands (then the three-model panel takes over).
 */
export function reviewBannerOn(
  b: GgSlice & { payout: unknown; appealed: boolean; votes: readonly unknown[] },
  now: number,
): boolean {
  const st = reviewShown(b.review, now);
  if (!st || b.payout) return false;
  return st !== 'confirmed' || (!b.appealed && b.votes.length === 0);
}

// ---- sound ----------------------------------------------------------------------------------

/**
 * The gavel for a fresh bet.gg of `betId` (`seen` is updated; an old one is marked seen, silent).
 * The cheer is the payout's own sound (sound.ts freshSounds 'paid' plays the cheer clip).
 */
export function freshGgSounds(
  s: { history: Record<string, readonly RealtimeEvent[]> },
  betId: string,
  seen: Set<string>,
  nowMs: number,
): Sfx[] {
  const out: Sfx[] = [];
  for (const e of s.history[betId] ?? []) {
    if (e.type !== 'bet.gg') continue;
    const key = `${betId}:gg:${e.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const age = nowMs - Date.parse(e.ts);
    if (Number.isFinite(age) && Math.abs(age) <= GG_SOUND_FRESH_MS) out.push('gavel');
  }
  return out;
}

/** Plays the cheer for a stage.cue unless the stage played its own within CHEER_DEDUPE_MS. */
export const cueSoundAllowed = (kind: string, lastOwnCheerMs: number | null, nowMs: number) =>
  !(kind === 'cheer' && lastOwnCheerMs !== null && nowMs - lastOwnCheerMs < CHEER_DEDUPE_MS);

/** The sounds sound.ts plays with the cheer clip. */
export const isCheer = (s: Sfx) => s === 'paid' || s === 'cheer';
