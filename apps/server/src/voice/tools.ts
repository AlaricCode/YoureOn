// ElevenLabs webhook tools: POST /el/tools/:name (API-CONTRACT §4.2–§4.3, TASKS D0-J2, D1-J1).
//
// propose_terms: validate the LLM-facing projection, map it into TermsProposal, run the
// synchronous guardrail prefilter, answer the judge, then hand the evaluation to a `ProposalSink`
// (NOT awaited: §4.2 heavy work is asynchronous). The production sink is `termsSink`
// (lock/terms.ts persistEvaluation): compose Terms with the server-owned fields (bet_id, escrow,
// party pubkeys snapshotted onto the bet, deadline, USDC base-unit stakes), computeTermsHash, a
// bet_terms_versions row, TERMS_PROPOSED, terms.proposed / terms.draft to both parties + the stage;
// a refusal cancels the bet (terms.refused, judge.cue REFUSED). The async LLM guardrail is not
// wired (the synchronous prefilter is the only guardrail today).
//
// confirm_terms: the read-back is done and both said yes out loud (theatre, not binding): freeze
// the terms -> AWAITING_AUTHORIZATIONS, answer now, then LockService.start in the background
// (nonce lease + build + simulate, terms.authorize_request; LOCK_SIGNER=server signs custodially).
//
// Conventions (§4.2): always HTTP 200 with JSON < 300 B, except 401 for a bad secret; business
// errors are {ok:false, fix, say}; the binding check resolves conversation_id -> voice_sessions
// -> bet_id and answers WRONG_BET (plus an audit row) on any mismatch; a duplicate call within
// 10 s replays the stored reply; /el/tools/* is limited to 30/min per conversation (§1.7).
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { auditLog, bets, voiceSessions } from '@youre-on/db';
import { jcs } from '@youre-on/shared/jcs';
import { MAX_STAKE } from '@youre-on/shared/constants';
import { Uuid } from '@youre-on/shared/primitives';
import {
  evaluateProposeTerms,
  fitReply,
  proposeTermsReply,
  type ProposeEvaluation,
  type ToolReply,
} from '@youre-on/shared/judge/reply';
import type { AppDeps, AppEnv } from '../context';
import { HttpError } from '../errors';
import { sha256Hex } from '../crypto';
import { lifecycleOf } from '../lock/runtime';
import { confirmTerms, persistEvaluation } from '../lock/terms';
import { TOOL_SECRET_HEADER, toolSecretOk } from './tool-auth';

/** States in which the judge may (re)propose terms (SCHEMAS §9.2: edits before the freeze). */
export const PROPOSABLE_STATES = ['DRAFTING', 'TERMS_PROPOSED'] as const;
/** §4.2 hash-dedupe window (used while the webhook tool-call id is unverified: PENDING-KEY). */
export const TOOL_DEDUPE_WINDOW_MS = 10_000;
/** §1.7 `/el/tools/*`: 30/min per conversation. */
export const EL_TOOLS_BUCKET = { limit: 30, windowMs: 60_000 } as const;

export interface BoundSession {
  /** null for the demo injection path (POST /v1/demo/bets/:id/terms: no voice session). */
  voice_session_id: string | null;
  conversation_id: string | null;
  bet_id: string;
  bet_state: string;
  party_a_id: string;
  party_b_id: string;
  room_id: string | null;
}

export interface ProposalEvent {
  deps: AppDeps;
  session: BoundSession;
  evaluation: ProposeEvaluation;
  reply: ToolReply;
  requestId: string;
}

/**
 * Where D1-J1 plugs in (compose Terms, hash, persist, push terms.draft / terms.proposed, start the
 * async guardrail; on a refusal cancel the bet). Called after the reply is computed and NOT
 * awaited by the request path (§4.2: heavy work is asynchronous). Errors are logged.
 */
export interface ProposalSink {
  onEvaluated(e: ProposalEvent): Promise<void>;
}

