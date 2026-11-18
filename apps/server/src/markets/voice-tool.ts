// The voice judge's `get_market_odds` webhook tool (API-CONTRACT §4.3; Beat 6):
//
//   POST /el/tools/get_market_odds   secret header (X-YO-Tool-Secret), like propose_terms
//     body: ids + {asset: 'BTC', horizon: '5m', a_side: 'YES'|'NO', amount_usd: '5'}
//     -> 200 {ok: true, odds: "61/39", a: "$6.10", b: "$3.90", line: "$64,389.60",
//             ends: "02:40 UTC", ends_in_s: 170, lock_within_s: 50}
//     -> 200 {ok: false, fix: <FairRefusal | AMBIGUOUS | MARKET_NOT_OPEN>, say: "..."}
//     -> 401 {ok: false, fix: 'UNAUTHORIZED'} for a bad secret (the only non-200)
//   It reads the relay snapshot and runs fairStakes: a PREVIEW. propose_terms takes the binding
//   quote. The odds are public market data, so there is no conversation -> bet binding check;
//   the tool is rate-limited per conversation like the others (§1.7). Replies stay < 300 B.
//
// Registered by markets/bet-routes.ts. The ElevenLabs agent calls it once 'get_market_odds' is
// in packages/shared/src/judge/el-config.ts DEFAULT_WEBHOOK_TOOLS and the agent is re-synced
// (the persona already describes it when it is registered).
import type { Context } from 'hono';
import { z } from 'zod/v4';
import { FAIR, type FairRefusal } from '@youre-on/shared/gemini';
import { expiryLabel, oddsDisplay } from '@youre-on/shared/judge/market-terms';
import {
  fitReply,
  spokenUsd,
  type ProposeEvaluation,
  type ToolReply,
} from '@youre-on/shared/judge/reply';
import { formatUsd, parseUsd } from '@youre-on/shared/money';
import { formatPrice } from '@youre-on/shared/settlement';
import type { AppDeps, AppEnv } from '../context';
import { HttpError } from '../errors';
import { TOOL_SECRET_HEADER, toolSecretOk } from '../voice/tool-auth';
import { maxStakeOf } from './quote';
import { safeFairStakes } from './service';

/**
 * = voice/tools.ts EL_TOOLS_BUCKET (§1.7: 30/min per conversation, the same 'el/tools' bucket).
 * Not imported: voice/tools.ts imports this module (realWorldReply).
 */
const EL_TOOLS_BUCKET = { limit: 30, windowMs: 60_000 } as const;

export const GetMarketOddsArgs = z.object({
  conversation_id: z.string().max(128).optional(),
  bet_id: z.string().max(64).optional(),
  asset: z.literal('BTC').optional(),
  horizon: z.literal('5m').optional(),
  a_side: z.enum(['YES', 'NO']),
  amount_usd: z.string().max(16),
});

/** What the judge says when Gemini can't price it (≤ 200 chars, spoken as is). */
export function refusalSay(reason: FairRefusal | 'AMBIGUOUS', o: { next?: string | null } = {}) {
  switch (reason) {
    case 'MARKET_NOT_OPEN':
      return 'No Bitcoin market is open right now. Make it a skill bet.';
    case 'QUOTE_STALE':
      return "Gemini's quote is a beat old. Ask me again.";
    case 'TOO_CLOSE_TO_EXPIRY':
      return o.next
        ? `Too late for this round. The next one opens at ${expiryLabel(o.next)}.`
        : 'Too late for this round. The next one opens soon.';
    case 'STRIKE_PENDING':
      return "Gemini hasn't set the line yet. Five seconds.";
    case 'NO_TWO_SIDED_QUOTE':
      return 'Gemini has no odds on this round yet. Give it a few seconds.';
    case 'SPREAD_TOO_WIDE':
      return "Gemini's spread is too wide to price fairly. Try the next round.";
    case 'PRICE_OUT_OF_RANGE':
      return 'That market is too lopsided for a fair bet. Try the next round.';
    case 'STAKE_ABOVE_MAX':
      return 'That stake is over the limit at these odds. Go smaller.';
    case 'STAKE_BELOW_MIN':
      return 'That stake is under the minimum. Go bigger.';
    case 'AMBIGUOUS':
      return 'How much each, in dollars?';
  }
}

const reply = (c: Context<AppEnv>, body: ToolReply) => c.json(fitReply(body), 200);

/**
 * propose_terms for a real_world bet (voice/tools.ts): the judge says Gemini's split right away
 * instead of "Gemini sets the odds", from the relay's in-memory snapshot (no REST on the webhook
 * path, §4.2). A refusal is answered now, spoken; a stale snapshot keeps the template reply (the
 * sink refetches when it takes the binding quote). Anything else passes through unchanged.
 */
