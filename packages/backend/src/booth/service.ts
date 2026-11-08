/**
 * Replay booth orchestrator (§10, §12.6 step 6). Runs when a bet enters
 * Disputed (chain trigger `Disputed`, plus a keeper sweep for anything
 * missed or interrupted):
 *
 *   collecting  exhibits (§10.1) → advocate briefs (§10.2)
 *   judging     3 judges in parallel; commits recorded with timestamps before
 *               any reveal (timeout 120 s ⇒ absent); reveals checked (§10.4)
 *   ruled       2-of-3 among confidence ≥ PANEL_CONF_FLOOR_BPS, else No contest (§10.5)
 *   submitted   payout ATAs ensured, then Ed25519 precompile + settle_panel
 *
 * Every transition is persisted (`booth` collection) and pushed as WS
 * `{"type":"booth","bet_id","booth"}` on `bet:<id>`. Each step resumes from
 * what is already stored, so a restart never repeats a finished step.
 */
import { createHash } from 'node:crypto';
import {
  BET_FLAG_AI_JUDGED,
  BET_FLAG_MARKET,
  BET_STATE,
  JUDGE_COMMIT_TIMEOUT_S,
  PRERULING_WINNER,
  crossCheck,
  splitPayload,
  type BetAccount,
  type BoothRecord,
  type BoothStatus,
  type Exhibit,
  type JudgeCommitRecord,
  type JudgeReveal,
  type PanelOutcome,
  type Program,
} from '@verdict/engine';
import type { AppContext } from '../context.js';
import { settlePanelIx, type IxEnv } from '../chain/ixs.js';
import { createAtaIdempotentIx, ed25519Ix } from '../chain/programs.js';
import { betSources, type BetArtifacts } from '../integration/sources.js';
import { COLLECTIONS } from '../persistence/records.js';
import type { Collection } from '../persistence/store.js';
import type { AdvocateBrief, BoothCase, JudgeProvider } from '../providers/types.js';
import { ExhibitBuilder, betWitnesses, WITNESS_KIND_CODE } from './exhibits.js';
import { JudgeSeat, acceptedReveals, exhibitSlots, panelIxData, rule, validateBrief, validateVote } from './protocol.js';

/** Persisted booth (public §10.5 fields + bookkeeping). */
export interface StoredBooth {
  bet: string;
  status: BoothStatus;
  exhibits: Exhibit[];
  briefs: AdvocateBrief[];
  commits: JudgeCommitRecord[];
  reveals: JudgeReveal[];
  ruling: { outcome: PanelOutcome; votes: [number, number, number] } | null;
  /** judges that sign M (§10.5) */
  signers: [number, number] | null;
  tx_signature: string | null;
  started_at_ms: number;
  updated_at_ms: number;
  last_error: string | null;
}

export interface BoothServiceOptions {
  /** judge commit timeout (default JUDGE_COMMIT_TIMEOUT_S·1000) */
  commitTimeoutMs?: number;
  /** ATAs per ensure-ATA transaction */
  ataBatch?: number;
}

const ATA_BATCH = 3;

