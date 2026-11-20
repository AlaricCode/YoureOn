// What a party screen shows about a bet, derived only from the binding Terms (SCHEMAS §2) and
// this phone's party. The terms card is rendered from `terms` alone (API-CONTRACT §6.3 G2), so
// every string here comes from a Terms field, never from the server's presentation block.
// Pure TS: tested in node.
import {
  PANEL_SEATS,
  type AppealResult,
  type AppealVote,
  type PanelProvider,
} from '@youre-on/shared/appeal';
import { routineDisplayTitle } from '@youre-on/shared/dance/routine';
import { danceRoundSeconds, parseDanceTermsRoutine } from '@youre-on/shared/dance/terms';
import { formatUsd, type MicroUsdc } from '@youre-on/shared/money';
import { ratioLabel, toWinLine } from '@youre-on/shared/odds-math';
import { formatPrice } from '@youre-on/shared/settlement';
import { otherParty, type Party } from '@youre-on/shared/primitives';
import type { RulingOutcome } from '@youre-on/shared/ruling';
import { termsCode, type Terms } from '@youre-on/shared/terms';

import { signedMicroToUsd } from '../ui/money';

export interface EdgeCaseView {
  question: string;
  answer: string;
}

export interface BetView {
  me: Party;
  myName: string;
  theirName: string;
  /** Who performs (skill bets); null for market bets and dance offs (both dance). */
  performerName: string | null;
  claim: string;
  /** Terms.type as the screens branch on it: skill, the Gemini market, or a Dance Off. */
  kind: BetKind;
  success: readonly string[];
  failure: readonly string[];
  edgeCases: readonly EdgeCaseView[];
  /** "Camera", "Market" or "Pose score" (a dance off). */
  evidence: string;
  myStake: MicroUsdc;
  theirStake: MicroUsdc;
  myStakeUsd: string;
  theirStakeUsd: string;
  potUsd: string;
  /** "62/38" for a market bet (my share first), "3 to 1" for a skill bet at odds, else null. */
  odds: string | null;
  /** Skill bets at odds (unequal stakes): "3 to 1", else null. */
  ratio: string | null;
  /** Skill bets at odds: "You put in $5 to win $20", else null. */
  toWin: string | null;
  /** Market bets: this phone's side ("Up" = Bitcoin at or above the line), else null. */
  mySide: 'Up' | 'Down' | null;
  /** Market bets: the line bound into the terms ("$64,389.60"), else null. */
  lineUsd: string | null;
  deadline: string;
  termsCode: string;
  /** Attempts line: "1 try", "Best of 3"; a dance off's round: the routine's "15 seconds". */
  attempts: string;
  /** Dance offs: the bound routine's title ("Wave Pop"), verified against the bundled one. */
  routineTitle: string | null;
}

export type BetKind = 'skill' | 'market' | 'dance';

export const kindOf = (t: Pick<Terms, 'type'>): BetKind =>
  t.type === 'skill' ? 'skill' : t.type === 'dance_off' ? 'dance' : 'market';

const EVIDENCE: Readonly<Record<BetKind, string>> = {
  skill: 'Camera',
  market: 'Market',
  dance: 'Pose score',
};

const ATTEMPTS: Record<Terms['attempts']['rule'], (n: number) => string> = {
  single: () => '1 try',
  first_success: (n) => `${n} tries`,
  best_of: (n) => `Best of ${n}`,
  all_of: (n) => `All ${n}`,
};

export function betView(terms: Terms, termsHash: string, me: Party): BetView {
  const them = otherParty(me);
  const party = (p: Party) => (p === 'A' ? terms.party_a : terms.party_b);
  const stake = (p: Party): MicroUsdc => (p === 'A' ? terms.stakes.a : terms.stakes.b);
  const pot = BigInt(terms.stakes.a) + BigInt(terms.stakes.b);
  const mine = BigInt(stake(me));
  const myPct = Number((mine * 100n + pot / 2n) / pot);
  const atOdds = terms.type === 'skill' && terms.stakes.a !== terms.stakes.b;
  const ratio = atOdds ? ratioLabel(mine, BigInt(stake(them))) : null;
  const kind = kindOf(terms);
  // A dance off's routine line ("Routine wave-pop v1 sha256:…") reads as the routine's title,
  // only when it is the bundled routine the scorer uses (id, version and hash all match).
  const routine = kind === 'dance' ? parseDanceTermsRoutine(terms) : null;
  const routineTitle = routine?.ok ? routineDisplayTitle(routine.routine) : null;
  // The round length is the routine's own (15 s, 32.6 s → "33 seconds", ...).
  const seconds = kind === 'dance' ? danceRoundSeconds(terms) : null;
  const roundLine = seconds === null ? 'One round' : `${seconds} seconds`;
  const success = routineTitle
    ? [`${routineTitle}, ${roundLine}`, ...terms.success_criteria.slice(1)]
    : terms.success_criteria;
  return {
    me,
    myName: party(me).display_name,
    theirName: party(them).display_name,
    performerName: terms.performer ? party(terms.performer).display_name : null,
    claim: terms.claim,
    kind,
    success,
    failure: terms.failure_criteria,
    edgeCases: terms.edge_cases.map(({ question, answer }) => ({ question, answer })),
    evidence: EVIDENCE[kind],
    myStake: stake(me),
    theirStake: stake(them),
    myStakeUsd: formatUsd(stake(me)),
    theirStakeUsd: formatUsd(stake(them)),
    potUsd: formatUsd(pot.toString()),
    odds: terms.type === 'real_world' ? `${myPct}/${100 - myPct}` : ratio,
    ratio,
    toWin: atOdds ? toWinLine(mine, pot) : null,
    mySide: terms.market ? ((terms.market.side === 'YES') === (me === 'A') ? 'Up' : 'Down') : null,
    lineUsd: terms.market?.strike.value ? formatPrice(terms.market.strike.value) : null,
    deadline: terms.deadline,
    termsCode: termsCode(termsHash),
    attempts: kind === 'dance' ? roundLine : ATTEMPTS[terms.attempts.rule](terms.attempts.count),
    routineTitle,
  };
}

