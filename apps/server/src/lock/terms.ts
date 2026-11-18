// Terms composition and the terms state steps (API-CONTRACT §4.3 propose_terms "Server then",
// confirm_terms; SCHEMAS §2, §3, §9.2; DATA-MODEL §5.7).
//
//   persistEvaluation()  the real ProposalSink body: compose Terms from the judge's proposal plus
//                        the server-owned fields, hash, store a bet_terms_versions row, snapshot the
//                        binding columns + party wallets on the bet, -> TERMS_PROPOSED, push
//                        terms.proposed. Incomplete proposals push terms.draft (state stays
//                        DRAFTING); a refusal cancels the bet (terms.refused, judge.cue REFUSED).
//   confirmTerms()       freeze: the latest version becomes is_final, -> AWAITING_AUTHORIZATIONS
//                        (the bets_guard trigger freezes the binding fields from here). The
//                        caller then starts the LockService.
//
// Gemini (real_world) bets (Beat 6): the binding quote is taken when the terms are composed
// (markets/quote.ts takeBindingQuote, before the row lock: it may refetch Gemini), copied into
// Terms.market, and stored with the bet (gemini_markets, market_snapshots); a quote Gemini
// can't give is a terms.draft issue (NO_MARKET / MARKET_UNFAIR / stake). At confirm, a quote
// older than MARKET_CONFIRM_MAX_AGE_MS is re-quoted as a new version instead of freezing
// (the lock's accept_deadline is unix(quotedAt) + 60 s, so an old quote could never land).
import { and, desc, eq, sql } from 'drizzle-orm';
import { auditLog, bets, betTermsVersions } from '@youre-on/db';
import { ACCEPT_WINDOW_SKILL_SECS, QUOTE_TTL_SECS } from '@youre-on/shared/constants';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import { formatUsd } from '@youre-on/shared/money';
import {
  marketClaim,
  MARKET_CONFIRM_MAX_AGE_MS,
  marketReadback,
  oddsDisplay,
} from '@youre-on/shared/judge/market-terms';
import { readbackSay, type ProposeEvaluation } from '@youre-on/shared/judge/reply';
import type { GuardrailRefusal, TermsDraft, TermsProposal } from '@youre-on/shared/negotiation';
import {
  computeTermsHash,
  Terms,
  termsCode,
  type TermsEnvelope,
  type TermsPresentation,
} from '@youre-on/shared/terms';
import type { BetState } from '@youre-on/shared/bet-state';
import type { AppDeps } from '../context';
import { judgeCue } from '../bets/cues';
import {
  isTemplateClaim,
  MARKET_DEADLINE_AFTER_EXPIRY_MS,
  persistQuote,
  refusalIssue,
  requoteProposal,
  takeBindingQuote,
  type BindingQuote,
} from '../markets/quote';
import { loadUserRefs, type BetRow } from '../bets/snapshot';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import { fanout, iso, lockBet, statePayload, type LifecycleDeps, type Tx } from './common';

/** SCHEMAS §2.2: skill deadline default. */
export const DEFAULT_DEADLINE_MINUTES = 10;
/** States in which a new proposal may replace the draft (SCHEMAS §9.2). */
const PROPOSABLE: readonly BetState[] = ['DRAFTING', 'TERMS_PROPOSED'];

export interface ComposeInput {
  bet: Pick<BetRow, 'id' | 'mint'>;
  a: { pubkey: string; display_name: string };
  b: { pubkey: string; display_name: string };
  proposal: TermsProposal;
  cluster: 'devnet' | 'localnet';
  nowMs: number;
  /** real_world: the binding quote (Terms.market, stakes, deadline = expiry + 10 min). */
  quote?: BindingQuote | undefined;
  /** real_world: write the claim from the quoted contract (the server's template). */
  templateClaim?: boolean | undefined;
}

