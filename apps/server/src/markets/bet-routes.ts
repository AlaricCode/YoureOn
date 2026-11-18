// Beat 6 on the phone (packages/shared/src/judge/market-terms.ts):
//
//   POST /v1/bets/:bet_id/terms/market   (S, party A; DRAFTING | TERMS_PROPOSED)
//     MarketTermsRequest {side: UP|DOWN, amount_usd} -> the binding quote (markets/quote.ts:
//     fairStakes over the relay's snapshot, capped by max_stake, strike required) -> the
//     propose_terms projection for that call (marketTermsArgs) -> the SAME evaluateProposeTerms
//     and persistEvaluation as /terms/typed and the voice judge (terms.proposed fans out; the
//     bet records gemini_market_id, a_position, odds_*, quoted_at, pricing_snapshot_id).
//     -> 200 MarketTermsResponse
//     -> 409 MARKET_UNAVAILABLE {reason: FairRefusal} when Gemini can't price it; 409
//        INVALID_STATE after the freeze; 400 VALIDATION_FAILED for a bad amount.
//   Then the normal POST /v1/bets/:bet_id/terms/confirm (a quote older than 30 s is re-quoted
//   and answered 409 TERMS_HASH_MISMATCH {reason: 'requoted'}), the lock, AWAITING_MARKET, and
//   the settlement keeper (markets/settlement.ts).
//
// Also wires the relay's snapshots into the settlement service (market.tick per waiting bet),
// as stage/routes.ts wires them into stage.market.
import { evaluateProposeTerms } from '@youre-on/shared/judge/reply';
import {
  marketReadback,
  marketSideOf,
  marketTermsArgs,
  MarketTermsRequest,
  type MarketTermsResponse,
} from '@youre-on/shared/judge/market-terms';
import { parseUsd } from '@youre-on/shared/money';
import type { RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { requireSignedRequest } from '../auth/middleware';
import { readBet } from '../lock/common';
import { displayCode, persistEvaluation } from '../lock/terms';
import { partyABet } from '../terms/routes';
import { PROPOSABLE_STATES } from '../voice/tools';
import { maxStakeOf, realWorldEnabled, takeBindingQuote } from './quote';
import { marketMessage } from './routes';
import { settlementOf } from './settlement';

const isProposable = (state: string) => (PROPOSABLE_STATES as readonly string[]).includes(state);

export const marketBetRoutes: RouteModule = {
  name: 'market-bets',
  register(app, deps) {
    deps.markets?.onSnapshot((snapshot) => settlementOf(deps).onSnapshot(snapshot));

    app.post('/v1/bets/:bet_id/terms/market', requireSignedRequest, async (c) => {
      const deps = c.get('deps');
      const { bet } = await partyABet(c);
      if (!isProposable(bet.state))
        throw new HttpError('INVALID_STATE', 'These terms are already set.', { state: bet.state });
      const body = await readBody(c, MarketTermsRequest);
      if (!realWorldEnabled(deps))
        throw new HttpError('MARKET_UNAVAILABLE', 'Bitcoin bets are off right now.', {
          reason: 'MARKET_NOT_OPEN',
        });
      let amount: string;
      try {
        amount = parseUsd(body.amount_usd);
      } catch {
        throw new HttpError('VALIDATION_FAILED', "Dollars like '5' or '5.20'.", {
          issues: [{ path: 'amount_usd', message: 'not a dollar amount' }],
        });
      }

      const q = await takeBindingQuote(deps, { amount, side: marketSideOf(body.side) });
      if (!q.ok)
        throw new HttpError('MARKET_UNAVAILABLE', marketMessage(q.reason), { reason: q.reason });
      const evaluation = evaluateProposeTerms(
        marketTermsArgs({
          side: body.side,
          amount_usd: body.amount_usd,
          expiry: q.quote.ref.expiry,
        }),
        { maxStake: maxStakeOf(deps), realWorldEnabled: true },
      );
      if (evaluation.kind === 'issue')
        throw new HttpError('MARKET_UNAVAILABLE', marketMessage(evaluation.issue.code), {
          reason: evaluation.issue.code,
        });
      if (evaluation.kind !== 'proposal' || evaluation.missing.length)
        throw new HttpError('VALIDATION_FAILED', 'That bet needs fixing.', {
          issues: evaluation.kind === 'invalid' ? evaluation.issues : [],
        });

      const r = await persistEvaluation(deps, bet.id, evaluation, {
        requestId: c.get('requestId'),
        source: 'market',
        draftedBy: 'party_a',
        quote: q.quote,
        templateClaim: true,
      });
      deps.log.info('terms.market', {
        bet_id: bet.id,
        result: r.kind,
        event_ticker: q.quote.ref.eventTicker,
        price: q.quote.ref.priceAtLock,
      });
      if (r.kind === 'skipped') {
        const now = await readBet(deps.db, bet.id);
        throw new HttpError('INVALID_STATE', 'These terms are already set.', {
          state: now?.state ?? null,
        });
      }
      if (r.kind !== 'proposed' || !r.quote)
        throw new HttpError('MARKET_UNAVAILABLE', marketMessage('NO_TWO_SIDED_QUOTE'), {
          reason: 'NO_TWO_SIDED_QUOTE',
        });
      const t = r.envelope.terms;
      const res: MarketTermsResponse = {
        ok: true,
        kind: 'proposed',
        state: 'TERMS_PROPOSED',
        terms_hash: r.envelope.terms_hash,
        code: displayCode(r.envelope.terms_hash),
        say: marketReadback(t),
        quote: { ...r.quote, market: t.market!, stakes: t.stakes },
      };
      return c.json(res, 200);
    });
  },
};
