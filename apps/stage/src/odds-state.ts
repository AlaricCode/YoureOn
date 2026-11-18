// Odds on the projector, the pure half (odds.tsx draws it). A skill bet's odds are its unequal
// stakes (Terms.stakes.a / .b); the two players agree them through offers in the bet's event log
// (odds.offered / odds.answered / odds.agreed, packages/shared/src/odds.ts). The stage folds
// those with the same shared reducer the server's confirm gate and the phones use (oddsReducer
// is foldOdds' step), so the projector never disagrees with a phone about what is open or agreed.
//
// From the fold it derives what the hall sees while the odds are on the table: the offer /
// counter timeline ("Logan asks 3 to 1 → Judge suggests 2 to 1 → Agreed"), the judge's
// suggestion with the performer's record it is grounded in, who still has to tap Accept, and the
// odds chip on the terms card ("Jake gives 2 to 1"). It also words the two odds cues the stage
// says out loud when no phone judge hosts the bet (voice.ts).
import { CATEGORY_LABEL } from '@youre-on/shared/challenge-category';
import { formatUsd } from '@youre-on/shared/money';
import { favoredParty, ratioLabel, RUNG, type OddsRatio } from '@youre-on/shared/odds-math';
import {
  awaitingParties,
  emptyOdds,
  oddsReducer,
  type OddsOffer,
  type OddsState,
  type OddsSuggestion,
  type OfferStatus,
  type PerformerStats,
} from '@youre-on/shared/odds';
import type { PartyKey } from './ticker';

export interface OddsView {
  /** The shared fold of the bet's odds.* events. */
  state: OddsState;
  /** Event ts of the newest odds.* event. */
  last_at: string;
}

export const ODDS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'odds.offered',
  'odds.answered',
  'odds.agreed',
]);

/** Folds one odds.* event into the bet's odds (the ticker's foldEvent hook). */
export function foldOddsEvent(
  prev: OddsView | null,
  e: { type: string; payload: unknown; ts: string },
): OddsView {
  return { state: oddsReducer(prev?.state ?? emptyOdds(), e), last_at: e.ts };
}

type Names = { A: string | null; B: string | null };
const nameIn = (names: Names, p: PartyKey) => names[p] ?? (p === 'A' ? 'Player A' : 'Player B');

/** "2 to 1", "3 to 2", "Even" for a ladder rung. */
export function rungLabel(r: OddsRatio): string {
  const { num, den } = RUNG[r];
  return num === den ? 'Even' : `${num} to ${den}`;
}

/** The ratio words from actual stakes (the display always follows the stakes, not a label). */
export const stakesRatio = (s: { a: string; b: string }): string => {
  try {
    return ratioLabel(s.a, s.b);
  } catch {
    return '';
  }
};

const money = (micro: string) => {
  try {
    return formatUsd(micro);
  } catch {
    return micro;
  }
};

/** "Logan $5 · Jake $10". */
export const stakesLine = (s: { a: string; b: string }, names: Names): string =>
  `${nameIn(names, 'A')} ${money(s.a)} · ${nameIn(names, 'B')} ${money(s.b)}`;

/** The pot: what the winner takes. */
export function potOf(s: { a: string; b: string }): string | null {
  try {
    return (BigInt(s.a) + BigInt(s.b)).toString();
  } catch {
    return null;
  }
}

/**
 * The terms card's odds chip for unequal skill stakes: "Jake gives 2 to 1" (the favourite puts
 * in more). null for even stakes and for Gemini bets (their split is the market's, shown there).
 */
export function oddsChip(
  t: { type: string; market: unknown; stakes: { a: string; b: string } },
  names: Names,
): string | null {
  if (t.type !== 'skill' || t.market) return null;
  let fav: PartyKey | null;
  try {
    fav = favoredParty(t.stakes.a, t.stakes.b);
  } catch {
    return null;
  }
  if (!fav) return null;
  return `${nameIn(names, fav)} gives ${stakesRatio(t.stakes)}`;
}