/** Proposal + server-owned fields -> strictly parsed Terms, its JCS string and terms_hash. */
export function composeTerms(i: ComposeInput) {
  const p = i.proposal;
  const q = i.quote;
  const minutes = p.deadline_minutes ?? DEFAULT_DEADLINE_MINUTES;
  // Whole-second UTC, rounded to the nearest whole minute (SCHEMAS §2.2); market bets end at
  // the contract's expiry + 10 min (whole seconds, as the expiry is).
  const deadline = q
    ? Date.parse(q.ref.expiry) + MARKET_DEADLINE_AFTER_EXPIRY_MS
    : Math.round((i.nowMs + minutes * 60_000) / 60_000) * 60_000;
  return computeTermsHash({
    schema_version: 1,
    bet_id: i.bet.id,
    escrow: { cluster: i.cluster, program_id: ESCROW_ID, mint: i.bet.mint },
    party_a: i.a,
    party_b: i.b,
    type: p.type,
    claim: q && i.templateClaim ? marketClaim(q.ref.expiry, q.ref.eventTicker) : p.claim,
    performer: p.performer,
    yes_party: p.yes_party,
    attempts: p.attempts,
    success_criteria: p.success_criteria,
    failure_criteria: p.failure_criteria,
    edge_cases: p.edge_cases,
    evidence_source: p.evidence_source,
    market: q ? q.ref : null,
    stakes: q ? q.stakes : { a: p.amount, b: p.amount, currency: 'USDC' },
    deadline: new Date(deadline).toISOString(),
    created_at: new Date(i.nowMs).toISOString(),
  });
}

/** The judge-owned view of a Terms (for the read-back template). */
export function proposalOf(t: Terms): TermsProposal {
  return {
    type: t.type,
    claim: t.claim,
    performer: t.performer,
    yes_party: t.yes_party,
    attempts: t.attempts,
    success_criteria: t.success_criteria,
    failure_criteria: t.failure_criteria,
    edge_cases: t.edge_cases,
    evidence_source: t.evidence_source,
    amount: t.stakes.a,
    market_query: null,
    deadline_minutes: null,
  };
}

/** "Jake lands a water bottle flip upright…" -> a ≤ 40-char card title. */
export function titleOf(claim: string): string {
  return claim.length <= 40 ? claim : `${claim.slice(0, 39).trimEnd()}…`;
}

export function presentationOf(t: Terms): TermsPresentation {
  if (t.market)
    return {
      title: titleOf(`Bitcoin ${t.market.side === 'YES' ? 'Up' : 'Down'} in 5 minutes`),
      readback: marketReadback(t, 400),
      stakes_display: `${formatUsd(t.stakes.a)} vs ${formatUsd(t.stakes.b)}`.slice(0, 40),
      odds_display: oddsDisplay(t.stakes.a, t.stakes.b),
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    };
  return {
    title: titleOf(t.claim),
    readback: readbackSay(proposalOf(t)).slice(0, 400),
    stakes_display: `${formatUsd(t.stakes.a)} each`.slice(0, 40),
    odds_display: null,
    party_a_avatar_url: null,
    party_b_avatar_url: null,
  };
}

export function envelopeOf(canonical: string, termsHash: string): TermsEnvelope {
  const terms = Terms.parse(JSON.parse(canonical));
  return { terms, terms_hash: termsHash, presentation: presentationOf(terms) };
}

/** "0586·0f0a" (API-CONTRACT §2.7). */
export const displayCode = (termsHash: string): string => {
  const c = termsCode(termsHash);
  return `${c.slice(0, 4)}·${c.slice(4)}`;
};

/** The latest (or the final) terms version of a bet, as an envelope. */
export async function loadEnvelope(
  db: Pick<Tx, 'select'>,
  betId: string,
  o: { finalOnly?: boolean } = {},
): Promise<{ envelope: TermsEnvelope; version: number; is_final: boolean } | null> {
  const [row] = await db
    .select()
    .from(betTermsVersions)
    .where(
      o.finalOnly
        ? and(eq(betTermsVersions.bet_id, betId), eq(betTermsVersions.is_final, true))
        : eq(betTermsVersions.bet_id, betId),
    )
    .orderBy(desc(betTermsVersions.version))
    .limit(1);
  if (!row) return null;
  return {
    envelope: envelopeOf(row.canonical_json, row.terms_hash),
    version: row.version,
    is_final: row.is_final,
  };
}

export type PersistResult =
  | {
      kind: 'proposed';
      envelope: TermsEnvelope;
      version: number;
      /** real_world: the binding quote's snapshot row and hash. */
      quote?: { snapshot_id: string; snapshot_sha256: string };
    }
  | { kind: 'draft' }
  | { kind: 'refused' }
  | { kind: 'skipped'; reason: string };

/** persistEvaluation's deps: the lifecycle bag, plus the Gemini relay for real_world terms. */
export type TermsDeps = LifecycleDeps & Partial<Pick<AppDeps, 'markets'>>;

/**
 * The real ProposalSink body (voice/tools.ts `termsSink`, and POST /v1/demo/bets/:id/terms).
 * One transaction; events fan out after COMMIT.
 */
