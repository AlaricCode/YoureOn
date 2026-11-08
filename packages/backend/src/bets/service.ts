/**
 * Bets service (§12.3): `POST /bets` (create_bet from an accepted draft and
 * the `bets` mirror), `GET /bets`, `GET /bets/:id` (BetView), practice,
 * ruling, announcer and leaderboard; WS `bet` snapshots and pushes.
 *
 * World Mode bets (`world_bets`) are created by the World service; their
 * BetView comes from world/view.ts, so list/get delegate to it.
 */
import { BET_STATE, type BetAccount } from '@verdict/engine';
import type { AppContext } from '../context.js';
import { ApiError } from '../errors.js';
import { identityHuddleServices } from '../huddles/services.js';
import { betSources, setBetSources, WORLD_BETS_COLLECTION } from '../integration/sources.js';
import { loadBetInfo, requireMember, type BetInfo } from '../lifecycle/betInfo.js';
import { liveAcceptances } from '../drafts/records.js';
import { COLLECTIONS, type UserRecord } from '../persistence/records.js';
import type { AudioBlob } from '../providers/types.js';
import { worldService } from '../routes/world.js';
import type { SignPayload } from '../tx/service.js';
import { isPubkey } from '../util/bytes.js';
import { leaderboard } from './leaderboard.js';
import { parsePracticeFrames, runPractice } from './practice.js';
import { betMirror, type BetMirrorRecord } from './records.js';
import { announceText, buildRuling, type RulingView } from './ruling.js';
import { settlementFacts } from './settlement.js';
import { buildBetView, stateName, type BetView } from './view.js';

export const BET_STATE_FILTERS = ['proposed', 'funded', 'live', 'perceiving', 'preruled', 'disputed', 'settled', 'refunded'] as const;

interface HuddleLike {
  id: string;
  members: { user_id: string; confirmed: boolean }[];
}

const services = new WeakMap<AppContext, BetsService>();

export function betsService(ctx: AppContext): BetsService {
  let s = services.get(ctx);
  if (!s) {
    s = new BetsService(ctx);
    services.set(ctx, s);
  }
  return s;
}

export class BetsService {
  private registered = false;
  private readonly announceCache = new Map<string, Promise<AudioBlob>>();

  constructor(private readonly ctx: AppContext) {}

  get mirror() {
    return betMirror(this.ctx);
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;
    const { ctx } = this;
    setBetSources(ctx, {
      betView: async (betId, userId) => {
        const rec = this.mirror.get(betId);
        if (!rec) return null;
        return this.viewOf(rec, userId);
      },
    });
    ctx.txs.onConfirmed('create_bet', async (tx) => {
      const bet = tx.meta['bet'];
      if (typeof bet !== 'string' || !this.mirror.has(bet)) return;
      this.mirror.update(bet, (r) => ({ ...r, created: true, updated_at_ms: ctx.clock.nowMs() }));
      await this.push(bet);
    });
    // A BetCreated seen on chain (QuickNode / rpc_ws) also marks it created.
    ctx.events.on('BetCreated', (ev) => {
      const bet = ev.data['bet'];
      if (typeof bet === 'string' && this.mirror.get(bet)?.created === false) {
        this.mirror.update(bet, (r) => ({ ...r, created: true, updated_at_ms: ctx.clock.nowMs() }));
      }
    });
    // Every chain event of a bet refreshes subscribed BetViews (§12.4 `bet`).
    ctx.events.on('*', async (ev) => {
      const bet = ev.data['bet'];
      if (typeof bet === 'string') await this.push(bet);
    });
    ctx.hub.setSnapshotProvider('bet', async (id, userId) => {
      // Bets not (yet) known to the backend: subscribe without a snapshot (chain events are public).
      if (!this.mirror.has(id) && !this.isWorldBet(id)) return [];
      const user = ctx.auth.requireUser(userId);
      return [{ type: 'bet' as const, bet: await this.get(user, id) }];
    });
  }