export function realWorldReply(
  deps: Pick<AppDeps, 'now' | 'env'> & Partial<Pick<AppDeps, 'markets'>>,
  ev: ProposeEvaluation,
  r: ToolReply,
): ToolReply {
  if (!r.ok || ev.kind !== 'proposal' || ev.proposal.type !== 'real_world') return r;
  const snap = deps.markets?.snapshot;
  const side = ev.proposal.market_query?.a_side;
  if (!deps.markets || !snap || !side) return r;
  const now = deps.now();
  const q = safeFairStakes(snap, ev.proposal.amount, side, now);
  if (!q.ok && q.reason === 'QUOTE_STALE') return r;
  const max = maxStakeOf(deps);
  const reason: FairRefusal | null = !q.ok
    ? q.reason
    : BigInt(q.stakes.a) > max || BigInt(q.stakes.b) > max
      ? 'STAKE_ABOVE_MAX'
      : null;
  if (reason !== null || !q.ok)
    return fitReply({
      ok: false,
      fix: reason ?? 'MARKET_NOT_OPEN',
      say: refusalSay(reason ?? 'MARKET_NOT_OPEN', {
        next: deps.markets.current(now).next_window_start,
      }),
    });
  const claim = /[.!?]$/.test(ev.proposal.claim) ? ev.proposal.claim : `${ev.proposal.claim}.`;
  return fitReply({
    ...r,
    say: `${claim} Gemini prices it ${oddsDisplay(q.stakes.a, q.stakes.b)}: ${spokenUsd(q.stakes.a)} against ${spokenUsd(q.stakes.b)}.`,
  });
}

export async function getMarketOddsHandler(c: Context<AppEnv>) {
  const deps = c.get('deps');
  if (!toolSecretOk(c.req.header(TOOL_SECRET_HEADER), [deps.env.ELEVENLABS_TOOL_SECRET]))
    return c.json({ ok: false, fix: 'UNAUTHORIZED' }, 401);
  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    return reply(c, { ok: false, fix: 'INVALID', say: 'Run that by me again.' });
  }
  const args = GetMarketOddsArgs.safeParse(raw);
  if (!args.success) return reply(c, { ok: false, fix: 'INVALID', say: 'Run that by me again.' });
  const conv = args.data.conversation_id ?? 'unknown';
  try {
    deps.rateLimit?.take('el/tools', conv, EL_TOOLS_BUCKET);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'RATE_LIMITED')
      return reply(c, { ok: false, fix: 'SLOW_DOWN', say: 'One at a time. Say that again.' });
    throw e;
  }
  let amount: string;
  try {
    amount = parseUsd(args.data.amount_usd);
  } catch {
    return reply(c, { ok: false, fix: 'AMBIGUOUS', say: refusalSay('AMBIGUOUS') });
  }
  const markets = deps.markets;
  if (!markets)
    return reply(c, { ok: false, fix: 'MARKET_NOT_OPEN', say: refusalSay('MARKET_NOT_OPEN') });
  const { result, snapshot } = await markets.quote(amount, args.data.a_side);
  const now = deps.now();
  const max = maxStakeOf(deps);
  const reason: FairRefusal | null = !result.ok
    ? result.reason
    : BigInt(result.stakes.a) > max || BigInt(result.stakes.b) > max
      ? 'STAKE_ABOVE_MAX'
      : null;
  deps.log.info('el_tool.call', {
    tool: 'get_market_odds',
    conversation_id: conv,
    ok: reason === null,
    fix: reason,
  });
  if (reason !== null || !result.ok || !snapshot)
    return reply(c, {
      ok: false,
      fix: reason ?? 'MARKET_NOT_OPEN',
      say: refusalSay(reason ?? 'MARKET_NOT_OPEN', {
        next: markets.current(now).next_window_start,
      }),
    });
  const expiryMs = Date.parse(snapshot.expiry);
  return reply(c, {
    ok: true,
    odds: oddsDisplay(result.stakes.a, result.stakes.b),
    a: formatUsd(result.stakes.a),
    b: formatUsd(result.stakes.b),
    line: snapshot.strike.value === null ? '-' : formatPrice(snapshot.strike.value),
    ends: expiryLabel(snapshot.expiry),
    ends_in_s: Math.max(0, Math.floor((expiryMs - now) / 1000)),
    lock_within_s: Math.max(0, Math.floor((expiryMs - FAIR.MIN_TTE_MS - now) / 1000)),
    say: `Gemini prices it ${oddsDisplay(result.stakes.a, result.stakes.b)}: ${spokenUsd(result.stakes.a)} against ${spokenUsd(result.stakes.b)}.`,
  });
}
