/**
 * Perception orchestrator (§12.5 BetEnded/TracksPosted triggers, §12.6 step 4):
 *   seal (perception ×2 → … → payload) → post_tracks in ≤ POST_TRACKS_CHUNK
 *   pieces → verify_biometric_proof ×k → run_rules.
 * Every step is resumable from the persisted record and the onchain state
 * (TrackBuffer `written`/`finalized`, `Bet.bio`), so the keeper can pick up
 * after a restart. Failed attempts back off and retry; the perception
 * timeout refund (§9.4 #15) is the liveness backstop.
 */
import {
  BET_STATE,
  biometricWitness,
  evaluate,
  POST_TRACKS_CHUNK,
  RUN_RULES_CU,
  splitPayload,
  TRACKS_FINALIZED,
  VERIFY_BIOMETRIC_CU,
  ZERO_HASH_HEX,
  type BetAccount,
} from '@verdict/engine';
import { postTracksIx, runRulesIx, verifyBiometricProofIx } from '../chain/ixs.js';
import { setComputeUnitLimitIx } from '../chain/programs.js';
import type { AppContext } from '../context.js';
import { fromBase64, fromHex, toBase64 } from '../util/bytes.js';
import { chainBet, ixEnv, loadBetInfo, type BetInfo } from './betInfo.js';
import { biometricVault } from './identity.js';
import { KeyedLock } from './locks.js';
import type { PerceptionRecord, ProofPlan } from './records.js';
import { sealBet } from './seal.js';
import { pinCommittedCalibration, type LifecycleStores } from './stores.js';

export const PERCEPTION_RETRY_BASE_MS = 30_000;
export const PERCEPTION_MAX_ATTEMPTS = 5;
export const BLOB_NS_PERCEPTION = 'perception';
export const sealedBlobKey = (bet: string): string => `${bet}-sealed.json`;

