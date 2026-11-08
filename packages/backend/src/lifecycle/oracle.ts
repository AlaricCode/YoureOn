/**
 * Backend-signed (oracle / fee payer) chain actions of the lifecycle:
 * rolling `commit_evidence`, `end` with the final heads, silence consent,
 * refunds and idempotent payout ATA creation (§7.4, §9.4, §12.6).
 */
import {
  BET_STATE,
  EVIDENCE_COMMIT_INTERVAL_S,
  refundCondition,
  type BetAccount,
} from '@verdict/engine';
import { commitEvidenceIx, consentIx, endIx, refundIx } from '../chain/ixs.js';
import { createAtaIdempotentIx } from '../chain/programs.js';
import type { SendResult } from '../chain/types.js';
import type { AppContext } from '../context.js';
import { ixEnv, type BetInfo } from './betInfo.js';
import { currentHeads } from './evidence.js';
import type { LifecycleStores } from './stores.js';

/** How long `end` waits for every witness's `final` chunk (§12.3 POST /end). */
export const END_FINAL_WAIT_MS = 10_000;
/** §12.6 step 5: silence consent this long after the consent deadline. */
export const CONSENT_GRACE_S = 5n;
/** ATA creations per transaction (keeps payer-funded txs well under 1232 B). */
const ATAS_PER_TX = 4;

export type ActionOutcome = { sent: true; result: SendResult } | { sent: false; reason: string };

export const participantsOf = (bet: BetAccount): string[] => bet.participants.slice(0, bet.n_participants);

/** §12.6 step 8: create missing participant ATAs (idempotent, payer-funded). */
export async function ensurePayoutAtas(ctx: AppContext, bet: BetAccount): Promise<boolean> {
  const owners = participantsOf(bet);
  for (let i = 0; i < owners.length; i += ATAS_PER_TX) {
    const ixs = owners.slice(i, i + ATAS_PER_TX).map((o) => createAtaIdempotentIx(ctx.chain.feePayer, o, bet.mint));
    const r = await ctx.chain.sendAsBackend(ixs);
    if (r.status !== 'confirmed') {
      ctx.log.warn({ bet: bet.creator, error: r.error }, 'payout ATA creation failed');
      return false;
    }
  }
  return true;
}

/** Sends `commit_evidence` with the current heads if the interval elapsed (§7.4). */
export async function commitEvidenceIfDue(
  ctx: AppContext,
  s: LifecycleStores,
  info: BetInfo,
  bet: BetAccount,
  nowMs: number,
  force = false,
): Promise<ActionOutcome> {
  if (bet.state !== BET_STATE.Live || info.program.kind === 'market') return { sent: false, reason: 'not live' };
  const lastS = Number(bet.last_commit_at);
  if (!force && nowMs < (lastS + EVIDENCE_COMMIT_INTERVAL_S) * 1000) return { sent: false, reason: 'not due' };
  const heads = currentHeads(s, info, bet);
  const result = await ctx.chain.sendAsBackend([commitEvidenceIx(ixEnv(ctx), info.id, { seq: bet.evidence_seq + 1, heads })]);
  if (result.status === 'confirmed') {
    const live = s.live.get(info.id);
    if (live) s.live.set(info.id, { ...live, last_commit_ms: nowMs, commits: live.commits + 1 });
  } else {
    ctx.log.warn({ bet: info.id, error: result.error }, 'commit_evidence failed');
  }
  return { sent: true, result };
}

/** Oracle `end` with the final heads (market: heads empty). */
export async function sendEnd(ctx: AppContext, s: LifecycleStores, info: BetInfo, bet: BetAccount): Promise<ActionOutcome> {
  if (bet.state !== BET_STATE.Live) return { sent: false, reason: 'not live' };
  const market = info.program.kind === 'market';
  const heads = market ? [] : currentHeads(s, info, bet);
  const result = await ctx.chain.sendAsBackend([
    endIx(ixEnv(ctx), info.id, ctx.chain.oracle, { seq: market ? bet.evidence_seq : bet.evidence_seq + 1, heads }),
  ]);
  if (result.status === 'confirmed') {
    const live = s.live.get(info.id);
    if (live) s.live.set(info.id, { ...live, ended_at_ms: ctx.clock.nowMs(), end_signature: result.signature });
  } else {
    ctx.log.warn({ bet: info.id, error: result.error }, 'end failed');
  }
  return { sent: true, result };
}

/** §12.6 step 5: PreRuled and past the consent deadline (+5 s) → consent as the oracle. */
export async function silenceConsent(ctx: AppContext, info: BetInfo, bet: BetAccount, nowS: bigint): Promise<ActionOutcome> {
  if (bet.state !== BET_STATE.PreRuled) return { sent: false, reason: 'not preruled' };
  if (nowS <= bet.consent_deadline + CONSENT_GRACE_S) return { sent: false, reason: 'not due' };
  await ensurePayoutAtas(ctx, bet);
  const result = await ctx.chain.sendAsBackend([
    consentIx(ixEnv(ctx), info.id, ctx.chain.oracle, participantsOf(bet), {
      winner_mask: bet.winner_mask,
      evidence_root: bet.evidence_root,
    }),
  ]);
  return { sent: true, result };
}

/** §12.6 step 7: any §9.4 #15 condition → permissionless refund. */
export async function refundIfDue(ctx: AppContext, betId: string, bet: BetAccount, nowS: bigint): Promise<ActionOutcome> {
  const reason = refundCondition(bet, nowS);
  if (reason === null) return { sent: false, reason: 'not refundable' };
  await ensurePayoutAtas(ctx, bet);
  const result = await ctx.chain.sendAsBackend([refundIx(ixEnv(ctx), betId, participantsOf(bet))]);
  if (result.status !== 'confirmed') ctx.log.warn({ bet: betId, error: result.error }, 'refund failed');
  return { sent: true, result };
}