/**
 * The production sink (D1-J1): lock/terms.ts persistEvaluation. Errors are logged by the caller.
 */
export const termsSink: ProposalSink = {
  async onEvaluated({ deps, session, evaluation, requestId }) {
    if (evaluation.kind === 'invalid') return;
    const r = await persistEvaluation(deps, session.bet_id, evaluation, {
      requestId,
      source: session.conversation_id ? 'propose_terms' : 'demo',
    });
    deps.log.info('terms.sink', { bet_id: session.bet_id, result: r.kind });
  },
};

/** The pre-D1-J1 sink: an audit row for every refusal, nothing else (kept for tests). */
export const auditOnlySink: ProposalSink = {
  async onEvaluated({ deps, session, evaluation, requestId }) {
    if (evaluation.kind !== 'refused') return;
    await deps.db.insert(auditLog).values({
      actor_kind: 'judge',
      action: 'terms.refused_prefilter',
      bet_id: session.bet_id,
      request_id: requestId,
      details: {
        category: evaluation.refusal.category,
        conversation_id: session.conversation_id,
        voice_session_id: session.voice_session_id,
      },
    });
  },
};

const reply = (c: Context<AppEnv>, body: ToolReply) => c.json(fitReply(body), 200);

const SAY = {
  WRONG_BET: "That's not this bet's docket.",
  NOT_DRAFTING: 'These terms are already frozen. Start a new bet to change them.',
  SLOW_DOWN: 'One at a time. Say that again.',
  SERVER: "Clerk's out. Say that again.",
  INVALID: 'Run that by me again. I need clean terms.',
} as const;

interface CachedReply {
  at: number;
  reply: ToolReply;
}

/** In-process state of the tool layer (one Fly machine, like the P0 idempotency LRU). */
export class ToolState {
  private replies = new Map<string, CachedReply>();
  /** bet_id -> {rev, fingerprint of the last valid proposal}. D1-J1 moves this to bet_terms_versions. */
  private revisions = new Map<string, { rev: number; fp: string }>();
  constructor(private readonly maxEntries = 2_000) {}

  cached(key: string, now: number): ToolReply | null {
    const hit = this.replies.get(key);
    if (!hit) return null;
    if (now - hit.at > TOOL_DEDUPE_WINDOW_MS) {
      this.replies.delete(key);
      return null;
    }
    return hit.reply;
  }

  store(key: string, now: number, r: ToolReply): void {
    if (this.replies.size >= this.maxEntries) {
      for (const [k, v] of this.replies) {
        if (now - v.at > TOOL_DEDUPE_WINDOW_MS || this.replies.size >= this.maxEntries)
          this.replies.delete(k);
        if (this.replies.size < this.maxEntries / 2) break;
      }
    }
    this.replies.set(key, { at: now, reply: r });
  }

  /**
   * bet_id -> the refusal reply. SCHEMAS §3: a refusal ends the bet (CANCELLED,
   * 'refused:<category>'). Until D2-J1 commits that transition, a refused bet stays refused here,
   * so a re-worded call on the same bet cannot talk its way past the prefilter.
   */
  private refusals = new Map<string, ToolReply>();

  refusedReply(betId: string): ToolReply | null {
    return this.refusals.get(betId) ?? null;
  }

  markRefused(betId: string, r: ToolReply): void {
    if (this.refusals.size >= this.maxEntries) {
      const first = this.refusals.keys().next();
      if (!first.done) this.refusals.delete(first.value);
    }
    if (!this.refusals.has(betId)) this.refusals.set(betId, r);
  }

  /** +1 per judge turn that changes the draft (SCHEMAS TermsDraft.revision); same proposal -> same rev. */
  revision(betId: string, fingerprint: string): number {
    const cur = this.revisions.get(betId);
    if (cur && cur.fp === fingerprint) return cur.rev;
    const rev = (cur?.rev ?? 0) + 1;
    this.revisions.set(betId, { rev, fp: fingerprint });
    return rev;
  }
}