/** "3:42 PM" in the phone's time zone (`offsetMin` = -Date#getTimezoneOffset()). */
export function clockLabel(iso: string, offsetMin = -new Date().getTimezoneOffset()): string {
  const d = new Date(Date.parse(iso) + offsetMin * 60_000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes().toString().padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "4:59", "0:09", "0:00": a countdown never goes negative. */
export function countdownLabel(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export type MyResult = 'won' | 'lost' | 'redo' | 'void';

/** How a ruling reads on this phone. */
export function myResult(outcome: RulingOutcome, me: Party): MyResult {
  if (outcome === 'REDO') return 'redo';
  if (outcome === 'VOID') return 'void';
  return (outcome === 'A_WINS') === (me === 'A') ? 'won' : 'lost';
}

/**
 * This phone's result on the ruling and payout screens, from the outcome that pays
 * (store finalOutcome). A VOID outcome is a refund in every state (RULED, FINALIZED, VOIDED),
 * and so is a VOIDED bet whatever its ruling said; no outcome yet reads as no contest.
 */
export function screenResult(
  outcome: RulingOutcome | null,
  state: string | null,
  me: Party | null,
): MyResult {
  if (!outcome || !me || outcome === 'VOID' || state === 'VOIDED') return 'void';
  return myResult(outcome, me);
}

export const RESULT_TITLE: Readonly<Record<MyResult, string>> = {
  won: 'You won',
  lost: 'You lost',
  redo: 'Run it back',
  void: 'No contest',
};

/**
 * The loser may appeal a camera ruling until `appeal_deadline − 1 s` (ESCROW §8.3); market
 * bets never show "I appeal!" (SCHEMAS §7), nor do dance offs (the score is deterministic,
 * DANCE-OFF §5).
 */
export function canAppeal(
  view: Pick<BetView, 'kind'>,
  result: MyResult,
  appealDeadlineMs: number,
  nowMs: number,
): boolean {
  return view.kind === 'skill' && result === 'lost' && nowMs < appealDeadlineMs - 1000;
}

/** One panel seat on the appeal screen (PlayScreens AppealScreen). */
export interface AppealSeatView {
  name: string;
  vote: 'voting' | 'upholds' | 'overturns' | 'abstains';
  reason: string | null;
}

/** Seat k = PANEL_SEATS[k] (API-CONTRACT §7.2); named by provider, never by model id. */
const PANEL_NAMES: Readonly<Record<PanelProvider, string>> = {
  anthropic: 'Claude',
  openai: 'GPT',
  google: 'Google',
};

/**
 * The three seats as they stand: "voting" until a seat's appeal.vote arrives, then whether its
 * counted vote upholds the appealed outcome, overturns it, or abstains (SCHEMAS §7 countVote).
 */
export function appealSeats(
  votes: readonly Pick<AppealVote, 'seat' | 'provider' | 'counted_as' | 'reason'>[],
  original: RulingOutcome | null,
): AppealSeatView[] {
  return PANEL_SEATS.map((provider, seat) => {
    const v = votes.find((x) => x.seat === seat);
    const name = PANEL_NAMES[v?.provider ?? provider];
    if (!v) return { name, vote: 'voting', reason: null };
    const vote =
      v.counted_as === 'ABSTAIN' ? 'abstains' : v.counted_as === original ? 'upholds' : 'overturns';
    return { name, vote, reason: v.reason || null };
  });
}

/** The panel's verdict on the appeal screen: null while it votes. */
export const appealVerdict = (
  r: Pick<AppealResult, 'flipped'> | null,
): 'stands' | 'flipped' | null => (r ? (r.flipped ? 'flipped' : 'stands') : null);

/** GG is the loser's concede, for decisive outcomes only (CONCEDE_NOT_ALLOWED otherwise). */
export const canConcede = (result: MyResult, appealDeadlineMs: number, nowMs: number): boolean =>
  result === 'lost' && nowMs < appealDeadlineMs + 1000;

/**
 * The ruling screen's footer: GG for the loser while the window is open; once the bet is over (a
 * VOID refunded, or any other terminal state) "Back home" with Double or nothing, never a GG or a
 * "Waiting" that no event will ever end; else "Waiting" for the loser or the settlement.
 */
export type RulingFooter = 'gg' | 'home' | 'waiting';
export const rulingFooter = (result: MyResult, over: boolean): RulingFooter =>
  over ? 'home' : result === 'lost' ? 'gg' : 'waiting';

/** "+$5.00", "−$7.00", "$0.00" from a signed micro-USDC string (ui/money: one result format). */
export function signedUsd(signedMicro: string): string {
  return signedMicroToUsd(signedMicro);
}