  /** Pushes the current BetView (per viewer) to `bet:<id>` subscribers. */
  async push(betId: string): Promise<void> {
    if (!isPubkey(betId)) return;
    await this.ctx.hub.publishPerUser(`bet:${betId}`, async (userId) => {
      const user = this.ctx.auth.requireUser(userId);
      return { type: 'bet', bet: await this.get(user, betId) };
    });
  }

  private async viewOf(rec: BetMirrorRecord, userId: string, bet?: BetAccount | null): Promise<BetView> {
    const info = loadBetInfo(this.ctx, rec.id);
    const acct = bet === undefined ? await this.ctx.chain.getBet(rec.id) : bet;
    return buildBetView(this.ctx, rec, info, acct, userId);
  }

  // ---- POST /bets ----------------------------------------------------------------

  /** §8.5 candidates frozen at creation: participants, then other enrolled confirmed huddle members (join order). */
  private candidates(huddleId: string, participantIds: string[]): string[] {
    const h = this.ctx.store.collection<HuddleLike>(COLLECTIONS.huddles).get(huddleId);
    const others = (h?.members ?? [])
      .filter((m) => m.confirmed && !participantIds.includes(m.user_id))
      .map((m) => m.user_id)
      .filter((id) => {
        const u = this.ctx.store.collection<UserRecord>(COLLECTIONS.users).get(id);
        return !!u && (u.enrolled.face || u.enrolled.voice);
      });
    return [...participantIds, ...others].slice(0, 10);
  }

  async create(user: UserRecord, draftId: string): Promise<{ bet: BetView; sign: SignPayload }> {
    const { ctx } = this;
    const prepared = await identityHuddleServices(ctx).createBet(user, draftId);
    const d = prepared.draft;
    const now = ctx.clock.nowMs();
    // A re-request (TX_EXPIRED) picks a new nonce/PDA: drop mirrors of this draft that never reached the chain.
    for (const old of this.mirror.filter((r) => r.draft_id === d.id && !r.created && r.id !== prepared.bet)) {
      if (!(await ctx.chain.getBet(old.id))) this.mirror.delete(old.id);
    }
    const users = ctx.store.collection<UserRecord>(COLLECTIONS.users);
    const participantIds = prepared.program.participants.map((w) => users.find((u) => u.wallet === w)?.id ?? `wallet:${w}`);
    const acc = liveAcceptances(d);
    const rec: BetMirrorRecord = {
      id: prepared.bet,
      bet: prepared.bet,
      draft_id: d.id,
      huddle_id: d.huddle_id,
      creator_user_id: d.creator_user_id,
      kind: prepared.program.kind === 'ai_judged' ? 'ai_judged' : 'rules',
      title: d.title ?? 'Bet',
      program: prepared.program,
      program_hash: d.program_hash!,
      yaml: d.yaml,
      readback: d.readback ?? [],
      labels: d.labels,
      transcript: d.transcript || null,
      nonce: prepared.nonce.toString(),
      acceptance_audio_hash: prepared.acceptance_audio_hash,
      create_tx_id: prepared.sign.tx_id,
      created: false,
      candidate_user_ids: this.candidates(d.huddle_id, participantIds),
      acceptances: [
        { user_id: d.creator_user_id, accepted: true, voice_cos_bps: null },
        ...acc.map((a) => ({ user_id: a.user_id, accepted: true, voice_cos_bps: a.cos_bps })),
      ],
      created_at_ms: now,
      updated_at_ms: now,
    };
    this.mirror.set(rec.id, rec);
    return { bet: await this.viewOf(rec, user.id, null), sign: prepared.sign };
  }

  // ---- GET /bets, GET /bets/:id ------------------------------------------------------

  private isWorldBet(id: string): boolean {
    return this.ctx.store.collection(WORLD_BETS_COLLECTION).has(id);
  }

