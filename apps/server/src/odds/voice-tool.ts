// The voice judge's `suggest_odds` webhook tool (API-CONTRACT §4.3):
//
//   POST /el/tools/suggest_odds   secret header (X-YO-Tool-Secret), like propose_terms
//     body: ids + {claim, performer: 'A'|'B', attempts: {count, rule}, base_usd: '5'}
//     -> 200 {ok: true, ratio: '3:1', a: '$15', b: '$5', pct: 25, say}
//     -> 200 {ok: false, fix: 'NO_CLAIM' | 'AMBIGUOUS' | 'NOT_DRAFTING' | 'MARKET' | 'WRONG_BET'
//                                | 'SLOW_DOWN' | 'SERVER', say}
//     -> 401 {ok: false, fix: 'UNAUTHORIZED'} for a bad secret (the only non-200)
// The same prelude as propose_terms (voice/tools.ts): secret, per-conversation bucket, 10 s
// dedupe, conversation -> bet binding (WRONG_BET + an audit row). Then odds/suggest.ts
// suggestOdds(): the same engine as the phone's "Suggest odds" button. The judge speaks `say`
// itself, so the ODDS_OFFERED cue it leaves is a contextual update (speak:false).
import type { Context } from 'hono';
import { auditLog } from '@youre-on/db';
import { formatUsd } from '@youre-on/shared/money';
import { Uuid } from '@youre-on/shared/primitives';
import { fitReply, type ToolReply } from '@youre-on/shared/judge/reply';
import { SUGGEST_SAY, SuggestOddsArgs } from '@youre-on/shared/judge/suggest-odds';
import { AttemptRule } from '@youre-on/shared/terms';
import type { AppEnv } from '../context';
import { HttpError } from '../errors';
import { readBet } from '../lock/common';
import { TOOL_SECRET_HEADER, toolSecretOk } from '../voice/tool-auth';
import { EL_TOOLS_BUCKET, loadBinding, toolDedupeKey, ToolState } from '../voice/tools';
import { suggestOdds, type SuggestCache } from './suggest';

const SAY = {
  WRONG_BET: "That's not this bet's docket.",
  SLOW_DOWN: 'One at a time. Say that again.',
  SERVER: "Clerk's out. Say that again.",
  MARKET: 'Gemini sets the odds on this one.',
} as const;

export function suggestOddsHandler(opts: { state?: ToolState; cache?: SuggestCache } = {}) {
  const name = 'suggest_odds';
  const state = opts.state ?? new ToolState();
  return async (c: Context<AppEnv>) => {
    const deps = c.get('deps');
    const requestId = c.get('requestId');
    const reply = (body: ToolReply) => c.json(fitReply(body), 200);
    const audit = (betId: string | undefined, details: Record<string, unknown>) =>
      void deps.db
        .insert(auditLog)
        .values({
          actor_kind: 'judge',
          action: 'el_tool.wrong_bet',
          bet_id: betId && Uuid.safeParse(betId).success ? betId : null,
          request_id: requestId,
          details: { tool: name, ...details },
        })
        .catch((e: unknown) => deps.log.error('el_tool.audit_failed', { err: String(e) }));

    if (!toolSecretOk(c.req.header(TOOL_SECRET_HEADER), [deps.env.ELEVENLABS_TOOL_SECRET])) {
      deps.log.warn('el_tool.unauthorized', { tool: name, request_id: requestId });
      return c.json({ ok: false, fix: 'UNAUTHORIZED' }, 401);
    }
    let conversationId: string | undefined;
    try {
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return reply({ ok: false, fix: 'NO_CLAIM', say: SUGGEST_SAY.NO_CLAIM });
      }
      const ids = (body ?? {}) as { conversation_id?: unknown; bet_id?: unknown };
      conversationId = typeof ids.conversation_id === 'string' ? ids.conversation_id : undefined;
      const betId = typeof ids.bet_id === 'string' ? ids.bet_id : undefined;
      if (!conversationId || !betId || conversationId.length > 128) {
        audit(betId, {
          conversation_id: conversationId?.slice(0, 128) ?? null,
          claimed_bet_id: betId?.slice(0, 64) ?? null,
          bound_bet_id: null,
          reason: 'missing_ids',
        });
        return reply({ ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
      }
      try {
        deps.rateLimit?.take('el/tools', conversationId, EL_TOOLS_BUCKET);
      } catch (e) {
        if (e instanceof HttpError && e.code === 'RATE_LIMITED')
          return reply({ ok: false, fix: 'SLOW_DOWN', say: SAY.SLOW_DOWN });
        throw e;
      }
      const now = deps.now();
      const dedupeKey = toolDedupeKey(conversationId, name, body);
      const prior = state.cached(dedupeKey, now);
      if (prior) return reply(prior);

      const session = await loadBinding(deps, conversationId);
      if (!session || session.bet_id !== betId) {
        audit(session?.bet_id ?? betId, {
          conversation_id: conversationId,
          claimed_bet_id: betId.slice(0, 64),
          bound_bet_id: session?.bet_id ?? null,
          reason: session ? 'bet_mismatch' : 'no_active_session',
        });
        return reply({ ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
      }
      const parsed = SuggestOddsArgs.safeParse(body);
      const args = parsed.success ? parsed.data : null;
      const rule = AttemptRule.safeParse(args?.attempts?.rule);
      const count = args?.attempts?.count;
      const attempts =
        rule.success && typeof count === 'number' && count >= 1 && count <= 5
          ? { count: rule.data === 'single' ? 1 : count, rule: rule.data }
          : undefined;
      const bet = await readBet(deps.db, betId);
      if (!bet) return reply({ ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });

      let r: ToolReply;
      try {
        const s = await suggestOdds(
          deps,
          bet,
          {
            claim: args?.claim,
            performer: args?.performer,
            attempts,
            base_usd: args?.base_usd,
            requestedBy: null,
            via: 'voice',
          },
          { ...(opts.cache ? { cache: opts.cache } : {}), requestId },
        );
        const sug = s.offer.suggestion;
        r = {
          ok: true,
          ratio: sug?.ratio ?? s.offer.ratio_label,
          a: formatUsd(s.offer.stakes.a),
          b: formatUsd(s.offer.stakes.b),
          pct: sug?.chance_pct ?? null,
          say: s.say,
        };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        const d = e.details ?? {};
        const fix =
          d.fix === 'NO_CLAIM' || d.fix === 'AMBIGUOUS'
            ? d.fix
            : d.reason === 'market_bet'
              ? 'MARKET'
              : 'NOT_DRAFTING';
        r = {
          ok: false,
          fix,
          say: fix === 'MARKET' ? SAY.MARKET : SUGGEST_SAY[fix as keyof typeof SUGGEST_SAY],
        };
      }
      state.store(dedupeKey, now, r);
      deps.log.info('el_tool.call', { tool: name, bet_id: betId, ok: r.ok, fix: r.fix });
      return reply(r);
    } catch (e) {
      deps.log.error('el_tool.failed', {
        tool: name,
        conversation_id: conversationId,
        err: String(e),
      });
      return reply({ ok: false, fix: 'SERVER', say: SAY.SERVER });
    }
  };
}
