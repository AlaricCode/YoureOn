// "Judge, what odds are fair?" (POST /v1/bets/:id/odds/suggest and the voice judge's
// suggest_odds). The judge's odds, grounded in the performer's own record:
//
//   1. the bet as it stands (the card in TERMS_PROPOSED; the typed / spoken claim in DRAFTING)
//   2. the challenge category + the performer's stats (stats.ts: this kind of bet, head-to-head)
//   3. every number in code (odds-math): shrunk rate -> attempts -> chance -> fair ratio -> band
//   4. a model (LLM_PROVIDER=live only; ≤ 3 s) words ONE sentence and picks a rung of the band.
//      Its ratio must be in the band (else the nearest rung) and its reason may only quote numbers
//      from the facts (guardReason, else the template). It never sets stakes: stakesFor() does.
//   5. fallback (spend off, timeout, error, refusal): nearest rung + template reason ('template');
//      no history at all: the category default ('default', "That's my default.")
//   6. the suggestion lands as a judge OFFER (odds.offered from 'judge'): both still Accept and
//      confirm with Face ID. Cached per (bet, card or draft claim, base, stats) for 10 minutes;
//      asking again while that judge offer is open returns it without a new event.
// Spec: docs/planning/API-CONTRACT.md §2.19.
import {
  CATEGORY_BASE_RATE,
  CATEGORY_LABEL,
  classifyChallenge,
} from '@youre-on/shared/challenge-category';
import { MIN_STAKE } from '@youre-on/shared/constants';
import { jcs } from '@youre-on/shared/jcs';
import { parseUsd } from '@youre-on/shared/money';
import type { OddsOffer, OddsSuggestion, PerformerStats } from '@youre-on/shared/odds';
import {
  attemptsRate,
  band,
  clampChance,
  fairOdds,
  MEANINGFUL_SAMPLE,
  nearestRung,
  OddsRatio,
  RUNG,
  shrunkRate,
  stakesFor,
  type AttemptsLike,
} from '@youre-on/shared/odds-math';
import { otherParty, sha256Hex, type Party } from '@youre-on/shared/primitives';
import {
  favoredOf,
  guardReason,
  oddsOutputSchema,
  suggestSay,
  templateReason,
  type OddsFacts,
} from '@youre-on/shared/judge/suggest-odds';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import { lockBet } from '../lock/common';
import { loadEnvelope } from '../lock/terms';
import { maxStakeOf } from '../markets/quote';
import { DEFAULT_CHAT_MODELS, DeadlineError, withDeadline } from '../providers/structured';
import { appendBetEvent } from '../realtime/events';
import type { BetRow } from '../bets/snapshot';
import { judgeCue } from '../bets/cues';
import { assertOddsState, displayNames, foldFromLog, newOffer, publish } from './service';
import { performerStats } from './stats';

export const ODDS_LLM_TIMEOUT_MS = 3_000;
export const DEFAULT_BASE_MICRO = 5_000_000n;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 10 * 60_000;

export interface SuggestInput {
  base_usd?: string | undefined;
  claim?: string | undefined;
  performer?: Party | undefined;
  attempts?: AttemptsLike | undefined;
  /** Who asked (a phone tap); null = the voice judge. */
  requestedBy: Party | null;
  /** 'voice': the judge already says it (cue speak:false); 'button': the host judge says it. */
  via: 'voice' | 'button';
}

export interface SuggestResult {
  offer: OddsOffer;
  say: string;
  /** true when the open judge offer was reused (no new event). */
  cached: boolean;
}

/** In-process cache (one Fly machine): cache_key -> suggestion. */
export class SuggestCache {
  private m = new Map<string, { at: number; s: OddsSuggestion; say: string }>();
  get(k: string, now: number) {
    const hit = this.m.get(k);
    if (!hit) return null;
    if (now - hit.at > CACHE_TTL_MS) {
      this.m.delete(k);
      return null;
    }
    this.m.delete(k);
    this.m.set(k, hit);
    return hit;
  }
  set(k: string, now: number, s: OddsSuggestion, say: string) {
    this.m.delete(k);
    this.m.set(k, { at: now, s, say });
    while (this.m.size > CACHE_MAX) this.m.delete(this.m.keys().next().value!);
  }
}
const defaultCache = new SuggestCache();