/** §4.2 hash dedupe: sha256(conversation_id ‖ name ‖ JCS(args)). */
export const toolDedupeKey = (conversationId: string, name: string, body: unknown): string =>
  sha256Hex(`${conversationId}\n${name}\n${jcs(body)}`);

async function loadBinding(deps: AppDeps, conversationId: string): Promise<BoundSession | null> {
  const [row] = await deps.db
    .select({
      voice_session_id: voiceSessions.id,
      status: voiceSessions.status,
      bet_id: voiceSessions.bet_id,
      bet_state: bets.state,
      party_a_id: bets.party_a_id,
      party_b_id: bets.party_b_id,
      room_id: bets.room_id,
    })
    .from(voiceSessions)
    .leftJoin(bets, eq(bets.id, voiceSessions.bet_id))
    .where(and(eq(voiceSessions.el_conversation_id, conversationId)))
    .limit(1);
  if (
    !row ||
    row.status !== 'active' ||
    !row.bet_id ||
    !row.bet_state ||
    !row.party_a_id ||
    !row.party_b_id
  )
    return null;
  return {
    voice_session_id: row.voice_session_id,
    conversation_id: conversationId,
    bet_id: row.bet_id,
    bet_state: row.bet_state,
    party_a_id: row.party_a_id,
    party_b_id: row.party_b_id,
    room_id: row.room_id,
  };
}

export interface ToolHandlerOptions {
  state: ToolState;
  sink: ProposalSink;
}

