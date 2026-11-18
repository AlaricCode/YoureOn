// Typed terms: Beat 2 without the voice judge (packages/shared/src/judge/typed-terms.ts).
//
//   POST /v1/bets/:bet_id/terms/typed    (S, party A; DRAFTING | TERMS_PROPOSED)
//     TypedTermsRequest -> typedTermsArgs -> evaluateProposeTerms (the same pure core as
//     /el/tools/propose_terms: normText, mapping, guardrail prefilter, stake cap, market) ->
//     lock/terms.ts persistEvaluation (the body of voice/tools.ts termsSink): terms.proposed +
//     bet.state TERMS_PROPOSED, or terms.draft, or a refusal that cancels the bet (terms.refused,
//     judge.cue REFUSED). Unlike the webhook, the persist is awaited: the phone gets the outcome.
//   POST /v1/bets/:bet_id/terms/confirm  (S, party A; TERMS_PROPOSED)
//     {terms_hash} must be the bet's current terms (409 TERMS_HASH_MISMATCH otherwise), then the
//     confirm_terms step (voice/tools.ts confirmAndLock): freeze -> AWAITING_AUTHORIZATIONS ->
//     LockService.start in the background. A repeat after the freeze answers the same code.
//     B must have accepted the invite first (409 INVALID_STATE {reason: 'invite_pending'}):
//     with LOCK_SIGNER=server the lock is custodial, so B's accept is B's only consent here.
//
// Only A sets terms, as only A's phone hosts the judge (D6); B consents with the invite accept
// (and, with LOCK_SIGNER=phones, the lock hold).
// Both routes share a per-(bet, user) bucket on top of the session bucket (API-CONTRACT §1.7).
import type { Context } from 'hono';
import { isTerminalBetState } from '@youre-on/shared/bet-state';
import { MAX_STAKE } from '@youre-on/shared/constants';
import { newRoundLine } from '@youre-on/shared/judge/market-terms';
import { evaluateProposeTerms, proposeTermsReply } from '@youre-on/shared/judge/reply';
import {
  TermsConfirmRequest,
  typedTermsArgs,
  TypedTermsRequest,
  type TermsConfirmResponse,
  type TypedTermsResponse,
} from '@youre-on/shared/judge/typed-terms';
import type { AppEnv, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import type { BucketSpec } from '../http/rate-limit';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import type { BetRow } from '../bets/snapshot';
import { readBet } from '../lock/common';
import { priorAnswers } from '../bets/invite';
import { betIdParam } from '../lock/routes';
import { displayCode, loadEnvelope, persistEvaluation } from '../lock/terms';
import { marketMessage } from '../markets/routes';
import { confirmAndLock, PROPOSABLE_STATES } from '../voice/tools';

/** Typed proposals + confirms: 12/min per (bet, user). Plenty for a person, stops a loop. */
export const TYPED_TERMS_BUCKET: BucketSpec = { limit: 12, windowMs: 60_000 };

const isProposable = (state: string) => (PROPOSABLE_STATES as readonly string[]).includes(state);

/** Loads the bet and checks the caller is party A; takes the route's rate-limit token. */
export async function partyABet(c: Context<AppEnv>): Promise<{ bet: BetRow; userId: string }> {
  const deps = c.get('deps');
  const me = appAuth(c);
  const betId = betIdParam(c.req.param('bet_id') ?? '');
  deps.rateLimit?.take('terms', `${betId}:${me.user_id}`, TYPED_TERMS_BUCKET);
  const bet = await readBet(deps.db, betId);
  if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
  if (bet.party_a_id !== me.user_id)
    throw new HttpError(
      'NOT_A_PARTY',
      bet.party_b_id === me.user_id
        ? 'Only the challenger sets the terms.'
        : "You're not in this bet.",
      { bet_id: betId },
    );
  return { bet, userId: me.user_id };
}

export const termsRoutes: RouteModule = {
  name: 'terms',
  register(app) {
    app.post('/v1/bets/:bet_id/terms/typed', requireSignedRequest, async (c) => {
      const deps = c.get('deps');
      const requestId = c.get('requestId');
      const { bet } = await partyABet(c);
      if (!isProposable(bet.state))
        throw new HttpError('INVALID_STATE', 'These terms are already set.', { state: bet.state });
      const body = await readBody(c, TypedTermsRequest);

      const maxStake = deps.env.MAX_STAKE_MICRO ? BigInt(deps.env.MAX_STAKE_MICRO) : MAX_STAKE;
      const evaluation = evaluateProposeTerms(typedTermsArgs(body), {
        maxStake,
        realWorldEnabled: false,
      });
      const reply = proposeTermsReply(evaluation, { maxStake });
      if (evaluation.kind === 'invalid')
        throw new HttpError('VALIDATION_FAILED', undefined, {
          issues: evaluation.issues.map((i) => ({ path: i.path, message: i.message })),
        });

      const r = await persistEvaluation(deps, bet.id, evaluation, {
        requestId,
        source: 'typed',
        draftedBy: 'party_a',
      });
      deps.log.info('terms.typed', { bet_id: bet.id, kind: evaluation.kind, result: r.kind });
      const say = typeof reply.say === 'string' ? reply.say : '';
      let res: TypedTermsResponse;
      switch (r.kind) {
        case 'skipped': {
          // The bet moved on between the read and the row lock (a race with the voice judge).
          const now = await readBet(deps.db, bet.id);
          throw new HttpError('INVALID_STATE', 'These terms are already set.', {
            state: now?.state ?? null,
          });
        }
        case 'refused':
          res = {
            ok: false,
            kind: 'refused',
            category: evaluation.kind === 'refused' ? evaluation.refusal.category : 'unknown',
            say,
          };
          break;
        case 'draft':
          res = {
            ok: false,
            kind: 'draft',
            fix: typeof reply.fix === 'string' ? reply.fix : null,
            missing: evaluation.kind === 'proposal' ? evaluation.missing.map(String) : [],
            say,
          };
          break;
        case 'proposed':
          res = {
            ok: true,
            kind: 'proposed',
            state: 'TERMS_PROPOSED',
            terms_hash: r.envelope.terms_hash,
            code: displayCode(r.envelope.terms_hash),
            say,
          };
          break;
      }
      return c.json(res, 200);
    });

    app.post('/v1/bets/:bet_id/terms/confirm', requireSignedRequest, async (c) => {
      const deps = c.get('deps');
      const { bet, userId } = await partyABet(c);
      const body = await readBody(c, TermsConfirmRequest);
      const frozen = bet.state !== 'TERMS_PROPOSED';
      // After the freeze a repeat is answered (same code) only for the terms that were frozen.
      if (
        frozen &&
        (isProposable(bet.state) ||
          isTerminalBetState(bet.state) ||
          !bet.terms_hash ||
          !bet.terms_final_at)
      )
        throw new HttpError('INVALID_STATE', 'There are no terms to lock in yet.', {
          state: bet.state,
        });
      if (bet.terms_hash !== body.terms_hash)
        throw new HttpError('TERMS_HASH_MISMATCH', 'The terms changed. Review them again.', {
          terms_hash: bet.terms_hash,
        });
      // B said yes to the challenge. Typing terms before that is fine; freezing them (and, with
      // LOCK_SIGNER=server, signing B's stake) is not. A decline cancels the bet, so it fails the
      // state check above. The early check answers without a write; confirmAndLock re-checks
      // both TERMS_PROPOSED and B's accept under the row lock.
      const invitePending = () =>
        new HttpError('INVALID_STATE', 'Waiting for them to accept.', {
          state: bet.state,
          reason: 'invite_pending',
        });
      if (!frozen && !(await priorAnswers(deps.db, bet.id)).has('accepted')) throw invitePending();
      const r = await confirmAndLock(deps, bet.id, {
        heard: 'typed',
        requestId: c.get('requestId'),
        actor: 'user',
        actorUserId: userId,
        requireInviteAccepted: true,
      });
      if (!r.ok && r.fix === 'INVITE_PENDING') throw invitePending();
      // Gemini bets: a quote too old to lock was re-quoted (new terms: review them again); when
      // the old round stopped pricing, the re-quote is the next round (new line and end).
      if (r.fix === 'REQUOTED') {
        const newRound = r.new_round === true;
        const m = newRound ? (await loadEnvelope(deps.db, bet.id))?.envelope.terms.market : null;
        throw new HttpError(
          'TERMS_HASH_MISMATCH',
          m
            ? `${newRoundLine(m)} Review the new split.`
            : "Gemini's odds moved. Review the new split.",
          { terms_hash: r.terms_hash, reason: 'requoted', new_round: newRound },
        );
      }
      // ...or Gemini can't price it at all now: its own reason (e.g. TOO_CLOSE_TO_EXPIRY, so the
      // phone goes back to the next-round countdown instead of offering the dead card).
      if (r.fix === 'QUOTE_STALE') {
        const reason = typeof r.reason === 'string' ? r.reason : 'QUOTE_STALE';
        throw new HttpError(
          'MARKET_UNAVAILABLE',
          reason === 'QUOTE_STALE'
            ? "Gemini can't price this round anymore."
            : marketMessage(reason),
          { reason },
        );
      }
      if (!r.ok || typeof r.code !== 'string')
        throw new HttpError('INVALID_STATE', 'There are no terms to lock in yet.', {
          state: (await readBet(deps.db, bet.id))?.state ?? null,
        });
      const after = await readBet(deps.db, bet.id);
      const res: TermsConfirmResponse = {
        ok: true,
        code: r.code,
        state: after?.state ?? 'AWAITING_AUTHORIZATIONS',
        say: typeof r.say === 'string' ? r.say : '',
      };
      return c.json(res, 200);
    });
  },
};