/** What the model sees (and the only numbers it may quote). */
function factsOf(
  stats: PerformerStats,
  o: {
    opponent: string;
    chancePct: number;
    basePct: number;
    meaningful: boolean;
    ratio: OddsRatio;
    allowed: OddsRatio[];
    stakes: { a: bigint; b: bigint };
    attempts: number;
  },
): OddsFacts {
  const dollars = [o.stakes.a, o.stakes.b]
    .filter((m) => m % 1_000_000n === 0n)
    .map((m) => Number(m / 1_000_000n));
  return {
    performer_name: stats.performer.display_name,
    opponent_name: o.opponent,
    category_plural: CATEGORY_LABEL[stats.category][1],
    made: stats.in_category.made,
    tries: stats.in_category.tries,
    chance_pct: o.chancePct,
    base_rate_pct: o.basePct,
    sample_meaningful: o.meaningful,
    h2h: { wins: stats.h2h.wins, losses: stats.h2h.losses },
    overall: { wins: stats.overall.wins, losses: stats.overall.losses },
    streak: stats.streak,
    stake_dollars: dollars,
    ratio: RUNG[o.ratio],
    attempts_count: o.attempts,
  };
}

const SYSTEM = `You are the Judge on "You're On", a court for friendly bets. You set fair odds from the performer's record.
Write ONE sentence (at most 120 characters) that quotes the performer's record from FACTS.
- Anchor on in_category (made of tries) when sample_meaningful is true; otherwise say the sample is small and lean on base_rate_pct.
- You may mention the head-to-head (h2h) or the streak.
- Never use a number that is not in FACTS. Never call it real-money history. Plain words, no emoji.
- Pick "ratio" from "allowed" (it is "favourite : underdog"). Prefer "nearest" unless recent form clearly argues for the other one.
Answer with JSON {"ratio": ..., "reason": ...}.`;

