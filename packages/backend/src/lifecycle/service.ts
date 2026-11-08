/**
 * Bet-lifecycle service: wires the scene check, fund, start/beacon,
 * evidence, end, perception orchestrator, pre-ruling and consent/dispute into
 * the app (chain triggers §12.5, keeper §12.6, WS §12.4). One instance per
 * AppContext (`lifecycleService(ctx)`).
 */
import {
  BET_STATE,
  refundCondition,
  TAIL_MS,
  type BetAccount,
} from '@verdict/engine';
import type { ChainEventJson } from '../chain/events.js';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';
import { isPubkey } from '../util/bytes.js';
import { betSources, setBetSources } from '../integration/sources.js';
import { chainBet, isBetMember, knownBetIds, loadBetInfo, requireMember, type BetInfo } from './betInfo.js';
import { allWitnessesFinal, trySyncAudioWitness } from './evidence.js';
import { KeyedLock } from './locks.js';
import { startMarket } from './live.js';
import { commitEvidenceIfDue, END_FINAL_WAIT_MS, refundIfDue, sendEnd, silenceConsent } from './oracle.js';
import { PerceptionOrchestrator } from './perception.js';
import type { LiveRecord } from './records.js';
import { SceneStream } from './sceneStream.js';
import { marketEntries } from './seal.js';
import { chunkMetas, perceptionMeta, witnessMetas } from './sources.js';
import { lifecycleStores, type LifecycleStores } from './stores.js';

const TERMINAL = new Set<number>([BET_STATE.Settled, BET_STATE.Refunded]);

const services = new WeakMap<AppContext, LifecycleService>();

/** The lifecycle service of an app context (created on first use). */
export function lifecycleService(ctx: AppContext): LifecycleService {
  let s = services.get(ctx);
  if (!s) {
    s = new LifecycleService(ctx);
    services.set(ctx, s);
  }
  return s;
}

export class LifecycleService {
  readonly s: LifecycleStores;
  readonly perception: PerceptionOrchestrator;
  readonly scene: SceneStream;
  /** serializes chain actions per bet (user requests vs. keeper) */
  readonly lock = new KeyedLock();
  private registered = false;

  constructor(readonly ctx: AppContext) {
    this.s = lifecycleStores(ctx);
    this.perception = new PerceptionOrchestrator(ctx, this.s);
    this.scene = new SceneStream(ctx, this.s);
  }

  /** Registers chain triggers, the keeper task and WS handlers (once). */
  register(): void {
    if (this.registered) return;
    this.registered = true;
    const { ctx } = this;
    ctx.events.on('Funded', (ev) => this.onFunded(ev));
    ctx.events.on('BetEnded', (ev) => this.onEnded(ev));
    ctx.events.on('TracksPosted', (ev) => this.onEnded(ev));
    ctx.events.on('PreRuled', (ev) => this.onPreRuled(ev));
    ctx.keeper.register({ name: 'bet-lifecycle', run: (now) => this.keeperPass(now) });
    // Exact answers for the booth / receipt read seam (integration/sources.ts).
    // Falls back to the previous resolvers for bets this service has no records of.
    const base = betSources(ctx);
    setBetSources(ctx, {
      chunks: (betId, witnessKey) => {
        const mine = chunkMetas(this.s, betId, witnessKey);
        return mine.length > 0 ? mine : base.chunks(betId, witnessKey);
      },
      witnesses: (betId) => (this.s.witnesses.has(betId) ? witnessMetas(this.s, betId) : base.witnesses(betId)),
      perception: (betId) => perceptionMeta(this.s, betId) ?? base.perception(betId),
    });
    ctx.hub.onMessage('scene.frame', (conn, msg) => {
      const info = this.memberBet(msg.bet_id, conn.userId);
      if (info) this.scene.push(info, msg.jpeg_b64);
    });
    ctx.hub.onMessage('recording', (conn, msg) => {
      if (!isPubkey(msg.bet_id)) return;
      const list = this.s.witnesses.get(msg.bet_id);
      const w = list?.witnesses.find((x) => x.witness_key === msg.witness_key);
      if (!list || !w || w.user_id !== conn.userId) return;
      if (w.recording_at_ms === null) {
        w.recording_at_ms = ctx.clock.nowMs();
        this.s.witnesses.set(msg.bet_id, list);
      }
    });
  }

  /** BetInfo if the user may see the bet, else null. */
  private memberBet(betId: string, userId: string): BetInfo | null {
    try {
      const info = loadBetInfo(this.ctx, betId);
      const user = this.ctx.store.collection<UserRecord>(COLLECTIONS.users).get(userId);
      return user && isBetMember(this.ctx, info, user) ? info : null;
    } catch {
      return null;
    }
  }

  // ---- chain triggers (§12.5) ------------------------------------------------------

  private notifyParticipants(betId: string, title: string): void {
    let info: BetInfo;
    try {
      info = loadBetInfo(this.ctx, betId);
    } catch {
      return;
    }
    for (const p of info.participants) if (p.user_id) this.ctx.hub.notify(p.user_id, title, betId);
  }

  private onFunded(ev: ChainEventJson): void {
    if (ev.data['all_funded'] === true) this.notifyParticipants(String(ev.data['bet']), 'Ready');
  }

  private onEnded(ev: ChainEventJson): void {
    const bet = String(ev.data['bet']);
    // Only bets this service started (live record) are perceived here.
    if (isPubkey(bet) && this.s.live.has(bet)) this.perception.kick(bet);
  }

  private onPreRuled(ev: ChainEventJson): void {
    if (Number(ev.data['preruling']) === 1) this.notifyParticipants(String(ev.data['bet']), 'Ruled');
  }