// ---- the timeline ---------------------------------------------------------------------------

export interface OddsStep {
  offer_id: string;
  /** "Logan asks 3 to 1", "Jake counters 3 to 2", "Judge suggests 2 to 1". */
  text: string;
  /** "Logan $5 · Jake $15". */
  stakes: string;
  status: OfferStatus;
}

/** How an offer reads on the projector (neutral: the stage is nobody's phone). */
export function stepText(o: OddsOffer, names: Names): string {
  const ratio = stakesRatio(o.stakes);
  const words = ratio === 'Even' ? 'even money' : ratio;
  if (o.from === 'judge') return `Judge suggests ${words}`;
  const who = nameIn(names, o.from);
  if (o.parent_id !== null) return `${who} counters ${words}`;
  // the favourite offers odds; the underdog asks for them
  const fav = favoredParty(o.stakes.a, o.stakes.b);
  return `${who} ${fav === null || fav === o.from ? 'offers' : 'asks'} ${words}`;
}

/**
 * The offers in order, newest last, without the ones their own author replaced (a re-offer keeps
 * its parent), at most `max` (the newest). A new offer closes the open one in the fold
 * ('superseded' until its odds.answered says 'countered'), so a counter is told by its parent.
 */
export function oddsSteps(v: OddsView | null, names: Names, max = 4): OddsStep[] {
  if (!v) return [];
  const st = v.state;
  const h = st.history;
  return h
    .filter((o, i) => !h.slice(i + 1).some((x) => x.from === o.from && x.parent_id === o.parent_id))
    .map((o) => ({
      offer_id: o.offer_id,
      text: stepText(o, names),
      stakes: stakesLine(o.stakes, names),
      status: st.status[o.offer_id] ?? 'open',
    }))
    .slice(-max);
}

/** The newest agreement, if it is the last word (nothing newer is open). */
export function lastAgreed(v: OddsView | null): { a: string; b: string; offer_id: string } | null {
  if (!v || v.state.open) return null;
  const last = v.state.agreed[v.state.agreed.length - 1];
  return last ?? null;
}

/**
 * Whether the projector's moment shows the odds (the terms phase only; odds.tsx OddsMoment):
 * an offer is open, or the newest agreement is the card's stakes (just agreed: both now confirm).
 */
export function oddsOnTable(
  v: OddsView | null,
  card: { stakes: { a: string; b: string } } | null,
): boolean {
  if (!v || !v.state.history.length) return false;
  if (v.state.open) return true;
  const ag = lastAgreed(v);
  return !!ag && (!card || (card.stakes.a === ag.a && card.stakes.b === ag.b));
}

// ---- the judge's suggestion -----------------------------------------------------------------

export interface JudgeOdds {
  offer: OddsOffer;
  suggestion: OddsSuggestion;
  status: OfferStatus;
  /** Who still has to tap Accept (open suggestions only). */
  waiting: PartyKey[];
  /** Who countered it, when someone did. */
  countered_by: PartyKey | null;
}

/** The newest judge suggestion in the bet's odds, with where it stands. */
export function judgeOdds(v: OddsView | null): JudgeOdds | null {
  if (!v) return null;
  const st = v.state;
  for (let i = st.history.length - 1; i >= 0; i--) {
    const o = st.history[i]!;
    if (o.from !== 'judge' || !o.suggestion) continue;
    const status = st.status[o.offer_id] ?? 'open';
    const counter = st.history.slice(i + 1).find((x) => x.parent_id === o.offer_id);
    return {
      offer: o,
      suggestion: o.suggestion,
      status,
      waiting: status === 'open' && st.open?.offer_id === o.offer_id ? awaitingParties(st) : [],
      countered_by:
        status !== 'open' && status !== 'agreed' && counter && counter.from !== 'judge'
          ? counter.from
          : null,
    };
  }
  return null;
}