export async function suggestOdds(
  deps: AppDeps,
  bet0: BetRow,
  input: SuggestInput,
  o: { timeoutMs?: number; cache?: SuggestCache; requestId?: string } = {},
): Promise<SuggestResult> {
  assertOddsState(bet0, { allowDrafting: true });
  const cache = o.cache ?? defaultCache;
  const maxStake = maxStakeOf(deps);

  // 1. the bet as it stands
  let claim: string;
  let criteria: string[] | null = null;
  let performer: Party;
  let yesParty: Party;
  let attempts: AttemptsLike;
  let termsHash: string | null = null;
  let base: bigint;
  if (bet0.state === 'TERMS_PROPOSED') {
    const latest = await loadEnvelope(deps.db, bet0.id);
    const t = latest?.envelope.terms;
    if (!t || !t.performer)
      throw new HttpError('INVALID_STATE', 'No terms on the card yet.', { reason: 'no_terms' });
    claim = t.claim;
    criteria = t.success_criteria;
    performer = t.performer;
    yesParty = t.yes_party;
    attempts = t.attempts;
    termsHash = latest.envelope.terms_hash;
    const a = BigInt(t.stakes.a);
    const b = BigInt(t.stakes.b);
    base = a < b ? a : b;
  } else {
    const c = input.claim?.trim();
    if (!c) throw new HttpError('VALIDATION_FAILED', "What's the bet?", { fix: 'NO_CLAIM' });
    claim = c;
    performer = input.performer ?? 'B';
    yesParty = performer;
    attempts = input.attempts ?? { count: 1, rule: 'single' };
    base = DEFAULT_BASE_MICRO;
  }
  if (input.base_usd !== undefined && input.base_usd !== '') {
    try {
      base = BigInt(parseUsd(input.base_usd));
    } catch {
      throw new HttpError('VALIDATION_FAILED', 'How much each, in dollars?', { fix: 'AMBIGUOUS' });
    }
  }
  if (base > maxStake) base = maxStake;
  if (base < MIN_STAKE) base = MIN_STAKE;

  // 2. category + stats
  const category = classifyChallenge({ claim, success_criteria: criteria });
  const names = await displayNames(deps.db, bet0);
  const performerId = performer === 'A' ? bet0.party_a_id : bet0.party_b_id;
  const opponentId = performer === 'A' ? bet0.party_b_id : bet0.party_a_id;
  const stats = await performerStats(deps.db, {
    performerId,
    opponentId,
    category,
    performerParty: performer,
    displayName: names[performer],
  });

  // 3. the numbers
  const baseRate = CATEGORY_BASE_RATE[category];
  const p1 = shrunkRate(stats.in_category.made, stats.in_category.tries, baseRate);
  const p = clampChance(attemptsRate(p1, attempts));
  const fair = fairOdds(p);
  const favored = favoredOf(fair.favored, yesParty);
  const candidates = new Map<OddsRatio, { a: bigint; b: bigint }>();
  for (const r of band(fair.r)) {
    const s = stakesFor({ ratio: r, favored, baseMicro: base, maxStake });
    if (!('issue' in s)) candidates.set(r, s);
  }
  if (candidates.size === 0) candidates.set('1:1', { a: base, b: base });
  const allowed = [...candidates.keys()];
  const nearest = candidates.has(nearestRung(fair.r)) ? nearestRung(fair.r) : allowed[0]!;
  const chancePct = Math.min(99, Math.max(1, Math.round(p * 100)));
  const basePct = Math.round(baseRate * 100);
  const meaningful = stats.in_category.tries >= MEANINGFUL_SAMPLE;

  const draftKey = sha256Hex(jcs({ claim, performer, attempts }));
  const cacheKey = sha256Hex(
    jcs({
      bet_id: bet0.id,
      card: termsHash ?? `draft:${draftKey}`,
      base: base.toString(),
      stats: {
        c: stats.category,
        o: stats.overall,
        i: stats.in_category,
        r: stats.recent,
        h: [stats.h2h.wins, stats.h2h.losses, stats.h2h.pushes],
      },
    }),
  );

  const now = deps.now();
  // An identical question while the judge's offer for it is still open: the same answer.
  const openNow = (await foldFromLog(deps.db, bet0.id)).open;
  const hit = cache.get(cacheKey, now);
  if (hit && openNow?.from === 'judge' && openNow.suggestion?.cache_key === cacheKey)
    return { offer: openNow, say: hit.say, cached: true };

  // 4./5. the words (and the rung, within the band)
  let ratio: OddsRatio = nearest;
  let reason: string | null = null;
  let source: OddsSuggestion['source'] = stats.in_category.tries === 0 ? 'default' : 'template';
  let model: string | null = null;
  const facts = (r: OddsRatio) =>
    factsOf(stats, {
      opponent: names[otherParty(performer)],
      chancePct,
      basePct,
      meaningful,
      ratio: r,
      allowed,
      stakes: candidates.get(r)!,
      attempts: attempts.count,
    });
  if (hit) {
    ratio = hit.s.ratio;
    reason = hit.s.reason;
    source = hit.s.source;
    model = hit.s.model;
  } else if (deps.providers.llm.name === 'live' && stats.in_category.tries > 0) {
    const want = deps.env.ODDS_LLM_MODEL ?? DEFAULT_CHAT_MODELS.anthropic;
    const timeoutMs = o.timeoutMs ?? ODDS_LLM_TIMEOUT_MS;
    try {
      const res = await withDeadline(timeoutMs, undefined, (signal) =>
        deps.providers.llm.chat({
          vendor: 'anthropic',
          model: want,
          system: SYSTEM,
          parts: [
            {
              kind: 'text',
              text: `FACTS ${JSON.stringify({ ...facts(nearest), allowed, nearest })}`,
            },
          ],
          output: oddsOutputSchema(allowed),
          effort: 'low',
          ...(want.startsWith('claude-haiku-') ? { thinking: 'disabled' as const } : {}),
          maxOutputTokens: 1024,
          timeoutMs,
          signal,
        }),
      );
      if (res.ok) {
        const parsed = OddsRatio.safeParse(res.value.ratio);
        const r = parsed.success && candidates.has(parsed.data) ? parsed.data : nearest;
        if (
          guardReason(res.value.reason, {
            ...facts(r),
            stake_dollars: [...facts(r).stake_dollars, ...allowedDollars(candidates)],
          })
        ) {
          ratio = r;
          reason = res.value.reason.trim();
          source = 'model';
          model = res.model;
        } else deps.log.info('odds.reason_rejected', { bet_id: bet0.id });
      } else deps.log.warn('odds.llm_failed', { bet_id: bet0.id, status: res.status });
    } catch (e) {
      deps.log.warn('odds.llm_failed', {
        bet_id: bet0.id,
        status: e instanceof DeadlineError ? 'timeout' : 'error',
      });
    }
  }
  if (!reason) reason = templateReason(facts(ratio));
  const stakes = candidates.get(ratio)!;
  const suggestion: OddsSuggestion = {
    ratio,
    favored: stakes.a === stakes.b ? null : favored,
    stakes: { a: stakes.a.toString(), b: stakes.b.toString() },
    chance_pct: chancePct,
    fair_ratio: Math.round(fair.r * 100) / 100,
    allowed,
    base_rate_pct: basePct,
    sample_meaningful: meaningful,
    stats,
    reason: reason.slice(0, 160),
    source,
    model,
    cache_key: cacheKey,
  };
  const say = suggestSay({ reason, ratio, stakes, names: { a: names.A, b: names.B } });
  cache.set(cacheKey, now, suggestion, say);

  // 6. the offer
  const out = await deps.db.transaction(async (tx) => {
    const bet = (await lockBet(tx, bet0.id))!;
    assertOddsState(bet, { allowDrafting: true });
    const fold = await foldFromLog(tx, bet.id);
    if (fold.open?.from === 'judge' && fold.open.suggestion?.cache_key === cacheKey)
      return { bet, offer: fold.open, envs: [], cached: true };
    const { offer, envs } = await newOffer(tx, bet.id, fold, {
      from: 'judge',
      stakes: suggestion.stakes,
      termsHash: bet.state === 'TERMS_PROPOSED' ? bet.terms_hash : null,
      suggestion,
      now,
      actor: input.requestedBy ?? 'A',
    });
    const speak = input.via === 'button';
    envs.push(
      await appendBetEvent(tx, {
        bet_id: bet.id,
        type: 'judge.cue',
        payload: judgeCue(
          'ODDS_OFFERED',
          { name: 'Judge', ratio: offer.ratio_label },
          speak
            ? `Say this word for word: ${say}`
            : 'You suggested these odds. Both tap Accept or Counter on their phones; wait for [EVENT] ODDS_AGREED.',
          speak,
        ),
        now,
      }),
    );
    return { bet, offer, envs, cached: false };
  });
  publish(deps, out.bet, out.envs);
  deps.log.info('odds.suggest', {
    bet_id: bet0.id,
    category,
    ratio,
    chance_pct: chancePct,
    source,
    cached: out.cached,
  });
  return { offer: out.offer, say, cached: out.cached };
}

function allowedDollars(c: Map<OddsRatio, { a: bigint; b: bigint }>): number[] {
  const out: number[] = [];
  for (const s of c.values())
    for (const m of [s.a, s.b]) if (m % 1_000_000n === 0n) out.push(Number(m / 1_000_000n));
  return out;
}
