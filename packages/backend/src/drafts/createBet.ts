/**
 * `create_bet` from an accepted draft (§4.2, §9.4 #2, §12.3 `POST /bets`).
 *
 *   acceptance_audio_hash = sha256("VERDICT/ACCEPT/v1" ‖ u8 P ‖ h_0 ‖ … ‖ h_{P-1})
 *     h_0 = sha256(creator dictation WAV)   (32 zero bytes if typed)
 *     h_i = sha256(sha256(wav_i) ‖ accept_sig_i)
 *
 * The creator signs; the backend adds the fee payer and the oracle (which
 * co-signs to endorse the judges, D-37). The bets service builds the
 * BetView around the returned `{bet, sign}`.
 */
import { randomBytes } from 'node:crypto';
import {
  acceptanceAudioHash,
  bytesToHex,
  concatBytes,
  formatUsd,
  hexToBytes,
  sha256,
  type Program,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import { betAddress, createBetIx, type IxEnv } from '../chain/ixs.js';
import { ApiError } from '../errors.js';
import type { UserRecord } from '../persistence/records.js';
import type { SignPayload } from '../tx/service.js';
import { fromBase64 } from '../util/bytes.js';
import type { DraftService } from './service.js';
import { liveAcceptances, type DraftRecord } from './records.js';

export const FLAG_ACTOR_BOUND = 1;
export const FLAG_AI_JUDGED = 2;

export interface PreparedCreateBet {
  /** Bet PDA (base58) */
  bet: string;
  nonce: bigint;
  draft: DraftRecord;
  program: Program;
  acceptance_audio_hash: string;
  judges: [string, string, string];
  sign: SignPayload;
}

/** Bet flags (§9.2): bit0 any_actor_bound, bit1 ai_judged, bit2 market. */
export function betFlags(p: Program): number {
  if (p.kind === 'ai_judged') return FLAG_AI_JUDGED;
  if (p.kind === 'market') return 4;
  return p.legs.some((l) => l.actor_bound) ? FLAG_ACTOR_BOUND : 0;
}

export function sideBMask(p: Program): number {
  return p.sides.reduce<number>((m, s, i) => (s === 1 ? m | (1 << i) : m), 0);
}

/** §4.2 acceptance_audio_hash from the draft's stored acceptance records. */
export function draftAcceptanceAudioHash(d: DraftRecord, p: Program, walletToUser: (w: string) => string | null): Uint8Array {
  const acc = new Map(liveAcceptances(d).map((a) => [a.user_id, a]));
  const leaves: Uint8Array[] = [d.dictation_sha256 ? hexToBytes(d.dictation_sha256) : new Uint8Array(32)];
  for (let i = 1; i < p.participants.length; i++) {
    const uid = walletToUser(p.participants[i]!);
    const a = uid ? acc.get(uid) : undefined;
    if (!a) throw new ApiError('NOT_ACCEPTED', `participant ${i} has not accepted`);
    leaves.push(sha256(concatBytes(hexToBytes(a.wav_sha256), fromBase64(a.accept_sig_b64))));
  }
  return acceptanceAudioHash(leaves);
}

function randomNonce(): bigint {
  // 63-bit so it is also a safe i64 everywhere; collisions are checked against the chain.
  return randomBytes(8).readBigUInt64LE() & 0x7fff_ffff_ffff_ffffn;
}

export async function prepareCreateBet(ctx: AppContext, drafts: DraftService, user: UserRecord, draftId: string): Promise<PreparedCreateBet> {
  const { d } = drafts.requireDraft(draftId, user.id);
  if (d.creator_user_id !== user.id) throw new ApiError('WRONG_STATE', 'only the creator creates the bet');
  if (d.bet?.status === 'confirmed') throw new ApiError('WRONG_STATE', 'bet already created');
  if (d.status !== 'ready' || !d.program || !d.program_hash) throw new ApiError('DRAFT_INVALID', `draft is ${d.status}`);
  const p = d.program;
  if (p.kind === 'market') throw new ApiError('WRONG_STATE', 'market bets are created through World');
  if (p.participants[0] !== user.wallet) throw new ApiError('WRONG_STATE', 'creator is not participant 0');

  const users = drafts.huddles.users;
  const aah = draftAcceptanceAudioHash(d, p, (w) => users.find((u) => u.wallet === w)?.id ?? null);

  const env: IxEnv = { programId: ctx.chain.programId, mint: ctx.chain.mint, feePayer: ctx.chain.feePayer, oracle: ctx.chain.oracle };
  let nonce = randomNonce();
  for (let i = 0; i < 4 && (await ctx.chain.getBet(betAddress(env, user.wallet, nonce))); i++) nonce = randomNonce();
  const judges = ctx.config.keys.judges.map((k) => k.publicKey) as [string, string, string];
  const stakeEach = BigInt(p.stake_each ?? 0);
  const ix = createBetIx(env, user.wallet, {
    nonce,
    participants: p.participants,
    stakes: p.participants.map(() => stakeEach),
    side_b_mask: sideBMask(p),
    stake_each: stakeEach,
    time_limit_s: p.time_limit_s,
    flags: betFlags(p),
    program_hash: d.program_hash,
    acceptance_audio_hash: bytesToHex(aah),
    judges,
  });
  const bet = betAddress(env, user.wallet, nonce);
  const { sign } = await ctx.txs.request({
    user,
    kind: 'create_bet',
    ixs: [ix],
    summary: `Create bet ${formatUsd(Number(stakeEach))} each`,
    meta: { draft_id: d.id, bet, nonce: nonce.toString(), program_hash: d.program_hash },
  });
  const draft = drafts.drafts.update(d.id, (x) => {
    x.bet = { address: bet, nonce: nonce.toString(), tx_id: sign.tx_id, status: 'pending', program_hash: d.program_hash! };
    x.updated_at_ms = ctx.clock.nowMs();
  });
  return { bet, nonce, draft, program: p, acceptance_audio_hash: bytesToHex(aah), judges, sign };
}
