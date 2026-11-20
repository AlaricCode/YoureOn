// ElevenLabs webhook tools propose_terms and confirm_terms (POST /el/tools/:name).
// Spec: docs/planning/API-CONTRACT.md §4.3.
//
// propose_terms answers at once from a pure evaluation (its synchronous prefilter is the server's
// only guardrail) and hands it to a ProposalSink without awaiting it: the production sink,
// lock/terms.ts persistEvaluation, composes, stores and pushes the terms, or cancels a refused bet.
// confirm_terms freezes the terms, answers, then starts the lock in the background.
// Every reply is HTTP 200 with JSON under 300 B (only a bad secret gets a 401), and errors are
// {ok:false, fix, say} so the judge can speak them. A call whose conversation is not bound to the
// claimed bet gets WRONG_BET plus an audit row.
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { auditLog, bets, voiceSessions } from '@youre-on/db';
import { jcs } from '@youre-on/shared/jcs';
import { MAX_STAKE } from '@youre-on/shared/constants';
import { formatUsd } from '@youre-on/shared/money';
import { Uuid } from '@youre-on/shared/primitives';
import {
  evaluateProposeTerms,
  fitReply,
  hasOdds,
  proposeTermsReply,
  type ProposeEvaluation,
  type ToolReply,
} from '@youre-on/shared/judge/reply';
import { loadUserRefs } from '../bets/snapshot';
import type { AppDeps, AppEnv } from '../context';
import { HttpError } from '../errors';
import { sha256Hex } from '../crypto';
import { onTermsFrozen } from '../judge/camera-checks';
import { lifecycleOf } from '../lock/runtime';
import { newRoundLine } from '@youre-on/shared/judge/market-terms';
import { confirmTerms, isNewRound, persistEvaluation, type ConfirmOptions } from '../lock/terms';
import { realWorldEnabled } from '../markets/quote';
import { realWorldReply } from '../markets/voice-tool';
import { TOOL_SECRET_HEADER, toolSecretOk } from './tool-auth';

/** States in which the judge may (re)propose terms: edits happen before the freeze. */
export const PROPOSABLE_STATES = ['DRAFTING', 'TERMS_PROPOSED'] as const;
/** Dedupe window: the same call (see toolDedupeKey) within it replays the stored reply. */
export const TOOL_DEDUPE_WINDOW_MS = 10_000;
/** `/el/tools/*`: 30/min per conversation. */
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
 * Receives each evaluation after the reply is computed. NOT awaited by the request path (heavy
 * work is asynchronous); errors are logged.
 */
export interface ProposalSink {
  onEvaluated(e: ProposalEvent): Promise<void>;
}

/**
 * The production sink: lock/terms.ts persistEvaluation. Errors are logged by the caller.
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

/** Always HTTP 200, the body fitted under 300 B. */
export const reply = (c: Context<AppEnv>, body: ToolReply) => c.json(fitReply(body), 200);