export async function persistEvaluation(
  deps: TermsDeps,
  betId: string,
  evaluation: ProposeEvaluation,
  o: {
    requestId?: string;
    source?: string;
    rev?: number;
    /** bet_terms_versions.drafted_by: 'party_a' for typed terms (terms/routes.ts). */
    draftedBy?: 'judge' | 'party_a' | 'party_b';
    /** real_world: a binding quote already taken (POST …/terms/market); else taken here. */
    quote?: BindingQuote;
    /** real_world: the claim is the server's template for the quoted contract. */
    templateClaim?: boolean;
  } = {},
): Promise<PersistResult> {
  if (evaluation.kind === 'invalid') return { kind: 'skipped', reason: 'invalid' };
  // real_world: the binding quote, before the row lock (it may refetch Gemini, <= 2 s).
  let quote = o.quote;
  if (
    !quote &&
    evaluation.kind === 'proposal' &&
    evaluation.missing.length === 0 &&
    evaluation.proposal.type === 'real_world'
  ) {
    const side = evaluation.proposal.market_query?.a_side;
    const q = side
      ? await takeBindingQuote(deps, { amount: evaluation.proposal.amount, side })
      : ({ ok: false, reason: 'MARKET_NOT_OPEN' } as const);
    if (q.ok) quote = q.quote;
    else {
      deps.log.info('terms.market_refused', { bet_id: betId, reason: q.reason });
      evaluation = { kind: 'issue', issue: refusalIssue(q.reason), proposal: evaluation.proposal };
    }
  }
  const now = deps.now();
  const out = await deps.db.transaction(async (tx) => {
    const bet = await lockBet(tx, betId);
    if (!bet) return { res: { kind: 'skipped', reason: 'no_bet' } as PersistResult, bet, envs: [] };
    if (!PROPOSABLE.includes(bet.state))
      return {
        res: { kind: 'skipped', reason: `state ${bet.state}` } as PersistResult,
        bet,
        envs: [],
      };

    if (evaluation.kind === 'refused') {
      const envs = await cancelRefused(tx, bet, evaluation.refusal, now, o.requestId);
      return { res: { kind: 'refused' } as PersistResult, bet, envs };
    }

    const nextVersion = await nextTermsVersion(tx, betId);
    const draft = (
      proposal: Partial<TermsProposal>,
      missing: TermsDraft['missing'],
      issues: TermsDraft['issues'],
    ) =>
      appendBetEvent(tx, {
        bet_id: betId,
        type: 'terms.draft',
        payload: {
          draft: {
            bet_id: betId,
            revision: o.rev ?? nextVersion,
            proposal,
            missing,
            clarifications: [],
            issues,
            updated_at: iso(now),
          },
        },
        now,
      });

    if (evaluation.kind === 'issue') {
      const e = await draft(evaluation.proposal ?? {}, [], [evaluation.issue]);
      return { res: { kind: 'draft' } as PersistResult, bet, envs: [e] };
    }
    if (evaluation.missing.length) {
      const e = await draft(evaluation.proposal, evaluation.missing, []);
      return { res: { kind: 'draft' } as PersistResult, bet, envs: [e] };
    }

    const refs = await loadUserRefs(tx, [bet.party_a_id, bet.party_b_id]);
    const a = refs.get(bet.party_a_id)!;
    const b = refs.get(bet.party_b_id)!;
    let composed: ReturnType<typeof composeTerms>;
    try {
      composed = composeTerms({
        bet,
        a: { pubkey: a.pubkey, display_name: a.display_name },
        b: { pubkey: b.pubkey, display_name: b.display_name },
        proposal: evaluation.proposal,
        cluster: deps.env.SOLANA_CLUSTER,
        nowMs: now,
        quote,
        templateClaim: o.templateClaim,
      });
    } catch (err) {
      deps.log.warn('terms.compose_failed', { bet_id: betId, err });
      const e = await draft(
        evaluation.proposal,
        [],
        [{ code: 'AMBIGUOUS', message: 'the terms did not parse' }],
      );
      return { res: { kind: 'draft' } as PersistResult, bet, envs: [e] };
    }

    await tx.insert(betTermsVersions).values({
      bet_id: betId,
      version: nextVersion,
      schema_version: 1,
      drafted_by: o.draftedBy ?? 'judge',
      source_tool: o.source ?? 'propose_terms',
      canonical_json: composed.canonical,
      terms_hash: composed.terms_hash,
    });
    const envelope: TermsEnvelope = {
      terms: composed.terms,
      terms_hash: composed.terms_hash,
      presentation: presentationOf(composed.terms),
    };
    const market = composed.terms.market;
    const stored = quote && market ? await persistQuote(tx, quote) : null;
    const [row] = await tx
      .update(bets)
      .set({
        state: 'TERMS_PROPOSED',
        terms_hash: composed.terms_hash,
        stake_a: BigInt(composed.terms.stakes.a),
        stake_b: BigInt(composed.terms.stakes.b),
        evidence_source: composed.terms.evidence_source,
        title: envelope.presentation.title,
        // DATA-MODEL §5.6: the wallet snapshot = Terms.party_a/b.pubkey (bets_wallet_snapshot).
        party_a_wallet: composed.terms.party_a.pubkey,
        party_b_wallet: composed.terms.party_b.pubkey,
        // DATA-MODEL §5.16: Terms.market -> columns (null again if a skill bet replaces it).
        gemini_market_id: stored?.marketId ?? null,
        pricing_snapshot_id: stored?.snapshotId ?? null,
        a_position: market ? (market.side === 'YES' ? 'yes' : 'no') : null,
        odds_p: market ? market.priceAtLock : null,
        odds_source: market ? market.priceSource : null,
        quoted_at: market ? new Date(market.quotedAt) : null,
      })
      .where(and(eq(bets.id, betId), eq(bets.version, bet.version)))
      .returning();
    if (!row) throw new Error(`terms: bet ${betId} raced`);
    const envs: BetEventEnvelope[] = [
      await appendBetEvent(tx, {
        bet_id: betId,
        type: 'terms.proposed',
        payload: { envelope },
        now,
      }),
    ];
    if (bet.state !== 'TERMS_PROPOSED')
      envs.push(
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(row, bet.state, null),
          now,
        }),
      );
    const res: PersistResult = { kind: 'proposed', envelope, version: nextVersion };
    if (stored && quote)
      res.quote = { snapshot_id: stored.snapshotId.toString(), snapshot_sha256: quote.sha256 };
    return { res, bet, envs };
  });
  if (out.bet) fanout(deps, out.bet, out.envs);
  return out.res;
}