/** "Bottle flips" for the record line. */
export const categoryTitle = (s: Pick<PerformerStats, 'category' | 'category_label'>): string => {
  const plural = CATEGORY_LABEL[s.category]?.[1];
  const t = plural ?? s.category_label;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** "10–2" (made–missed). */
export const recordOf = (r: { made: number; tries: number }): string =>
  `${r.made}–${Math.max(0, r.tries - r.made)}`;

/** "4–7" (wins–losses). */
export const wlOf = (r: { wins: number; losses: number }): string => `${r.wins}–${r.losses}`;

/** The footnote: who worded the reason, and that the numbers are computed. */
export function sourceNote(s: Pick<OddsSuggestion, 'source' | 'model'>): string {
  if (s.source === 'default') return 'Default odds for this kind of bet · no record yet';
  if (s.source === 'model' && s.model)
    return `Numbers computed from the record · reason worded by ${s.model.replace(/^anthropic\//, '')}`;
  return 'Numbers computed from the record';
}

/** "Waiting on Jake", "Waiting on both", "Agreed", "Countered by Jake", "Withdrawn". */
export function judgeStatusLine(j: JudgeOdds, names: Names): string {
  if (j.status === 'agreed') return 'Agreed · both confirm with Face ID';
  if (j.countered_by) return `Countered by ${nameIn(names, j.countered_by)}`;
  if (j.status === 'countered') return 'Countered';
  if (j.status === 'open') {
    if (j.waiting.length === 2) return 'Waiting on both · tap Accept or Counter';
    if (j.waiting.length === 1)
      return `Waiting on ${nameIn(names, j.waiting[0]!)} · tap Accept or Counter`;
    return 'Agreed';
  }
  return j.status === 'withdrawn' ? 'Withdrawn' : 'Replaced';
}

// ---- the stage's voice ----------------------------------------------------------------------

const CUE_EVENT = /^\[EVENT\]\s+(ODDS_[A-Z]+)\b/;

/**
 * The stage's line for an odds cue (voice.ts asks when the shared stageLineFor has none): a
 * spoken judge suggestion ("Jake has landed 10 of his last 12 bottle flips. I'd make it 2 to 1:
 * Logan puts in $5, Jake puts in $10. Both agree?") and the agreement. Only speak:true cues
 * (the server marks the ones nobody else says); null for anything else.
 */
export function oddsCueLine(
  e: { type: string; payload: unknown },
  odds: OddsView | null,
  names: Names,
): string | null {
  if (e.type !== 'judge.cue') return null;
  const p = e.payload as { cue?: unknown; text?: unknown; speak?: unknown } | null;
  if (!p || p.speak !== true || typeof p.cue !== 'string' || typeof p.text !== 'string')
    return null;
  const m = CUE_EVENT.exec(p.text);
  if (!m || m[1] !== p.cue) return null;
  if (p.cue === 'ODDS_OFFERED' || p.cue === 'ODDS_COUNTERED') {
    const open = odds?.state.open ?? null;
    if (!open) return null;
    const ratio = stakesRatio(open.stakes);
    const words = ratio === 'Even' ? 'even money' : ratio;
    const put = `${nameIn(names, 'A')} puts in ${money(open.stakes.a)}, ${nameIn(names, 'B')} puts in ${money(open.stakes.b)}`;
    if (open.from === 'judge' && open.suggestion)
      return `${open.suggestion.reason} I'd make it ${words}: ${put}. Both agree?`;
    if (open.from === 'judge') return `I'd make it ${words}: ${put}. Both agree?`;
    return `${stepText(open, names)}: ${put}. Accept or counter.`;
  }
  if (p.cue === 'ODDS_AGREED') {
    const ag = odds?.state.agreed[odds.state.agreed.length - 1];
    if (!ag) return 'The odds are agreed.';
    const pot = potOf(ag);
    return `Odds agreed: ${nameIn(names, 'A')} ${money(ag.a)}, ${nameIn(names, 'B')} ${money(ag.b)}${pot ? `; winner takes ${money(pot)}` : ''}.`;
  }
  return null;
}