  /** BetView of any bet the user may see (participant or huddle member). */
  async get(user: UserRecord, betId: string): Promise<BetView> {
    if (!isPubkey(betId)) throw new ApiError('NOT_FOUND', `bet ${betId}`);
    const rec = this.mirror.get(betId);
    if (rec) {
      const info = loadBetInfo(this.ctx, betId);
      requireMember(this.ctx, info, user);
      return buildBetView(this.ctx, rec, info, await this.ctx.chain.getBet(betId), user.id);
    }
    if (this.isWorldBet(betId)) {
      const info = loadBetInfo(this.ctx, betId);
      if (!info.participants.some((p) => p.wallet === user.wallet)) throw new ApiError('NOT_FOUND', `bet ${betId}`);
      return (await worldService(this.ctx).view(betId, user.id)) as BetView;
    }
    throw new ApiError('NOT_FOUND', `bet ${betId}`);
  }

  async list(user: UserRecord, state: string | null): Promise<{ bets: BetView[] }> {
    if (state !== null && !(BET_STATE_FILTERS as readonly string[]).includes(state)) {
      throw new ApiError('WRONG_STATE', `state must be one of ${BET_STATE_FILTERS.join('|')}`, 400);
    }
    const ids = new Set<string>();
    for (const r of this.mirror.values()) if (r.created) ids.add(r.id);
    for (const [id] of this.ctx.store.collection(WORLD_BETS_COLLECTION).entries()) ids.add(id);
    const out: BetView[] = [];
    for (const id of ids) {
      let v: BetView;
      try {
        v = await this.get(user, id);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'NOT_FOUND') continue;
        throw e;
      }
      if (state === null || v.state === state) out.push(v);
    }
    out.sort((a, b) => b.updated_at_ms - a.updated_at_ms || a.id.localeCompare(b.id));
    return { bets: out };
  }

  // ---- practice / ruling / announcer / leaderboard -------------------------------------

  private memberInfo(user: UserRecord, betId: string): BetInfo {
    if (!isPubkey(betId)) throw new ApiError('NOT_FOUND', `bet ${betId}`);
    const info = loadBetInfo(this.ctx, betId);
    if (this.mirror.has(betId)) requireMember(this.ctx, info, user);
    else if (!info.participants.some((p) => p.wallet === user.wallet)) throw new ApiError('NOT_FOUND', `bet ${betId}`);
    return info;
  }

  async practice(user: UserRecord, betId: string, body: Record<string, unknown>) {
    const info = this.memberInfo(user, betId);
    return runPractice(this.ctx, info, parsePracticeFrames(body));
  }

  private async chainBet(betId: string): Promise<BetAccount> {
    const bet = await this.ctx.chain.getBet(betId);
    if (!bet) throw new ApiError('WRONG_STATE', 'bet not created yet');
    return bet;
  }

  async ruling(user: UserRecord, betId: string): Promise<RulingView> {
    const info = this.memberInfo(user, betId);
    const bet = await this.chainBet(betId);
    const buffer = await this.ctx.chain.getTrackBuffer(betId);
    const artifacts = await betSources(this.ctx).artifacts(betId, bet);
    return buildRuling((b) => settlementFacts(this.ctx, b, betId), info, bet, buffer, artifacts?.readback ?? [], user.wallet);
  }

  /** TTS of the verdict (§12.10 announcer), cached per (bet, state, text). */
  async announce(user: UserRecord, betId: string): Promise<AudioBlob> {
    const info = this.memberInfo(user, betId);
    const bet = await this.chainBet(betId);
    if (bet.state < BET_STATE.PreRuled) throw new ApiError('WRONG_STATE', 'no verdict yet');
    const text = announceText(info, bet, settlementFacts(this.ctx, bet, betId));
    const key = `${betId}|${stateName(bet)}|${text}`;
    let p = this.announceCache.get(key);
    if (!p) {
      p = this.ctx.providers.tts.synthesize(text);
      p.catch(() => this.announceCache.delete(key));
      this.announceCache.set(key, p);
    }
    return p;
  }

  leaderboard(user: UserRecord, huddleId: string | null) {
    return leaderboard(this.ctx, user, huddleId);
  }
}