async function nextTermsVersion(tx: Tx, betId: string): Promise<number> {
  const [r] = await tx
    .select({ v: sql<number>`coalesce(max(${betTermsVersions.version}), 0)::int` })
    .from(betTermsVersions)
    .where(eq(betTermsVersions.bet_id, betId));
  return (r?.v ?? 0) + 1;
}

async function cancelRefused(
  tx: Tx,
  bet: BetRow,
  refusal: GuardrailRefusal,
  now: number,
  requestId?: string,
): Promise<BetEventEnvelope[]> {
  const [row] = await tx
    .update(bets)
    .set({ state: 'CANCELLED', end_reason: 'refused', refusal_category: refusal.category })
    .where(and(eq(bets.id, bet.id), eq(bets.version, bet.version)))
    .returning();
  if (!row) throw new Error(`terms: bet ${bet.id} raced`);
  await tx.insert(auditLog).values({
    actor_kind: 'judge',
    action: 'terms.refused_prefilter',
    bet_id: bet.id,
    request_id: requestId ?? null,
    details: { category: refusal.category },
  });
  return [
    await appendBetEvent(tx, { bet_id: bet.id, type: 'terms.refused', payload: { refusal }, now }),
    await appendBetEvent(tx, {
      bet_id: bet.id,
      type: 'bet.state',
      payload: statePayload(row, bet.state, 'refused'),
      now,
    }),
    await appendBetEvent(tx, {
      bet_id: bet.id,
      type: 'judge.cue',
      payload: judgeCue('REFUSED', { category: refusal.category }, `Say: ${refusal.quip}`),
      now,
    }),
  ];
}

export type ConfirmResult =
  | { ok: true; code: string; envelope: TermsEnvelope; already: boolean }
  | { ok: false; fix: 'NOT_PROPOSED' | 'NOT_FOUND' | 'FROZEN'; state?: BetState }
  /** A market bet's quote was too old to lock: re-quoted as a new version (not frozen). */
  | { ok: false; fix: 'REQUOTED'; envelope: TermsEnvelope }
  /** ...and Gemini could not re-quote it (the terms.draft carries the issue). */
  | { ok: false; fix: 'QUOTE_STALE'; reason: string };

/**
 * A market bet whose quote is older than MARKET_CONFIRM_MAX_AGE_MS is re-quoted (same side and
 * even-money amount) instead of frozen. null = fresh enough (or not a market bet).
 */