export function proposeTermsHandler(opts: ToolHandlerOptions) {
  const name = 'propose_terms';
  return async (c: Context<AppEnv>) => {
    const deps = c.get('deps');
    const requestId = c.get('requestId');
    const t0 = performance.now();
    // §4.1: every WRONG_BET writes an audit row; off the reply path, failures only logged.
    const audit = (action: string, betId: string | undefined, details: Record<string, unknown>) =>
      void deps.db
        .insert(auditLog)
        .values({
          actor_kind: 'judge',
          action,
          bet_id: betId && Uuid.safeParse(betId).success ? betId : null,
          request_id: requestId,
          details,
        })
        .catch((e: unknown) => deps.log.error('el_tool.audit_failed', { err: String(e) }));
    const log = (status: 'ok' | 'error' | 'duplicate', extra: Record<string, unknown>) =>
      deps.log.info('el_tool.call', {
        tool: name,
        status,
        latency_ms: Math.round((performance.now() - t0) * 100) / 100,
        request_id: requestId,
        ...extra,
      });

    // 1. auth (the only non-200)
    if (!toolSecretOk(c.req.header(TOOL_SECRET_HEADER), [deps.env.ELEVENLABS_TOOL_SECRET])) {
      deps.log.warn('el_tool.unauthorized', { tool: name, request_id: requestId });
      return c.json({ ok: false, fix: 'UNAUTHORIZED' }, 401);
    }

    let conversationId: string | undefined;
    try {
      // 2. body
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        log('error', { fix: 'INVALID' });
        return reply(c, { ok: false, fix: 'INVALID', say: SAY.INVALID, bad: ['(body): not JSON'] });
      }
      const ids = (body ?? {}) as { conversation_id?: unknown; bet_id?: unknown };
      conversationId = typeof ids.conversation_id === 'string' ? ids.conversation_id : undefined;
      const betId = typeof ids.bet_id === 'string' ? ids.bet_id : undefined;
      if (!conversationId || !betId || conversationId.length > 128) {
        audit('el_tool.wrong_bet', betId, {
          tool: name,
          conversation_id: conversationId?.slice(0, 128) ?? null,
          claimed_bet_id: betId?.slice(0, 64) ?? null,
          bound_bet_id: null,
          reason: 'missing_ids',
        });
        log('error', { fix: 'WRONG_BET', reason: 'missing_ids' });
        return reply(c, { ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
      }

      // 3. rate limit per conversation (§1.7); a 429 would break the tool contract, so it is a fix.
      try {
        deps.rateLimit?.take('el/tools', conversationId, EL_TOOLS_BUCKET);
      } catch (e) {
        if (e instanceof HttpError && e.code === 'RATE_LIMITED') {
          log('error', { fix: 'SLOW_DOWN', conversation_id: conversationId });
          return reply(c, { ok: false, fix: 'SLOW_DOWN', say: SAY.SLOW_DOWN });
        }
        throw e;
      }

      // 4. duplicate within 10 s -> replay
      const now = deps.now();
      const dedupeKey = toolDedupeKey(conversationId, name, body);
      const prior = opts.state.cached(dedupeKey, now);
      if (prior) {
        log('duplicate', { conversation_id: conversationId, bet_id: betId });
        return reply(c, prior);
      }

      // 5. binding check (§4.1 security)
      const session = await loadBinding(deps, conversationId);
      if (!session || session.bet_id !== betId) {
        audit('el_tool.wrong_bet', session?.bet_id ?? betId, {
          tool: name,
          conversation_id: conversationId,
          claimed_bet_id: betId.slice(0, 64),
          bound_bet_id: session?.bet_id ?? null,
          reason: session ? 'bet_mismatch' : 'no_active_session',
        });
        log('error', { fix: 'WRONG_BET', conversation_id: conversationId });
        return reply(c, { ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
      }
      // A refused bet stays refused (SCHEMAS §3; see ToolState.refusedReply). Checked before the
      // state: the sink has already moved a refused bet to CANCELLED.
      const refused = opts.state.refusedReply(betId);
      if (refused) {
        opts.state.store(dedupeKey, now, refused);
        log('error', { bet_id: betId, refused: refused.refused, reason: 'already_refused' });
        return reply(c, refused);
      }
      if (!(PROPOSABLE_STATES as readonly string[]).includes(session.bet_state)) {
        const r: ToolReply = { ok: false, fix: 'NOT_DRAFTING', say: SAY.NOT_DRAFTING };
        opts.state.store(dedupeKey, now, r);
        log('error', { fix: 'NOT_DRAFTING', bet_id: betId, state: session.bet_state });
        return reply(c, r);
      }

      // 6. evaluate (pure: normText, map, strip-parse, prefilter, stake, market)
      const maxStake = deps.env.MAX_STAKE_MICRO ? BigInt(deps.env.MAX_STAKE_MICRO) : MAX_STAKE;
      const evaluation = evaluateProposeTerms(body, { maxStake, realWorldEnabled: false });
      const rev =
        evaluation.kind === 'proposal'
          ? opts.state.revision(betId, sha256Hex(jcs(evaluation.proposal)))
          : undefined;
      const r = proposeTermsReply(evaluation, { rev, maxStake });
      opts.state.store(dedupeKey, now, r);
      if (evaluation.kind === 'refused') opts.state.markRefused(betId, r);

      void opts.sink
        .onEvaluated({ deps, session, evaluation, reply: r, requestId })
        .catch((e: unknown) =>
          deps.log.error('el_tool.sink_failed', { tool: name, bet_id: betId, err: String(e) }),
        );
      log(r.ok ? 'ok' : 'error', {
        conversation_id: conversationId,
        bet_id: betId,
        kind: evaluation.kind,
        fix: r.fix,
        refused: r.refused,
      });
      return reply(c, r);
    } catch (e) {
      deps.log.error('el_tool.failed', {
        tool: name,
        conversation_id: conversationId,
        err: String(e),
      });
      return reply(c, { ok: false, fix: 'SERVER', say: SAY.SERVER });
    }
  };
}

// ---- confirm_terms (API-CONTRACT §4.3) ---------------------------------------------------------

const CONFIRM_SAY = {
  NOT_PROPOSED: "Nothing to confirm yet. What's the bet?",
} as const;

/** "Logan, Jake: hold the button on your own phone to lock it in. Nothing moves until you both do." */
export function confirmSay(a: string, b: string): string {
  return `${a}, ${b}: hold the button on your own phone to lock it in. Nothing moves until you both do.`;
}

/**
 * The confirm step shared by the webhook and POST /v1/demo/bets/:id/confirm: freeze, then start
 * the lock in the background. Returns the tool reply.
 */
export async function confirmAndLock(
  deps: AppDeps,
  betId: string,
  o: {
    heard?: string;
    requestId?: string;
    actor?: 'judge' | 'system' | 'user';
    actorUserId?: string;
  } = {},
): Promise<ToolReply> {
  const r = await confirmTerms(deps, betId, o);
  if (!r.ok) return { ok: false, fix: 'NOT_PROPOSED', say: CONFIRM_SAY.NOT_PROPOSED };
  if (!r.already) lifecycleOf(deps).lock.startInBackground(betId);
  const t = r.envelope.terms;
  return fitReply({
    ok: true,
    code: r.code,
    say: confirmSay(t.party_a.display_name, t.party_b.display_name),
  });
}

export function confirmTermsHandler(opts: Pick<ToolHandlerOptions, 'state'>) {
  const name = 'confirm_terms';
  return async (c: Context<AppEnv>) => {
    const deps = c.get('deps');
    const requestId = c.get('requestId');
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
        return reply(c, { ok: false, fix: 'INVALID', say: SAY.INVALID });
      }
      const ids = (body ?? {}) as { conversation_id?: unknown; bet_id?: unknown; heard?: unknown };
      conversationId = typeof ids.conversation_id === 'string' ? ids.conversation_id : undefined;
      const betId = typeof ids.bet_id === 'string' ? ids.bet_id : undefined;
      const heard = typeof ids.heard === 'string' ? ids.heard.slice(0, 8) : undefined;
      if (!conversationId || !betId || conversationId.length > 128)
        return reply(c, { ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
      try {
        deps.rateLimit?.take('el/tools', conversationId, EL_TOOLS_BUCKET);
      } catch (e) {
        if (e instanceof HttpError && e.code === 'RATE_LIMITED')
          return reply(c, { ok: false, fix: 'SLOW_DOWN', say: SAY.SLOW_DOWN });
        throw e;
      }
      const now = deps.now();
      const dedupeKey = toolDedupeKey(conversationId, name, body);
      const prior = opts.state.cached(dedupeKey, now);
      if (prior) return reply(c, prior);

      const session = await loadBinding(deps, conversationId);
      if (!session || session.bet_id !== betId) {
        void deps.db
          .insert(auditLog)
          .values({
            actor_kind: 'judge',
            action: 'el_tool.wrong_bet',
            bet_id: Uuid.safeParse(betId).success ? betId : null,
            request_id: requestId,
            details: {
              tool: name,
              conversation_id: conversationId,
              claimed_bet_id: betId.slice(0, 64),
              bound_bet_id: session?.bet_id ?? null,
              reason: session ? 'bet_mismatch' : 'no_active_session',
            },
          })
          .catch((e: unknown) => deps.log.error('el_tool.audit_failed', { err: String(e) }));
        return reply(c, { ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
      }
      const r = await confirmAndLock(deps, betId, { heard, requestId });
      // Only a success is replayed: NOT_PROPOSED may turn into a success a second later.
      if (r.ok) opts.state.store(dedupeKey, now, r);
      deps.log.info('el_tool.call', { tool: name, bet_id: betId, ok: r.ok, request_id: requestId });
      return reply(c, r);
    } catch (e) {
      deps.log.error('el_tool.failed', {
        tool: name,
        conversation_id: conversationId,
        err: String(e),
      });
      return reply(c, { ok: false, fix: 'SERVER', say: SAY.SERVER });
    }
  };
}
