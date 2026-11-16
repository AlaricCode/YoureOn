// What a party screen shows about a bet, derived only from the binding Terms (SCHEMAS §2) and
// this phone's party. The terms card is rendered from `terms` alone (API-CONTRACT §6.3 G2), so
// every string here comes from a Terms field, never from the server's presentation block.
// Pure TS: tested in node.
import { formatUsd, type MicroUsdc } from '@youre-on/shared/money';
import { otherParty, type Party } from '@youre-on/shared/primitives';
import type { RulingOutcome } from '@youre-on/shared/ruling';
import { termsCode, type Terms } from '@youre-on/shared/terms';

export interface EdgeCaseView {
  question: string;
  answer: string;
}

export interface BetView {
  me: Party;
  myName: string;
  theirName: string;
  /** Who performs (skill bets); null for market bets. */
  performerName: string | null;
  claim: string;
  kind: 'skill' | 'market';
  success: readonly string[];
  failure: readonly string[];
  edgeCases: readonly EdgeCaseView[];
  /** "Camera" or "Gemini market". */
  evidence: string;
  myStake: MicroUsdc;
  theirStake: MicroUsdc;
  myStakeUsd: string;
  theirStakeUsd: string;
  potUsd: string;
  /** "62/38" for a market bet (my share first), null otherwise. */
  odds: string | null;
  deadline: string;
  termsCode: string;
  /** Attempts line: "1 try", "Best of 3". */
  attempts: string;
}

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
  return {
    me,
    myName: party(me).display_name,
    theirName: party(them).display_name,
    performerName: terms.performer ? party(terms.performer).display_name : null,
    claim: terms.claim,
    kind: terms.type === 'skill' ? 'skill' : 'market',
    success: terms.success_criteria,
    failure: terms.failure_criteria,
    edgeCases: terms.edge_cases.map(({ question, answer }) => ({ question, answer })),
    evidence: terms.evidence_source === 'camera' ? 'Camera' : 'Gemini market',
    myStake: stake(me),
    theirStake: stake(them),
    myStakeUsd: formatUsd(stake(me)),
    theirStakeUsd: formatUsd(stake(them)),
    potUsd: formatUsd(pot.toString()),
    odds: terms.type === 'real_world' ? `${myPct}/${100 - myPct}` : null,
    deadline: terms.deadline,
    termsCode: termsCode(termsHash),
    attempts: ATTEMPTS[terms.attempts.rule](terms.attempts.count),
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

export const RESULT_TITLE: Readonly<Record<MyResult, string>> = {
  won: 'You won',
  lost: 'You lost',
  redo: 'Run it back',
  void: 'No contest',
};

/**
 * The loser may appeal a camera ruling until `appeal_deadline − 1 s` (ESCROW §8.3); market
 * bets never show "I appeal!" (SCHEMAS §7).
 */
export function canAppeal(
  view: Pick<BetView, 'kind'>,
  result: MyResult,
  appealDeadlineMs: number,
  nowMs: number,
): boolean {
  return view.kind === 'skill' && result === 'lost' && nowMs < appealDeadlineMs - 1000;
}

/** GG is the loser's concede, for decisive outcomes only (CONCEDE_NOT_ALLOWED otherwise). */
export const canConcede = (result: MyResult, appealDeadlineMs: number, nowMs: number): boolean =>
  result === 'lost' && nowMs < appealDeadlineMs + 1000;

/** "+$5", "−$7.00", "$0" from a signed micro-USDC string (head-to-head net). */
export function signedUsd(signedMicro: string): string {
  const neg = signedMicro.startsWith('-');
  const abs = neg ? signedMicro.slice(1) : signedMicro;
  if (/^0+$/.test(abs)) return '$0';
  const n = BigInt(abs);
  const cents = (n % 1_000_000n) / 10_000n;
  const usd = `$${n / 1_000_000n}.${cents.toString().padStart(2, '0')}`;
  return `${neg ? '−' : '+'}${usd}`;
}
