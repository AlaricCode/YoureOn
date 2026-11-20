// Voice routes: the ElevenLabs conversation token (POST /v1/voice/tokens), the propose_terms and
// confirm_terms webhook tools (./tools), A's transcript and cue relays (./relay), the post-call
// webhook (./post-call) and the judge's readiness probe (GET /v1/demo/voice, ./readiness). The
// other webhook tools are registered by odds/routes.ts, review/routes.ts and markets/bet-routes.ts.
// Spec: docs/planning/API-CONTRACT.md §2.6.
//
// Spend guard: a conversation token starts a billable ElevenLabs Agent session (agent minutes +
// LLM usage), so the default client calls ElevenLabs only with ALLOW_SPEND=true. Without it the
// token route answers 502 UPSTREAM_ERROR {reason: 'spend_disabled'} and never calls out.
import { eq } from 'drizzle-orm';
import { bets, voiceSessions } from '@youre-on/db';
import { isTerminalBetState, type BetState } from '@youre-on/shared/bet-state';
import {
  VOICE_TOKENS_PATH,
  VoiceTokenRequest,
  type VoiceTokenResponse,
} from '@youre-on/shared/judge/voice';
import type { AppDeps, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { nonDemoPlayers } from '../demo/players';
import { requireDemo } from '../demo/routes';
import { createElevenLabsClient, UpstreamError, type ElevenLabsClient } from './elevenlabs';
import { voiceReadiness } from './readiness';
import { cuesHandler, LineDedupe, voiceLinesHandler } from './relay';
import { EL_WEBHOOK_BODY_LIMIT, EL_WEBHOOK_PATH, postCallWebhookHandler } from './post-call';
import {
  confirmTermsHandler,
  proposeTermsHandler,
  termsSink,
  ToolState,
  type ProposalSink,
} from './tools';

/** Conversation tokens per user: a burst of 6, then one every 100 s. */
export const VOICE_TOKENS_BUCKET = { limit: 6, windowMs: 10 * 60_000 } as const;

export interface VoiceRoutesOptions {
  /** Defaults to a fetch client built from ELEVENLABS_API_KEY. */
  elevenlabs?: ElevenLabsClient | ((deps: AppDeps) => ElevenLabsClient);
  sink?: ProposalSink;
  state?: ToolState;
  lines?: LineDedupe;
}

export function createVoiceRoutes(o: VoiceRoutesOptions = {}): RouteModule {
  return {
    name: 'voice',
    bodyLimits: [{ path: /^\/webhooks\/elevenlabs$/, maxBytes: EL_WEBHOOK_BODY_LIMIT }],
    register(app, deps) {
      const el: ElevenLabsClient | null =
        typeof o.elevenlabs === 'function'
          ? o.elevenlabs(deps)
          : (o.elevenlabs ??
            (deps.env.ALLOW_SPEND === true
              ? createElevenLabsClient({ apiKey: deps.env.ELEVENLABS_API_KEY })
              : null));
      if (!el && deps.env.ELEVENLABS_API_KEY)
        deps.log.warn('voice.spend_disabled', {
          hint: 'ELEVENLABS_API_KEY is set but ALLOW_SPEND is not true: voice tokens are refused',
        });
      const state = o.state ?? new ToolState();
      const readiness = voiceReadiness(deps.env, el !== null);
      deps.log.info('voice.readiness', {
        ready: readiness.ready,
        judge_ready: readiness.judge_ready,
        missing: readiness.missing,
        optional: readiness.optional,
        webhook_url: readiness.webhook_url,
      });

      app.post(VOICE_TOKENS_PATH, requireSignedRequest, async (c) => {
        const d = c.get('deps');
        const me = appAuth(c);
        const body = await readBody(c, VoiceTokenRequest);
        const agentId = d.env.ELEVENLABS_AGENT_ID;
        // DEMO_MODE (the finals server): the judge agent is for the demo players only, so open
        // signups can't fill the plan's concurrent conversations before the real one starts.
        // VOICE_DEMO_ONLY=false opens it to every player. A refusal is logged: the client falls
        // back to the typed form, so without this line it is invisible.
        if (
          d.env.DEMO_MODE &&
          d.env.VOICE_DEMO_ONLY &&
          (await nonDemoPlayers(d, [me.user_id])).length
        ) {
          d.log.warn('voice.token_refused', {
            reason: 'demo_only',
            user_id: me.user_id,
            bet_id: body.bet_id ?? null,
          });
          throw new HttpError('NOT_A_PARTY', 'The voice judge is for the demo players today.', {
            reason: 'demo_only',
          });
        }

        if (body.bet_id) {
          const [bet] = await d.db
            .select({ party_a_id: bets.party_a_id, party_b_id: bets.party_b_id, state: bets.state })
            .from(bets)
            .where(eq(bets.id, body.bet_id))
            .limit(1);
          if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
          // Only A's phone hosts the session; B (or anyone else) gets NOT_A_PARTY.
          if (bet.party_a_id !== me.user_id)
            throw new HttpError('NOT_A_PARTY', "Only the challenger's phone hosts the judge.", {
              bet_id: body.bet_id,
            });
          if (isTerminalBetState(bet.state as BetState))
            throw new HttpError('INVALID_STATE', 'This bet is over.', { state: bet.state });
        }

        if (!agentId)
          throw new HttpError(
            'UPSTREAM_ERROR',
            "The judge isn't set up yet.",
            { reason: 'not_configured' },
            { retryable: false },
          );
        if (!el)
          throw new HttpError(
            'UPSTREAM_ERROR',
            "The judge isn't set up yet.",
            { reason: deps.env.ELEVENLABS_API_KEY ? 'spend_disabled' : 'not_configured' },
            { retryable: false },
          );
        // Each token opens a billed agent session of up to 20 min: a per-user bucket on top of
        // the 120/min session one (a bet mints once, plus one retry on a blip).
        d.rateLimit?.take('voice/tokens', me.user_id, VOICE_TOKENS_BUCKET);
        let minted;
        try {
          minted = await el.conversationToken(agentId);
        } catch (e) {
          if (e instanceof UpstreamError) {
            d.log.warn('voice.token_failed', { kind: e.kind, status: e.status, msg: e.message });
            if (e.kind === 'timeout')
              throw new HttpError('UPSTREAM_TIMEOUT', 'The judge is slow to answer. Try again.');
            if (e.kind === 'not_configured')
              throw new HttpError(
                'UPSTREAM_ERROR',
                "The judge isn't set up yet.",
                { reason: 'not_configured' },
                { retryable: false },
              );
            throw new HttpError('UPSTREAM_ERROR', "Couldn't reach the judge. Try again.", {
              upstream_status: e.status ?? null,
            });
          }
          throw e;
        }

        const inserted = await d.db
          .insert(voiceSessions)
          .values({
            bet_id: body.bet_id ?? null,
            user_id: me.user_id,
            device_id: me.device_id,
            purpose: body.purpose,
            el_agent_id: agentId,
            el_conversation_id: minted.conversation_id,
            status: 'active',
          })
          .onConflictDoNothing({ target: voiceSessions.el_conversation_id })
          .returning({ id: voiceSessions.id });
        const row = inserted[0];
        if (!row)
          throw new HttpError('UPSTREAM_ERROR', "Couldn't reach the judge. Try again.", {
            reason: 'duplicate_conversation_id',
          });

        d.log.info('voice.token_minted', {
          voice_session_id: row.id,
          conversation_id: minted.conversation_id,
          bet_id: body.bet_id ?? null,
          user_id: me.user_id,
        });
        const res: VoiceTokenResponse = {
          conversation_token: minted.token,
          conversation_id: minted.conversation_id,
          agent_id: agentId,
          voice_session_id: row.id,
          expires_at: null,
        };
        return c.json(res, 201);
      });

      app.post(
        '/el/tools/propose_terms',
        proposeTermsHandler({ state, sink: o.sink ?? termsSink }),
      );
      app.post('/el/tools/confirm_terms', confirmTermsHandler({ state }));

      app.post(
        '/v1/bets/:bet_id/voice/lines',
        requireSignedRequest,
        voiceLinesHandler(o.lines ?? new LineDedupe()),
      );
      app.post('/v1/bets/:bet_id/cues', requireSignedRequest, cuesHandler());

      app.post(EL_WEBHOOK_PATH, postCallWebhookHandler());

      app.get('/v1/demo/voice', requireDemo, (c) =>
        c.json(voiceReadiness(c.get('deps').env, el !== null), 200),
      );
    },
  };
}

export const voiceRoutes: RouteModule = createVoiceRoutes();