export const SAY = {
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

/** In-process state of the tool layer (one Fly machine, like http/idempotency.ts). */
export class ToolState {
  private replies = new Map<string, CachedReply>();
  /** bet_id -> {rev, fingerprint of the last valid proposal} (see revision()). */
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
   * bet_id -> the refusal reply. A refusal ends the bet (the sink cancels it), but the sink is not
   * awaited, so until it commits the bet still looks proposable. This map keeps a refused bet
   * refused: a re-worded call on the same bet cannot talk its way past the prefilter.
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

  /**
   * +1 per judge turn that changes the draft; the same proposal keeps its rev. This is the `rev`
   * of the propose_terms reply only: terms.draft numbers its revisions from bet_terms_versions.
   */
  revision(betId: string, fingerprint: string): number {
    const cur = this.revisions.get(betId);
    if (cur && cur.fp === fingerprint) return cur.rev;
    const rev = (cur?.rev ?? 0) + 1;
    this.revisions.set(betId, { rev, fp: fingerprint });
    return rev;
  }
}

/** Dedupe key: sha256(conversation_id ‖ name ‖ JCS(args)). */
export const toolDedupeKey = (conversationId: string, name: string, body: unknown): string =>
  sha256Hex(`${conversationId}\n${name}\n${jcs(body)}`);

/** conversation_id -> the active voice session's bet (the binding check); null = WRONG_BET. */
export async function loadBinding(
  deps: AppDeps,
  conversationId: string,
): Promise<BoundSession | null> {
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

async function partyNames(
  deps: AppDeps,
  s: Pick<BoundSession, 'party_a_id' | 'party_b_id'>,
): Promise<{ a: string; b: string } | undefined> {
  try {
    const refs = await loadUserRefs(deps.db, [s.party_a_id, s.party_b_id]);
    return { a: refs.get(s.party_a_id)!.display_name, b: refs.get(s.party_b_id)!.display_name };
  } catch {
    return undefined;
  }
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
    // Every WRONG_BET writes an audit row; off the reply path, failures only logged.
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

      // A 429 would break the tool contract, so the rate limit answers with a fix.
      try {
        deps.rateLimit?.take('el/tools', conversationId, EL_TOOLS_BUCKET);
      } catch (e) {
        if (e instanceof HttpError && e.code === 'RATE_LIMITED') {
          log('error', { fix: 'SLOW_DOWN', conversation_id: conversationId });
          return reply(c, { ok: false, fix: 'SLOW_DOWN', say: SAY.SLOW_DOWN });
        }
        throw e;
      }

      const now = deps.now();
      const dedupeKey = toolDedupeKey(conversationId, name, body);
      const prior = opts.state.cached(dedupeKey, now);
      if (prior) {
        log('duplicate', { conversation_id: conversationId, bet_id: betId });
        return reply(c, prior);
      }

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
      // A refused bet stays refused (see ToolState.refusedReply). Checked before the state: the
      // sink may already have moved a refused bet to CANCELLED.
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

      const maxStake = deps.env.MAX_STAKE_MICRO ? BigInt(deps.env.MAX_STAKE_MICRO) : MAX_STAKE;
      // real_world (the Gemini BTC 5-minute closer) only when markets/quote.ts realWorldEnabled:
      // the relay is on and real-world bets are allowed.
      const evaluation = evaluateProposeTerms(body, {
        maxStake,
        realWorldEnabled: realWorldEnabled(deps),
      });
      const rev =
        evaluation.kind === 'proposal'
          ? opts.state.revision(betId, sha256Hex(jcs(evaluation.proposal)))
          : undefined;
      // Odds read-back names ("Logan puts in fifteen, Jake puts in five"): one query, odds only.
      const names =
        evaluation.kind === 'proposal' && hasOdds(evaluation.proposal)
          ? await partyNames(deps, session)
          : undefined;
      // real_world: Gemini's split (or its refusal) in the spoken reply (markets/voice-tool.ts).
      const r = realWorldReply(
        deps,
        evaluation,
        proposeTermsReply(evaluation, { rev, maxStake, ...(names ? { names } : {}) }),
      );
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

// ---- confirm_terms ------------------------------------------------------------------------------

const CONFIRM_SAY = {
  NOT_PROPOSED: "Nothing to confirm yet. What's the bet?",
  QUOTE_STALE: "Gemini can't price this round anymore. Let's take the next one.",
  ODDS_PENDING: 'Odds first. Both of you tap Accept on your phones.',
} as const;

/** "Jake has to accept the challenge on their phone first." (fits the 200-char `say`). */
export function invitePendingSay(b: string): string {
  return `${b.slice(0, 40)} has to accept the challenge on their phone first.`;
}

/**
 * "Logan, Jake: hold the button on your own phone to lock it in. Nothing moves until you both do."
 */
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
  o: ConfirmOptions = {},
): Promise<ToolReply> {
  const r = await confirmTerms(deps, betId, o);
  if (!r.ok && r.fix === 'INVITE_PENDING') {
    const b = (await loadUserRefs(deps.db, [r.party_b_id])).get(r.party_b_id);
    return { ok: false, fix: 'INVITE_PENDING', say: invitePendingSay(b?.display_name ?? 'They') };
  }
  if (!r.ok && r.fix === 'ODDS_PENDING')
    return { ok: false, fix: 'ODDS_PENDING', say: CONFIRM_SAY.ODDS_PENDING };
  if (!r.ok && r.fix === 'REQUOTED') {
    // A market quote too old to lock: re-quoted as new terms (terms.proposed already pushed).
    // If the old round stopped pricing, the re-quote is the NEXT round: say so (new line, end).
    const s = r.envelope.terms.stakes;
    const m = r.envelope.terms.market!;
    const split = `${formatUsd(s.a)} against ${formatUsd(s.b)}`;
    const newRound = isNewRound(r);
    return fitReply({
      ok: false,
      fix: 'REQUOTED',
      terms_hash: r.envelope.terms_hash,
      new_round: newRound,
      say: newRound
        ? `That round closed. ${newRoundLine(m)} ${split}. Say yes to lock it.`
        : `Gemini's odds moved: ${split} now. Say yes to lock it.`,
    });
  }
  if (!r.ok && r.fix === 'QUOTE_STALE')
    return {
      ok: false,
      fix: 'QUOTE_STALE',
      reason: r.refusal ?? 'QUOTE_STALE',
      say: CONFIRM_SAY.QUOTE_STALE,
    };
  if (!r.ok) return { ok: false, fix: 'NOT_PROPOSED', say: CONFIRM_SAY.NOT_PROPOSED };
  if (!r.already) {
    lifecycleOf(deps).lock.startInBackground(betId);
    // Camera checks: the frozen terms_hash gets its spec (if not compiled yet), then SAM warms.
    void onTermsFrozen(deps, betId);
  }
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
      if (!conversationId || !betId || conversationId.length > 128) {
        // Every WRONG_BET writes an audit row (off the reply path).
        void deps.db
          .insert(auditLog)
          .values({
            actor_kind: 'judge',
            action: 'el_tool.wrong_bet',
            bet_id: betId && Uuid.safeParse(betId).success ? betId : null,
            request_id: requestId,
            details: {
              tool: name,
              conversation_id: conversationId?.slice(0, 128) ?? null,
              claimed_bet_id: betId?.slice(0, 64) ?? null,
              bound_bet_id: null,
              reason: 'missing_ids',
            },
          })
          .catch((e: unknown) => deps.log.error('el_tool.audit_failed', { err: String(e) }));
        return reply(c, { ok: false, fix: 'WRONG_BET', say: SAY.WRONG_BET });
      }
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
      // B's consent is B's own tap on the invite, never what the judge heard (a spoken "deal"
      // is theatre). With LOCK_SIGNER=server the lock signs B's stake custodially, so
      // freezing before B accepted would spend B's money on A's word. Checked inside the
      // freeze, under the row lock: the binding's bet_state above may already be stale (the
      // propose_terms sink is not awaited). B's later accept sends the judge an [EVENT]
      // INVITE_ACCEPTED line to call this again (bets/invite.ts).
      const r = await confirmAndLock(deps, betId, {
        heard,
        requestId,
        requireInviteAccepted: true,
      });
      // Only a success is replayed: NOT_PROPOSED / INVITE_PENDING may turn into one a second later.
      if (r.ok) opts.state.store(dedupeKey, now, r);
      deps.log.info('el_tool.call', {
        tool: name,
        bet_id: betId,
        ok: r.ok,
        fix: r.fix,
        request_id: requestId,
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
