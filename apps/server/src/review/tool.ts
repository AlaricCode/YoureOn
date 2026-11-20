// The voice judge's `request_review` webhook tool: POST /el/tools/request_review with the secret
// header (X-YO-Tool-Secret), body {conversation_id, bet_id, heard}. Someone said "check that
// again" after the ruling: ReviewService.request (./service.ts) asks the LOSER's phone to confirm
// (the agent never decides, and this files nothing). Same conventions as confirm_terms
// (voice/tools.ts): 401 only for a bad secret; otherwise HTTP 200 with {ok, say, …} under 300 B;
// WRONG_BET (+ an audit row) when the ids don't match the conversation's bet; the 'el/tools'
// bucket (30/min per conversation) answers SLOW_DOWN; a success is replayed within 10 s.
// Spec: docs/planning/API-CONTRACT.md §4.3.
import type { Context } from 'hono';
import { auditLog } from '@youre-on/db';
import { REVIEW_HEARD_MAX, type ReviewFix } from '@youre-on/shared/gg';
import type { ToolReply } from '@youre-on/shared/judge/reply';
import { Uuid } from '@youre-on/shared/primitives';
import { APPEAL_BUCKET } from '../appeal/service';
import { asciiFold } from '../bets/cues';
import type { AppDeps, AppEnv } from '../context';
import { HttpError } from '../errors';
import { lifecycleOf } from '../lock/runtime';
import { TOOL_SECRET_HEADER, toolSecretOk } from '../voice/tool-auth';
import {
  EL_TOOLS_BUCKET,
  loadBinding,
  reply,
  SAY,
  toolDedupeKey,
  type ToolState,
} from '../voice/tools';
import type { ReviewResult } from './service';

const NAME = 'request_review';

/** What the judge says for each refusal. */
export const REVIEW_SAY: Record<
  Exclude<ReviewFix, 'WRONG_BET' | 'SLOW_DOWN' | 'SERVER'>,
  string
> = {
  NO_RULING: 'No ruling to check yet.',
  GG_CALLED: 'GG was called. The ruling stands.',
  FINAL: 'The ruling is final.',
  WINDOW_CLOSED: 'Too late. The ruling stands.',
  WITH_PANEL: "It's already with the panel.",
  ONE_REVIEW: 'One review per ruling. It stands.',
  NO_LOSER: 'Nobody lost this one.',
  MARKET: 'Gemini settled it. No reviews on the market.',
  NO_APPEALS_LEFT: 'No appeals left this hour. It stands.',
  INVALID: 'Say that again.',
};

const spoken = (name: string | null) => asciiFold(name ?? 'The loser').slice(0, 40);

/** ReviewService result -> the tool reply the judge speaks. */
export function reviewReply(r: ReviewResult): ToolReply {
  if (r.ok)
    return r.already
      ? {
          ok: true,
          already: true,
          say: `Already asked. ${spoken(r.loser_name)}, it's on your phone.`,
        }
      : { ok: true, say: `Review requested. ${spoken(r.loser_name)}, confirm on your phone.` };
  if (r.fix === 'WRONG_BET') return { ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET };
  if (r.fix === 'SLOW_DOWN') return { ok: false, fix: 'SLOW_DOWN', say: SAY.SLOW_DOWN };
  if (r.fix === 'SERVER') return { ok: false, fix: 'SERVER', say: SAY.SERVER };
  return { ok: false, fix: r.fix, say: REVIEW_SAY[r.fix] };
}

/** The loser's appeal tokens left, read-only (the 3/h bucket the appeal POST spends). */
export const appealsLeftOf = (deps: AppDeps) =>
  deps.rateLimit
    ? (userId: string) => deps.rateLimit!.remaining('appeal', userId, APPEAL_BUCKET)
    : undefined;

export function requestReviewHandler(opts: { state: ToolState }) {
  return async (c: Context<AppEnv>) => {
    const deps = c.get('deps');
    const requestId = c.get('requestId');
    if (!toolSecretOk(c.req.header(TOOL_SECRET_HEADER), [deps.env.ELEVENLABS_TOOL_SECRET])) {
      deps.log.warn('el_tool.unauthorized', { tool: NAME, request_id: requestId });
      return c.json({ ok: false, fix: 'UNAUTHORIZED' }, 401);
    }
    // Every WRONG_BET writes an audit row (off the reply path, failures only logged).
    const wrongBet = (betId: string | undefined, details: Record<string, unknown>) => {
      void deps.db
        .insert(auditLog)
        .values({
          actor_kind: 'judge',
          action: 'el_tool.wrong_bet',
          bet_id: betId && Uuid.safeParse(betId).success ? betId : null,
          request_id: requestId,
          details: { tool: NAME, ...details },
        })
        .catch((e: unknown) => deps.log.error('el_tool.audit_failed', { err: String(e) }));
      return reply(c, { ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
    };
    let conversationId: string | undefined;
    try {
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return reply(c, { ok: false, fix: 'INVALID', say: REVIEW_SAY.INVALID });
      }
      const ids = (body ?? {}) as { conversation_id?: unknown; bet_id?: unknown; heard?: unknown };
      conversationId = typeof ids.conversation_id === 'string' ? ids.conversation_id : undefined;
      const betId = typeof ids.bet_id === 'string' ? ids.bet_id : undefined;
      const heard = typeof ids.heard === 'string' ? ids.heard.slice(0, REVIEW_HEARD_MAX) : '';
      if (!conversationId || !betId || conversationId.length > 128)
        return wrongBet(betId, {
          conversation_id: conversationId?.slice(0, 128) ?? null,
          claimed_bet_id: betId?.slice(0, 64) ?? null,
          bound_bet_id: null,
          reason: 'missing_ids',
        });
      try {
        deps.rateLimit?.take('el/tools', conversationId, EL_TOOLS_BUCKET);
      } catch (e) {
        if (e instanceof HttpError && e.code === 'RATE_LIMITED')
          return reply(c, { ok: false, fix: 'SLOW_DOWN', say: SAY.SLOW_DOWN });
        throw e;
      }
      const now = deps.now();
      const dedupeKey = toolDedupeKey(conversationId, NAME, body);
      const prior = opts.state.cached(dedupeKey, now);
      if (prior) return reply(c, prior);

      const session = await loadBinding(deps, conversationId);
      if (!session || session.bet_id !== betId)
        return wrongBet(session?.bet_id ?? betId, {
          conversation_id: conversationId,
          claimed_bet_id: betId.slice(0, 64),
          bound_bet_id: session?.bet_id ?? null,
          reason: session ? 'bet_mismatch' : 'no_active_session',
        });

      const r = await lifecycleOf(deps).review.request(betId, {
        source: 'voice',
        heard,
        conversationId,
        requestId,
        appealsLeft: appealsLeftOf(deps),
      });
      const out = reviewReply(r);
      // Only a success is replayed: NO_RULING may turn into one a second later.
      if (out.ok) opts.state.store(dedupeKey, now, out);
      deps.log.info('el_tool.call', {
        tool: NAME,
        bet_id: betId,
        ok: out.ok,
        fix: out.fix,
        already: out.already,
        request_id: requestId,
      });
      return reply(c, out);
    } catch (e) {
      deps.log.error('el_tool.failed', {
        tool: NAME,
        conversation_id: conversationId,
        err: String(e),
      });
      return reply(c, { ok: false, fix: 'SERVER', say: SAY.SERVER });
    }
  };
}