export class PerceptionOrchestrator {
  private readonly lock = new KeyedLock();
  private readonly inflight = new Set<Promise<void>>();
  private readonly retryAt = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly s: LifecycleStores,
  ) {}

  /** Fire-and-forget start (chain triggers must not block the event queue). */
  kick(betId: string): void {
    if (this.lock.busy(betId)) return;
    const p = this.run(betId).catch((e) => this.ctx.log.error({ err: e, bet: betId }, 'perception run failed'));
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Resolves when no run is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  busy(betId: string): boolean {
    return this.lock.busy(betId);
  }

  /** Runs the pipeline for one bet up to `run_rules` (idempotent, resumable). */
  run(betId: string): Promise<void> {
    return this.lock.run(betId, () => this.step(betId));
  }

  private init(betId: string): PerceptionRecord {
    const now = this.ctx.clock.nowMs();
    return {
      bet: betId,
      step: 'pending',
      attempts: 0,
      error: null,
      hosts: [],
      cross: null,
      flags: 0,
      model_hash: null,
      perception_root: ZERO_HASH_HEX,
      window_unavailable: false,
      audio_disagree: false,
      phone_disagree: false,
      payload_b64: null,
      program_len: 0,
      calibration_len: 0,
      n_frames: 0,
      expected: null,
      proofs: [],
      posted_signatures: [],
      run_rules_signature: null,
      started_at_ms: now,
      updated_at_ms: now,
    };
  }

  private save(rec: PerceptionRecord): PerceptionRecord {
    rec.updated_at_ms = this.ctx.clock.nowMs();
    this.s.perception.set(rec.bet, rec);
    return rec;
  }

  private async step(betId: string): Promise<void> {
    const now = this.ctx.clock.nowMs();
    if ((this.retryAt.get(betId) ?? 0) > now) return;
    let bet = await chainBet(this.ctx, betId);
    if (bet.state !== BET_STATE.Perceiving) return;
    const info = loadBetInfo(this.ctx, betId);
    let rec = this.s.perception.get(betId) ?? this.init(betId);
    if (rec.attempts >= PERCEPTION_MAX_ATTEMPTS && rec.error) return;
    try {
      if (rec.step === 'pending' || rec.step === 'failed') rec = await this.seal(info, rec);
      if (rec.step === 'sealed') rec = await this.post(info, rec, bet);
      bet = await chainBet(this.ctx, betId);
      if (rec.step === 'posted') rec = await this.prove(info, rec, bet);
      if (rec.step === 'proved') rec = await this.runRules(info, rec);
      this.retryAt.delete(betId);
    } catch (e) {
      rec.attempts += 1;
      rec.error = e instanceof Error ? e.message : String(e);
      if (rec.step === 'pending') rec.step = 'failed';
      this.save(rec);
      this.retryAt.set(betId, now + PERCEPTION_RETRY_BASE_MS * rec.attempts);
      this.ctx.log.warn({ bet: betId, step: rec.step, err: rec.error, attempts: rec.attempts }, 'perception step failed');
    }
  }

  private async seal(info: BetInfo, rec: PerceptionRecord): Promise<PerceptionRecord> {
    const bet = await this.ctx.chain.getBet(info.id);
    const scene = bet ? pinCommittedCalibration(this.s, info.id, bet.calibration_hash) : this.s.scenes.get(info.id);
    if (bet && info.program.kind === 'rules' && scene?.calibration_hash !== bet.calibration_hash) {
      throw new Error(`committed calibration ${bet.calibration_hash} is unknown to this backend`);
    }
    const sealed = await sealBet(this.ctx, this.s, info, scene?.calibration ?? null);
    if (sealed.sealed) {
      this.ctx.blobs.putBlob(BLOB_NS_PERCEPTION, sealedBlobKey(info.id), new TextEncoder().encode(JSON.stringify(sealed.sealed)));
    }
    return this.save({
      ...rec,
      step: 'sealed',
      error: null,
      hosts: sealed.hosts,
      cross: sealed.cross,
      flags: sealed.flags,
      model_hash: sealed.model_hash,
      perception_root: sealed.perception_root,
      window_unavailable: sealed.window_unavailable,
      audio_disagree: sealed.audio_disagree,
      phone_disagree: sealed.phone_disagree,
      payload_b64: toBase64(sealed.payload),
      program_len: sealed.program_len,
      calibration_len: sealed.calibration_len,
      n_frames: sealed.n_frames,
      expected: sealed.expected,
      proofs: sealed.proofs,
    });
  }

  /** post_tracks chunks from the onchain `written` offset (§9.4 #8). */
  private async post(info: BetInfo, rec: PerceptionRecord, bet: BetAccount): Promise<PerceptionRecord> {
    if (bet.tracks_finalized === TRACKS_FINALIZED) return this.save({ ...rec, step: 'posted' });
    const payload = fromBase64(rec.payload_b64 ?? '');
    const tb = await this.ctx.chain.getTrackBuffer(info.id);
    let offset = tb ? tb.header.written : 0;
    if (tb && (tb.header.payload_len !== payload.length || tb.header.program_len !== rec.program_len || tb.header.calibration_len !== rec.calibration_len)) {
      throw new Error('onchain TrackBuffer layout differs from the sealed payload');
    }
    const env = ixEnv(this.ctx);
    for (;;) {
      const data = payload.slice(offset, offset + POST_TRACKS_CHUNK);
      const finalize = offset + data.length >= payload.length;
      const res = await this.ctx.chain.sendAsBackend([
        postTracksIx(env, info.id, {
          payload_len: payload.length,
          program_len: rec.program_len,
          calibration_len: rec.calibration_len,
          offset,
          data,
          finalize,
          perception_root: finalize ? rec.perception_root : ZERO_HASH_HEX,
        }),
      ]);
      if (res.status !== 'confirmed') throw new Error(`post_tracks @${offset}: ${res.error}`);
      rec.posted_signatures.push(res.signature);
      if (finalize) break;
      offset += data.length;
    }
    return this.save({ ...rec, step: 'posted' });
  }

  /**
   * verify_biometric_proof for every planned checkpoint the engine computes
   * from the posted buffer (§9.4 #13); failures leave the checkpoint
   * unverified (→ IDENTITY Unknown → panel), they never block run_rules.
   */
  private async prove(info: BetInfo, rec: PerceptionRecord, bet: BetAccount): Promise<PerceptionRecord> {
    if (rec.proofs.length > 0) {
      const parts = splitPayload(fromBase64(rec.payload_b64 ?? ''));
      const needed = new Set<string>();
      if (info.program.kind === 'rules' && parts.tracks_bin) {
        const r = evaluate(parts.program_bin, parts.calibration_bin, parts.tracks_bin, []);
        for (const cp of r.checkpoints) needed.add(`${cp.participant}:${cp.frame}`);
      }
      const done = new Set(bet.bio.slice(0, bet.n_bio).map((b) => `${b.participant}:${b.frame}`));
      let attempted = 0;
      let failed = 0;
      for (const plan of rec.proofs) {
        if (plan.status !== 'pending') continue;
        const k = `${plan.participant}:${plan.frame}`;
        if (done.has(k)) plan.status = 'verified';
        else if (!needed.has(k)) {
          plan.status = 'skipped';
          plan.error = 'checkpoint not in the posted buffer';
        } else {
          await this.proveOne(info, bet, plan);
          attempted++;
          if ((plan.status as ProofPlan['status']) === 'failed') failed++;
        }
        this.save(rec);
      }
      if (attempted > 0 && failed === attempted) {
        // Every proof of the bet failed: almost always a misconfiguration (prover/chain/vkey), not bad luck.
        this.ctx.log.error(
          { bet: info.id, failed, prover: this.ctx.providers.prover.name, errors: [...new Set(rec.proofs.map((p) => p.error).filter(Boolean))] },
          'every biometric proof failed; identity checkpoints stay unverified (IDENTITY → panel)',
        );
      }
    }
    return this.save({ ...rec, step: 'proved' });
  }

  private async proveOne(info: BetInfo, bet: BetAccount, plan: ProofPlan): Promise<void> {
    const participant = info.participants[plan.participant];
    try {
      if (!participant?.user_id) throw new Error('participant has no user');
      const profile = await this.ctx.chain.getProfile(participant.wallet);
      const commit = plan.modality === 'face' ? profile?.face_commit : profile?.voice_commit;
      if (!commit || commit === ZERO_HASH_HEX) throw new Error(`no ${plan.modality} commitment onchain`);
      const secret = biometricVault(this.ctx).template(participant.user_id, plan.modality);
      if (!secret) throw new Error(`no ${plan.modality} enrollment secret`);
      if (secret.commit !== commit) throw new Error('enrollment secret does not match the onchain commitment');
      const witness = biometricWitness(
        {
          commitment: fromHex(commit, 32),
          bet: info.id,
          evidence_root: fromHex(bet.evidence_root, 32),
          participant_idx: plan.participant,
          frame: plan.frame,
          modality: plan.modality === 'face' ? 0 : 1,
          tau_bps: plan.tau_bps,
        },
        { q: secret.q, salt: secret.salt },
        Int8Array.from(plan.observed),
      );
      const { proof } = await this.ctx.providers.prover.proveBiometric(witness as unknown as Record<string, unknown>);
      const res = await this.ctx.chain.sendAsBackend([
        setComputeUnitLimitIx(VERIFY_BIOMETRIC_CU),
        verifyBiometricProofIx(ixEnv(this.ctx), info.id, participant.wallet, {
          participant: plan.participant,
          modality: plan.modality === 'face' ? 0 : 1,
          frame: plan.frame,
          tau_bps: plan.tau_bps,
          proof_a: proof.a,
          proof_b: proof.b,
          proof_c: proof.c,
        }),
      ]);
      if (res.status !== 'confirmed') throw new Error(`verify_biometric_proof: ${res.error}`);
      plan.status = 'verified';
      plan.signature = res.signature;
      plan.error = null;
    } catch (e) {
      plan.status = 'failed';
      plan.error = e instanceof Error ? e.message : String(e);
      this.ctx.log.warn({ bet: info.id, participant: plan.participant, frame: plan.frame, err: plan.error }, 'biometric proof failed');
    }
  }

  /** run_rules with SetComputeUnitLimit(1.4M) (§3.13, §9.4 #9). */
  private async runRules(info: BetInfo, rec: PerceptionRecord): Promise<PerceptionRecord> {
    const res = await this.ctx.chain.sendAsBackend([setComputeUnitLimitIx(RUN_RULES_CU), runRulesIx(ixEnv(this.ctx), info.id)]);
    if (res.status !== 'confirmed') {
      const bet = await chainBet(this.ctx, info.id);
      if (bet.state !== BET_STATE.Perceiving) return this.save({ ...rec, step: 'ruled' });
      throw new Error(`run_rules: ${res.error}`);
    }
    return this.save({ ...rec, step: 'ruled', run_rules_signature: res.signature, error: null });
  }
}