async function requoteIfStale(
  deps: TermsDeps,
  betId: string,
  o: { requestId?: string },
): Promise<ConfirmResult | null> {
  const [bet] = await deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
  if (!bet || bet.state !== 'TERMS_PROPOSED' || bet.evidence_source !== 'gemini') return null;
  const latest = await loadEnvelope(deps.db, betId);
  const t = latest?.envelope.terms;
  if (!latest || !t?.market || latest.envelope.terms_hash !== bet.terms_hash) return null;
  const age = deps.now() - Date.parse(t.market.quotedAt);
  if (age <= MARKET_CONFIRM_MAX_AGE_MS) return null;
  deps.log.info('terms.requote', { bet_id: betId, age_ms: age });
  const r = await persistEvaluation(
    deps,
    betId,
    { kind: 'proposal', proposal: requoteProposal(t), missing: [] },
    {
      ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
      source: 'requote',
      draftedBy: 'judge',
      templateClaim: isTemplateClaim(t),
    },
  );
  if (r.kind === 'proposed') return { ok: false, fix: 'REQUOTED', envelope: r.envelope };
  return { ok: false, fix: 'QUOTE_STALE', reason: r.kind === 'skipped' ? r.reason : r.kind };
}

/** confirm_terms step 2: freeze -> AWAITING_AUTHORIZATIONS. The caller starts the lock. */
export async function confirmTerms(
  deps: TermsDeps,
  betId: string,
  o: {
    heard?: string;
    requestId?: string;
    actor?: 'judge' | 'system' | 'user';
    actorUserId?: string;
  } = {},
): Promise<ConfirmResult> {
  const requoted = await requoteIfStale(deps, betId, o);
  if (requoted) return requoted;
  const now = deps.now();
  const out = await deps.db.transaction(async (tx) => {
    const bet = await lockBet(tx, betId);
    if (!bet) return { res: { ok: false, fix: 'NOT_FOUND' } as ConfirmResult, bet, envs: [] };
    if (bet.state !== 'TERMS_PROPOSED') {
      const latest = await loadEnvelope(tx, betId, { finalOnly: true });
      if (latest && bet.terms_hash)
        return {
          res: {
            ok: true,
            code: displayCode(bet.terms_hash),
            envelope: latest.envelope,
            already: true,
          } as ConfirmResult,
          bet,
          envs: [],
        };
      return {
        res: { ok: false, fix: 'NOT_PROPOSED', state: bet.state } as ConfirmResult,
        bet,
        envs: [],
      };
    }
    const latest = await loadEnvelope(tx, betId);
    if (!latest || latest.envelope.terms_hash !== bet.terms_hash)
      return { res: { ok: false, fix: 'NOT_PROPOSED' } as ConfirmResult, bet, envs: [] };
    await tx
      .update(betTermsVersions)
      .set({ is_final: true })
      .where(and(eq(betTermsVersions.bet_id, betId), eq(betTermsVersions.version, latest.version)));
    const [row] = await tx
      .update(bets)
      .set({
        state: 'AWAITING_AUTHORIZATIONS',
        terms_final_at: new Date(latest.envelope.terms.created_at),
        lock_mode: 'atomic',
      })
      .where(and(eq(bets.id, betId), eq(bets.version, bet.version)))
      .returning();
    if (!row) throw new Error(`confirm: bet ${betId} raced`);
    await tx.insert(auditLog).values({
      actor_kind: o.actor ?? 'judge',
      actor_user_id: o.actorUserId ?? null,
      action: 'bet.state_changed',
      bet_id: betId,
      request_id: o.requestId ?? null,
      details: { from: bet.state, to: 'AWAITING_AUTHORIZATIONS', heard: o.heard ?? null },
    });
    const envs = [
      await appendBetEvent(tx, {
        bet_id: betId,
        type: 'bet.state',
        payload: statePayload(row, bet.state, null),
        now,
      }),
    ];
    return {
      res: {
        ok: true,
        code: displayCode(latest.envelope.terms_hash),
        envelope: latest.envelope,
        already: false,
      } as ConfirmResult,
      bet,
      envs,
    };
  });
  if (out.bet) fanout(deps, out.bet, out.envs);
  return out.res;
}

/** The skill accept_deadline argument for a lock built at `nowMs` (SCHEMAS §9.3). */
export const acceptDeadlineFor = (nowMs: number): number =>
  Math.floor(nowMs / 1000) + ACCEPT_WINDOW_SKILL_SECS;

/** The gemini accept_deadline argument: unix(quotedAt) + 60 s (SCHEMAS §8.3, device policy L3). */
export const quoteAcceptDeadline = (quotedAt: string): number =>
  Math.floor(Date.parse(quotedAt) / 1000) + QUOTE_TTL_SECS;
