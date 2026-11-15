/**
 * World Mode market programs (§11.2–§11.4). No LLM; deterministic.
 */
import {
  MARKET_TIME_LIMIT_MAX_S,
  MAX_PARLAY_LEGS,
  MIN_STAKE_UNITS,
  PROB_CLAMP_MAX_BPS,
  PROB_CLAMP_MIN_BPS,
} from '../constants.js';
import type { Leg, LegExpr, MarketPick, MarketQuote, Program, Pubkey } from '../types.js';
import { canonicalize } from './canonicalize.js';
import { compileError, LangError } from './errors.js';
import { validateProgram } from './validate.js';
import { WorldMathError, parlayProb, sideProb, stakeSplit } from '../world/stake.js';

const SECONDS_PER_DAY = 86400;

/** Probability of the proposer's side for one pick: yes → prob_bps, no → 10000 − prob_bps. */
export function pickSideProb(pick: MarketPick): bigint {
  const p = BigInt(pick.prob_bps);
  return pick.side === 'yes' ? p : 10000n - p;
}

function clampBps(p: bigint): bigint {
  const lo = BigInt(PROB_CLAMP_MIN_BPS);
  const hi = BigInt(PROB_CLAMP_MAX_BPS);
  return p < lo ? lo : p > hi ? hi : p;
}

/**
 * Proposer win probability (§11.2/§11.3): `P = p_1; P = floor(P · p_i / 10000)` over the
 * picks' side probabilities, then clamped to `[PROB_CLAMP_MIN_BPS, PROB_CLAMP_MAX_BPS]`.
 */
export function quoteProb(picks: MarketPick[]): bigint {
  // Single implementation of §11.3: the World Mode math module.
  return clampBps(BigInt(parlayProb(picks.map((pk) => sideProb(pk.prob_bps, pk.side)))));
}

/** Stake split (§11.2): proposer = floor(T·p / 10000 / 10_000)·10_000; counterparty = T − proposer. */
export function splitStakes(totalUnits: bigint, pBps: bigint): { proposer: bigint; counterparty: bigint } {
  const proposer = ((totalUnits * pBps) / 10000n / 10000n) * 10000n;
  return { proposer, counterparty: totalUnits - proposer };
}

/** Draft title (§11.4): first event title truncated to 40 chars on a word boundary; parlay adds " +N". */
export function marketTitle(quote: MarketQuote): string {
  const first = quote.picks[0];
  const base = truncateWords(first?.event_title ?? first?.event_id ?? '', 40);
  return quote.picks.length > 1 ? `${base} +${quote.picks.length - 1}` : base;
}

function truncateWords(s: string, max: number): string {
  const t = s.trim();
  const chars = [...t];
  if (chars.length <= max) return t;
  const cut = chars.slice(0, max + 1).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : chars.slice(0, max).join('')).trimEnd();
}

/**
 * `compileMarket(quote, proposer, counterparty, nowMs)` (§11.4). Throws `LangError` for an
 * invalid quote (no picks, too many picks, duplicate contracts, stakes below the minimum,
 * events already closed, ...).
 */
export function compileMarket(quote: MarketQuote, proposer: Pubkey, counterparty: Pubkey, nowMs: number): Program {
  const picks = quote.picks;
  if (!Array.isArray(picks) || picks.length < 1 || picks.length > MAX_PARLAY_LEGS) {
    throw new LangError([compileError('legs', 'LIMIT', `a market bet has 1..${MAX_PARLAY_LEGS} picks`)]);
  }
  const keys = new Set<string>();
  picks.forEach((pk, i) => {
    const key = `${pk.event_id}\u0000${pk.contract_id}`;
    if (keys.has(key)) throw new LangError([compileError(`legs[${i}].market`, 'BAD_KIND', 'parlay picks must be distinct contracts')]);
    keys.add(key);
    if (!Number.isSafeInteger(pk.prob_bps) || pk.prob_bps < 0 || pk.prob_bps > 10000) {
      throw new LangError([compileError(`legs[${i}].market.prob_bps`, 'LIMIT', 'prob_bps must be 0..10000')]);
    }
    if (!Number.isSafeInteger(pk.close_time_ms)) {
      throw new LangError([compileError(`legs[${i}].market`, 'BAD_TIME_LIMIT', 'close_time_ms must be an integer')]);
    }
  });
  if (!Number.isSafeInteger(quote.total_units) || quote.total_units < 0) {
    throw new LangError([compileError('stakes', 'BAD_STAKE', 'total_units must be a non-negative integer')]);
  }
  if (!Number.isSafeInteger(nowMs)) throw new LangError([compileError('time_limit_s', 'BAD_TIME_LIMIT', 'nowMs must be an integer')]);

  // §11.2 split through the World Mode math module (BAD_STAKE outside the stake range).
  let ps: bigint;
  let cs: bigint;
  try {
    const split = stakeSplit(BigInt(quote.total_units), Number(quoteProb(picks)));
    ps = split.proposer_stake;
    cs = split.counterparty_stake;
  } catch (e) {
    if (e instanceof WorldMathError) {
      throw new LangError([compileError('stakes', 'BAD_STAKE', `both stakes must be at least ${MIN_STAKE_UNITS} units (${e.message})`)]);
    }
    throw e;
  }

  // All events must resolve: use the latest close time. ceil((close − now) / 1000) + 1 day, capped.
  const closeMs = Math.max(...picks.map((pk) => pk.close_time_ms));
  const deltaMs = closeMs - nowMs;
  const ceilS = deltaMs >= 0 ? Math.trunc((deltaMs + 999) / 1000) : -Math.trunc(-deltaMs / 1000);
  const time_limit_s = Math.min(MARKET_TIME_LIMIT_MAX_S, ceilS + SECONDS_PER_DAY);

  const legs: Leg[] = picks.map((pk, i) => ({
    id: i + 1,
    actor_bound: false,
    attempt_window_frames: 0,
    market: { venue: 'gemini', event_id: pk.event_id, contract_id: pk.contract_id, side: pk.side, prob_bps: pk.prob_bps },
  }));
  let condition: LegExpr = { op: 'leg', id: 1 };
  for (let i = 2; i <= legs.length; i++) condition = { op: 'and', args: [condition, { op: 'leg', id: i }] };

  const program = canonicalize({
    version: 2,
    kind: 'market',
    participants: [proposer, counterparty],
    sides: [0, 1],
    entities: [],
    legs,
    outcome: { if_true: 0, condition, else: 1 },
    stakes: [Number(ps), Number(cs)],
    time_limit_s,
  });
  const { errors } = validateProgram(program);
  if (errors.length > 0) throw new LangError(errors);
  return program;
}