export function publicBooth(r: StoredBooth): BoothRecord {
  return {
    status: r.status,
    exhibits: r.exhibits,
    briefs: r.briefs,
    commits: r.commits,
    reveals: r.reveals,
    ruling: r.ruling,
    tx_signature: r.tx_signature,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/** A Program skeleton from the on-chain buffer when no mirror has the AST (judges still need sides/question). */
function skeletonProgram(bet: BetAccount, ifTrue: 0 | 1, elseSide: 0 | 1): Program {
  const P = bet.n_participants;
  const participants = bet.participants.slice(0, P);
  const sides = participants.map((_, i) => ((bet.side_b_mask >> i) & 1) as 0 | 1);
  const kind = bet.flags & BET_FLAG_AI_JUDGED ? 'ai_judged' : bet.flags & BET_FLAG_MARKET ? 'market' : 'rules';
  return {
    version: 2,
    kind,
    participants,
    sides,
    entities: [],
    legs: [],
    outcome: { if_true: ifTrue, condition: { op: 'yes' }, else: elseSide },
    time_limit_s: bet.time_limit_s,
  } as unknown as Program;
}

export class BoothService {
  readonly records: Collection<StoredBooth>;
  private readonly inflight = new Map<string, Promise<StoredBooth | null>>();
  /** judge commit timeout (ms); adjustable (tests, ops) */
  commitTimeoutMs: number;
  private readonly ataBatch: number;

  constructor(
    private readonly ctx: AppContext,
    opts: BoothServiceOptions = {},
  ) {
    this.records = ctx.store.collection<StoredBooth>(COLLECTIONS.booth);
    this.commitTimeoutMs = opts.commitTimeoutMs ?? JUDGE_COMMIT_TIMEOUT_S * 1000;
    this.ataBatch = opts.ataBatch ?? ATA_BATCH;
  }

  get(bet: string): StoredBooth | undefined {
    return this.records.get(bet);
  }

  /** Wires the `Disputed` trigger and the keeper sweep (§12.5, §12.6 step 6). */
  register(): void {
    this.ctx.events.on('Disputed', (ev) => {
      const bet = ev.data['bet'];
      if (typeof bet === 'string') void this.ensure(bet);
    });
    this.ctx.keeper.register({ name: 'booth', run: () => this.sweep() });
  }

  /** Keeper: resumes every unfinished booth and starts missed ones. */
  async sweep(): Promise<void> {
    const bets = new Set<string>();
    for (const r of this.records.values()) if (r.status !== 'submitted') bets.add(r.bet);
    for (const e of this.ctx.store.collection<{ name: string; bet: string | null }>(COLLECTIONS.chainEvents).values()) {
      if (e.name === 'Disputed' && e.bet && this.records.get(e.bet)?.status !== 'submitted') bets.add(e.bet);
    }
    for (const b of bets) await this.ensure(b);
  }

  /** Runs (or resumes) the booth for one bet; single-flight per bet. */
  ensure(bet: string): Promise<StoredBooth | null> {
    const running = this.inflight.get(bet);
    if (running) return running;
    const p = this.run(bet)
      .catch((e: unknown) => {
        this.ctx.log.error({ err: e, bet }, 'booth failed');
        if (this.records.has(bet)) this.save(bet, { last_error: (e as Error).message ?? String(e) });
        return this.records.get(bet) ?? null;
      })
      .finally(() => this.inflight.delete(bet));
    this.inflight.set(bet, p);
    return p;
  }

  private save(bet: string, patch: Partial<StoredBooth>, publish = false): StoredBooth {
    const rec = this.records.update(bet, (r) => ({ ...r, ...patch, updated_at_ms: this.ctx.clock.nowMs() }));
    if (publish) this.ctx.hub.publish(`bet:${bet}`, { type: 'booth', bet_id: bet, booth: publicBooth(rec) });
    return rec;
  }

  private async run(betId: string): Promise<StoredBooth | null> {
    const bet = await this.ctx.chain.getBet(betId);
    if (!bet) return null;
    let rec = this.records.get(betId);
    if (bet.state !== BET_STATE.Disputed) return rec ?? null;
    if (!rec) {
      const now = this.ctx.clock.nowMs();
      rec = {
        bet: betId,
        status: 'collecting',
        exhibits: [],
        briefs: [],
        commits: [],
        reveals: [],
        ruling: null,
        signers: null,
        tx_signature: null,
        started_at_ms: now,
        updated_at_ms: now,
        last_error: null,
      };
      this.records.set(betId, rec);
      this.ctx.hub.publish(`bet:${betId}`, { type: 'booth', bet_id: betId, booth: publicBooth(rec) });
    }

    const src = betSources(this.ctx);
    const artifacts = await src.artifacts(betId, bet);
    const buffer = await this.ctx.chain.getTrackBuffer(betId);

    if (rec.status === 'collecting' || rec.status === 'judging') {
      if (rec.exhibits.length === 0) {
        const exhibits = await new ExhibitBuilder({
          betId,
          bet,
          buffer,
          artifacts,
          witnessMeta: src.witnesses(betId),
          perception: src.perception(betId),
          chunks: (k) => src.chunks(betId, k),
          loadBody: (k, i) => this.ctx.blobs.getChunk(betId, k, i),
          store: (eid, bytes) => this.ctx.blobs.putExhibit(betId, eid, bytes),
          transcribe: (wav) => this.ctx.providers.stt.transcribe(wav),
          rerun: () => this.rerun(betId, bet, artifacts),
          log: this.ctx.log,
        }).build();
        rec = this.save(betId, { exhibits }, true);
      }
      const bcase = this.boothCase(betId, bet, artifacts, buffer, rec.exhibits);
      if (rec.briefs.length < 2) {
        rec = this.save(betId, { briefs: await this.briefs(bet, bcase, rec.exhibits) }, true);
      }
      const ruled = await this.judge(betId, bet, bcase, rec);
      rec = ruled;
    }

    if (rec.status === 'ruled') rec = await this.settle(betId, bet, rec);
    return rec;
  }

  private boothCase(betId: string, bet: BetAccount, a: BetArtifacts | null, buffer: Awaited<ReturnType<AppContext['chain']['getTrackBuffer']>>, exhibits: Exhibit[]): BoothCase {
    let program = a?.program ?? null;
    if (!program) {
      let ifTrue: 0 | 1 = 0;
      let elseSide: 0 | 1 = 1;
      try {
        if (buffer) {
          const dp = splitPayload(buffer.payload.subarray(0, buffer.header.written)).program.program;
          ifTrue = dp.if_true as 0 | 1;
          elseSide = dp.else_side as 0 | 1;
        }
      } catch {
        /* keep defaults */
      }
      program = skeletonProgram(bet, ifTrue, elseSide);
    }
    const winnerSide =
      bet.preruling === PRERULING_WINNER && bet.winner_mask !== 0 ? (((bet.winner_mask & bet.side_b_mask) !== 0 ? 1 : 0) as 0 | 1) : null;
    const ai = (bet.flags & BET_FLAG_AI_JUDGED) !== 0;
    return {
      bet: betId,
      program,
      readback: a?.readback ?? [],
      preruling: bet.preruling,
      preruling_side: winnerSide,
      reason: bet.dispute_reason,
      ai_judged: ai,
      question: (program as Program & { question?: string }).question ?? null,
      transcript: a?.transcript ?? '',
      exhibits: exhibits.map((e) => ({ id: e.id, kind: e.kind, witness: e.witness, t_start_ms: e.t_start_ms, t_end_ms: e.t_end_ms })),
      exhibitBytes: (id) => (exhibits.some((e) => e.id === id) ? this.ctx.blobs.getExhibit(betId, id) : null),
    };
  }

  private async briefs(bet: BetAccount, c: BoothCase, exhibits: Exhibit[]): Promise<AdvocateBrief[]> {
    const src = betSources(this.ctx);
    const meta = src.witnesses(c.bet);
    const witnesses = betWitnesses(bet);
    const participants = bet.participants.slice(0, bet.n_participants);
    const sideOf = (wallet: string): 0 | 1 | null => {
      const i = participants.indexOf(wallet);
      return i < 0 ? null : (((bet.side_b_mask >> i) & 1) as 0 | 1);
    };
    const users = this.ctx.store.collection<{ id: string; wallet: string }>(COLLECTIONS.users);
    const sideHasCamera = (side: 0 | 1) =>
      witnesses.some((w) => {
        if (w.kind !== WITNESS_KIND_CODE.camera) return false;
        const m = meta.find((x) => x.witness_key === w.key);
        const wallet = m?.user_id ? users.get(m.user_id)?.wallet : undefined;
        return wallet !== undefined && sideOf(wallet) === side;
      });
    const labels = witnesses.map((w) => w.label);
    const out: AdvocateBrief[] = [];
    for (const side of [0, 1] as const) {
      const slots = exhibitSlots(sideHasCamera(side));
      let raw: unknown = null;
      try {
        raw = await this.ctx.providers.advocate.brief(c, side, slots);
      } catch (e) {
        this.ctx.log.warn({ err: e, bet: c.bet, side }, 'advocate failed; empty brief');
      }
      out.push(validateBrief(raw, side, slots, exhibits, labels));
    }
    return out;
  }

  /** Commit phase → reveal phase → ruling. */
  private async judge(betId: string, bet: BetAccount, c: BoothCase, rec: StoredBooth): Promise<StoredBooth> {
    rec = this.save(betId, { status: 'judging', commits: [], reveals: [], ruling: null, signers: null }, true);
    const cited = new Set(rec.briefs.flatMap((b) => b.exhibits));
    const judgeCase: BoothCase = {
      ...c,
      exhibits: c.exhibits.filter((e) => cited.has(e.id) || e.kind === 'program' || e.kind === 'flags'),
    };
    const judges: JudgeProvider[] = this.ctx.providers.judges;
    const seats: (JudgeSeat | null)[] = [null, null, null];
    const commits: JudgeCommitRecord[] = [];
    await Promise.all(
      judges.map(async (jp, j) => {
        const vote = validateVote(await withTimeout(Promise.resolve().then(() => jp.judge(judgeCase, rec.briefs, j)), this.commitTimeoutMs));
        if (!vote) {
          this.ctx.log.warn({ bet: betId, judge: j }, 'judge absent (no valid commit before the timeout)');
          return;
        }
        const seat = new JudgeSeat(betId, j, vote);
        seats[j] = seat;
        commits.push({ judge: j, commit: seat.commit, at_ms: this.ctx.clock.nowMs() });
      }),
    );
    commits.sort((a, b) => a.judge - b.judge);
    // All commits are recorded (persisted + published) before any reveal is requested.
    rec = this.save(betId, { commits }, true);
    const revealed = seats.filter((s): s is JudgeSeat => s !== null).map((s) => s.reveal());
    const reveals = acceptedReveals(betId, rec.commits, revealed);
    const ruling = rule(reveals);
    return this.save(
      betId,
      { reveals, ruling: { outcome: ruling.outcome, votes: ruling.votes }, signers: ruling.signers, status: 'ruled' },
      true,
    );
  }

  private env(): IxEnv {
    const ch = this.ctx.chain;
    return { programId: ch.programId, mint: ch.mint, feePayer: ch.feePayer, oracle: ch.oracle };
  }

  /** §12.6 step 8 then the Ed25519 + settle_panel transaction. */
  private async settle(betId: string, bet: BetAccount, rec: StoredBooth): Promise<StoredBooth> {
    if (!rec.ruling || !rec.signers) return rec;
    const env = this.env();
    const participants = bet.participants.slice(0, bet.n_participants);
    for (let i = 0; i < participants.length; i += this.ataBatch) {
      const ixs = participants.slice(i, i + this.ataBatch).map((p) => createAtaIdempotentIx(env.feePayer, p, env.mint));
      const r = await this.ctx.chain.sendAsBackend(ixs);
      if (r.status === 'failed') return this.save(betId, { last_error: `ensure ATAs: ${r.error}` });
    }
    const { data } = panelIxData({
      programId: env.programId,
      bet: betId,
      outcome: rec.ruling.outcome,
      evidenceRoot: bet.evidence_root,
      programHash: bet.program_hash,
      betJudges: bet.judges,
      keys: this.ctx.config.keys.judges,
      signers: rec.signers,
    });
    const r = await this.ctx.chain.sendAsBackend([ed25519Ix(data), settlePanelIx(env, betId, participants, { outcome: rec.ruling.outcome })]);
    if (r.status === 'confirmed') return this.save(betId, { status: 'submitted', tx_signature: r.signature, last_error: null }, true);
    // A bet that is no longer Disputed (refunded on timeout, or settled elsewhere) needs nothing more.
    const now = await this.ctx.chain.getBet(betId);
    this.ctx.log.warn({ bet: betId, error: r.error, state: now?.state }, 'settle_panel failed');
    return this.save(betId, { last_error: `settle_panel: ${r.error}` });
  }

  /** Dispute reason 3: fresh perception pair + cross-check (mock re-runs are free). */
  private async rerun(betId: string, bet: BetAccount, a: BetArtifacts | null): Promise<unknown | null> {
    if (!a || a.program.kind !== 'rules') return null;
    const cam = betWitnesses(bet).find((w) => w.kind === WITNESS_KIND_CODE.camera);
    const chunks = cam ? betSources(this.ctx).chunks(betId, cam.key) : [];
    const seed = createHash('sha256').update(`rerun:${betId}`).digest().readUInt32LE(0);
    const res = await this.ctx.providers.perception.runPair({
      bet: betId,
      program: a.program,
      calibration: a.calibration,
      offset_ms: 0,
      video_urls: chunks.map((ch) => ({
        index: ch.index,
        url: `${this.ctx.config.publicUrl}/v1/bets/${betId}/chunks/${ch.witness_key}/${ch.index}`,
        sha256: ch.body_sha256,
        start_ms: ch.start_ms,
        duration_ms: ch.duration_ms,
        body_format: ch.body_format === 'mjpeg' ? 'mjpeg' : 'mp4',
      })),
      prompts: a.program.entities.filter((e) => e.kind === 'object').map((e) => ({ entity: e.name, phrase: (e as { phrase?: string }).phrase ?? e.name })),
      need_pose: false,
      need_reid: false,
      seed,
    });
    const hosts = [res.a.host, res.b.host].map((h, i) => ({ ...h, network: [res.a, res.b][i]!.network, model_hash: [res.a, res.b][i]!.model_hash }));
    if (!res.a.session || !res.b.session) return { hosts, cross_check: null, note: 'hosts returned raw detections only' };
    const cc = crossCheck(res.a.session, res.b.session, a.program, a.calibration);
    return { hosts, cross_check: cc, tracks: { n_frames: res.a.session.n_frames, flags: res.a.session.flags } };
  }
}
