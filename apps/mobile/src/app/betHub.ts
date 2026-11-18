// Holds every bet this phone follows: its BetModel (../bets/store) and its seq state (../net/ws
// sequencer). Realtime events go through ingest() so they apply in seq order; a gap open for
// 2 s, or a reconnect, triggers a REST resync (GET /v1/bets/:id/events?after=lastSeq). Cold start
// and recovery use GET /v1/bets/:id. Listeners get (event, before, after) for every applied event
// so the screens can derive lock-card signals and haptics. Pure TS over an injected API: tested.
import type { BetSnapshot } from '@youre-on/shared/api';
import type { RealtimeEvent } from '@youre-on/shared/realtime';

import { applyBetEvent, emptyBet, fromSnapshot, type BetModel } from '../bets/store';
import { ingest, initialSeq, needsResync, resetTo, type SeqState } from '../net/ws';

export interface BetHubApi {
  getBet(betId: string): Promise<BetSnapshot>;
  getBetEvents(
    betId: string,
    after: number,
  ): Promise<{ events: RealtimeEvent[]; last_seq: number }>;
}

export type BetListener = (
  e: RealtimeEvent | null,
  before: BetModel | null,
  after: BetModel,
) => void;

export class BetHub {
  private models = new Map<string, BetModel>();
  private seqs = new Map<string, SeqState>();
  private listeners = new Set<BetListener>();
  private resyncing = new Set<string>();

  constructor(
    private readonly api: BetHubApi,
    private readonly now: () => number = Date.now,
    private readonly log: (msg: string, extra?: unknown) => void = () => undefined,
  ) {}

  get(betId: string): BetModel | undefined {
    return this.models.get(betId);
  }
  ids(): string[] {
    return [...this.models.keys()];
  }
  lastSeq(betId: string): number {
    return this.seqs.get(betId)?.lastSeq ?? 0;
  }
  has(betId: string): boolean {
    return this.models.has(betId);
  }

  onChange(l: BetListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** One failing listener is logged and skipped: the others, and the bet's state, carry on. */
  private emit(e: RealtimeEvent | null, before: BetModel | null, after: BetModel) {
    for (const l of this.listeners) {
      try {
        l(e, before, after);
      } catch (err) {
        this.log('listener.failed', {
          type: e?.type ?? 'snapshot',
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Forget every bet (the signed-in user changed): nothing of the old user's bets carries over. */
  clear(): void {
    this.models.clear();
    this.seqs.clear();
    this.resyncing.clear();
  }

  /** Start following a bet from a snapshot (POST /v1/bets response, or GET /v1/bets/:id). */
  adopt(s: BetSnapshot): BetModel {
    const before = this.models.get(s.bet_id) ?? null;
    const model = fromSnapshot(s, before ?? undefined);
    const { state, apply } = resetTo(
      this.seqs.get(s.bet_id) ?? initialSeq(),
      s.last_seq,
      this.now(),
    );
    this.seqs.set(s.bet_id, state);
    this.models.set(s.bet_id, model);
    this.emit(null, before, model);
    for (const e of apply) this.applyOne(e);
    return this.models.get(s.bet_id) as BetModel;
  }

  /**
   * Cold start (the app restarted mid-bet): rebuild a bet from its snapshot AND its event log.
   * The snapshot does not carry the facts only events do (who challenged, the invite answer,
   * captions, the armed attempt), so the log is folded onto it silently (a replay must not
   * re-fire haptics or lock signals), then the snapshot wins for what it carries (state, my
   * party, terms). Listeners get one change with no event. Without the log (offline, pruned)
   * it is a plain adopt.
   */
  async restore(s: BetSnapshot): Promise<BetModel> {
    let events: RealtimeEvent[] = [];
    try {
      events = (await this.api.getBetEvents(s.bet_id, 0)).events;
    } catch (err) {
      this.log('restore.events_failed', {
        betId: s.bet_id,
        err: err instanceof Error ? err.message : String(err),
      });
      // The one event-only fact a screen cannot do without is who challenged (B's invite):
      // always party A, the caller of POST /v1/bets. The invite answer stays unknown (null),
      // so B is asked again; a repeated accept is a no-op on the server.
      const m = this.adopt(s);
      if (m.challenger === null) this.patch(s.bet_id, (x) => ({ ...x, challenger: s.party_a }));
      return this.models.get(s.bet_id) as BetModel;
    }
    const before = this.models.get(s.bet_id) ?? null;
    const ordered = [...events].sort((x, y) => x.seq - y.seq);
    let model = fromSnapshot(s, before ?? undefined);
    for (const e of ordered) if (e.seq <= s.last_seq) model = applyBetEvent(model, e);
    model = fromSnapshot(s, model);
    this.models.set(s.bet_id, model);
    const { state } = resetTo(this.seqs.get(s.bet_id) ?? initialSeq(), s.last_seq, this.now());
    this.seqs.set(s.bet_id, state);
    this.emit(null, before, model);
    // Anything newer than the snapshot goes through the sequencer like a live event.
    for (const e of ordered) if (e.seq > s.last_seq) this.push(e);
    return this.models.get(s.bet_id) as BetModel;
  }

  /** Local facts from REST reads (GET /lock, GET /concede) or this phone's own answers. */
  patch(betId: string, f: (m: BetModel) => BetModel): void {
    const before = this.models.get(betId) ?? emptyBet(betId);
    const after = f(before);
    if (after === before) return;
    this.models.set(betId, after);
    this.emit(null, before, after);
  }

  /** One realtime event (bet channel or user channel). */
  push(e: RealtimeEvent): void {
    if (!this.models.has(e.bet_id)) this.models.set(e.bet_id, emptyBet(e.bet_id));
    const { state, apply } = ingest(this.seqs.get(e.bet_id) ?? initialSeq(), e, this.now());
    this.seqs.set(e.bet_id, state);
    for (const a of apply) this.applyOne(a);
  }

  private applyOne(e: RealtimeEvent) {
    const before = this.models.get(e.bet_id) ?? emptyBet(e.bet_id);
    const after = applyBetEvent(before, e);
    this.models.set(e.bet_id, after);
    this.emit(e, before, after);
  }

  /** Call on a timer (~500 ms): resyncs any bet whose gap has been open for 2 s. */
  async tick(): Promise<void> {
    const now = this.now();
    await Promise.all(
      [...this.seqs].filter(([, s]) => needsResync(s, now)).map(([id]) => this.resync(id)),
    );
  }

  /** Fetches the events after lastSeq and feeds them in; falls back to a snapshot on failure. */
  async resync(betId: string): Promise<void> {
    if (this.resyncing.has(betId)) return;
    this.resyncing.add(betId);
    try {
      const after = this.lastSeq(betId);
      const r = await this.api.getBetEvents(betId, after);
      for (const e of [...r.events].sort((x, y) => x.seq - y.seq)) this.push(e);
      // Still a hole (events table pruned, or a dropped event): take the snapshot.
      if (this.lastSeq(betId) < r.last_seq) this.adopt(await this.api.getBet(betId));
    } catch (err) {
      this.log('resync.failed', { betId, err: err instanceof Error ? err.message : String(err) });
      try {
        this.adopt(await this.api.getBet(betId));
      } catch {
        // offline: the next tick or reconnect retries
      }
    } finally {
      this.resyncing.delete(betId);
    }
  }

  /** After a socket reconnect the server replays from after_seq; a REST pass covers its failures. */
  async resyncAll(): Promise<void> {
    await Promise.all(this.ids().map((id) => this.resync(id)));
  }
}