  // ---- end flow ---------------------------------------------------------------------

  /** POST /bets/:id/end: records the request, then ends now if every witness is final. */
  async requestEnd(info: BetInfo, user: UserRecord): Promise<void> {
    requireMember(this.ctx, info, user);
    if (info.program.kind === 'market') throw new ApiError('WRONG_STATE', 'market bets end on resolution');
    await this.lock.run(info.id, async () => {
      const bet = await chainBet(this.ctx, info.id);
      if (bet.state !== BET_STATE.Live) {
        if (bet.state === BET_STATE.Perceiving) return; // already ended
        throw new ApiError('WRONG_STATE', 'bet is not live');
      }
      const live = this.liveRecord(info.id, bet);
      if (live.end_requested_at_ms === null) {
        this.s.live.set(info.id, { ...live, end_requested_at_ms: this.ctx.clock.nowMs(), end_requested_by: user.id });
      }
      await this.maybeEndLocked(info, bet, this.ctx.clock.nowMs());
    });
  }

  /** After a final chunk: end if an end was requested and every witness is final. */
  async onWitnessFinal(info: BetInfo): Promise<void> {
    const live = this.s.live.get(info.id);
    if (!live?.end_requested_at_ms) return;
    await this.lock.run(info.id, async () => {
      const bet = await chainBet(this.ctx, info.id);
      await this.maybeEndLocked(info, bet, this.ctx.clock.nowMs());
    });
  }

  /** Audio body arrived: try to decode the beacon (§7.5). */
  async onAudioBody(info: BetInfo, witnessKey: string): Promise<void> {
    const bet = await this.ctx.chain.getBet(info.id);
    if (bet && bet.beacon_slot > 0n) trySyncAudioWitness(this.ctx, this.s, info, bet, witnessKey);
  }

  private liveRecord(betId: string, bet: BetAccount): LiveRecord {
    return (
      this.s.live.get(betId) ?? {
        bet: betId,
        started_at_ms: Number(bet.started_at) * 1000,
        start_signature: '',
        beacon: null,
        play_on_user_id: null,
        t0_ms: Number(bet.started_at) * 1000,
        end_requested_at_ms: null,
        end_requested_by: null,
        ended_at_ms: null,
        end_signature: null,
        last_commit_ms: null,
        commits: 0,
      }
    );
  }

  /**
   * §12.6 step 2 / POST /end: once requested (or the time limit + tail passed),
   * wait for every witness's final chunk or END_FINAL_WAIT_MS, then `end`.
   */
  private async maybeEndLocked(info: BetInfo, bet: BetAccount, nowMs: number): Promise<boolean> {
    if (bet.state !== BET_STATE.Live || info.program.kind === 'market') return false;
    let live = this.liveRecord(info.id, bet);
    const t0 = live.t0_ms ?? Number(bet.started_at) * 1000;
    if (live.end_requested_at_ms === null && nowMs >= t0 + bet.time_limit_s * 1000 + TAIL_MS) {
      live = { ...live, end_requested_at_ms: nowMs, end_requested_by: 'keeper' };
      this.s.live.set(info.id, live);
    }
    if (live.end_requested_at_ms === null) return false;
    if (!allWitnessesFinal(this.s, info.id) && nowMs < live.end_requested_at_ms + END_FINAL_WAIT_MS) return false;
    const out = await sendEnd(this.ctx, this.s, info, bet);
    return out.sent && out.result.status === 'confirmed';
  }

  // ---- keeper (§12.6) -----------------------------------------------------------------

  /** One keeper pass over every non-terminal bet in the mirror. */
  async keeperPass(nowMs: number): Promise<void> {
    for (const id of knownBetIds(this.ctx)) {
      try {
        await this.lock.run(id, () => this.keeperBet(id, nowMs));
      } catch (e) {
        this.ctx.log.warn({ err: e, bet: id }, 'keeper: bet step failed');
      }
    }
  }

  private async keeperBet(id: string, nowMs: number): Promise<void> {
    const bet = await this.ctx.chain.getBet(id);
    if (!bet || TERMINAL.has(bet.state)) return;
    let info: BetInfo;
    try {
      info = loadBetInfo(this.ctx, id);
    } catch {
      return;
    }
    const nowS = await this.ctx.chain.nowSeconds();
    const refundable = refundCondition(bet, nowS) !== null;
    const market = info.program.kind === 'market';
    /** started by this service (persisted), so Live/Perceiving steps are ours */
    const managed = this.s.live.has(id);
    let acted = false;
    switch (bet.state) {
      case BET_STATE.Funded:
        if (market && !refundable) acted = await startMarket(this.ctx, this.s, id);
        break;
      case BET_STATE.Live:
        if (!managed) break;
        if (market) {
          if ((await marketEntries(this.ctx, info.program)).resolved) {
            const out = await sendEnd(this.ctx, this.s, info, bet);
            acted = out.sent && out.result.status === 'confirmed';
          }
        } else {
          acted = await this.maybeEndLocked(info, bet, nowMs);
          if (!acted) await commitEvidenceIfDue(this.ctx, this.s, info, bet, nowMs);
        }
        break;
      case BET_STATE.Perceiving:
        if (managed && !refundable) {
          this.perception.kick(id);
          acted = true;
        }
        break;
      case BET_STATE.PreRuled: {
        const out = await silenceConsent(this.ctx, info, bet, nowS);
        acted = out.sent && out.result.status === 'confirmed';
        break;
      }
      default:
        break;
    }
    if (!acted && refundable) await refundIfDue(this.ctx, id, bet, nowS);
  }
}
