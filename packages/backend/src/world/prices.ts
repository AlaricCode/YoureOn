/**
 * §11.5 live prices: the backend subscribes to the Gemini price stream for
 * open World bets and for events a composer is looking at (WS topic
 * `world:<event_id>`), and relays
 *   {"type":"world.price","event_id","contract_id","prob_bps","at_ms"}
 * on that topic. A relay for a composer-only event stops after RELAY_TTL_MS
 * without a new subscription; relays for open bets are pinned by the keeper.
 */
import type { AppContext } from '../context.js';
import type { WorldPrice } from '../providers/types.js';

export const RELAY_TTL_MS = 10 * 60_000;

interface Relay {
  unsubscribe: () => void;
  wanted_until_ms: number;
  pinned: boolean;
  latest: Map<string, WorldPrice>;
}

export class PriceRelay {
  private readonly relays = new Map<string, Relay>();

  constructor(private readonly ctx: AppContext) {}

  /** Starts (or refreshes) the relay for an event. */
  want(eventId: string, pinned = false): void {
    const now = this.ctx.clock.nowMs();
    let r = this.relays.get(eventId);
    if (!r) {
      const latest = new Map<string, WorldPrice>();
      let unsubscribe: () => void = () => {};
      r = { unsubscribe, wanted_until_ms: now + RELAY_TTL_MS, pinned, latest };
      this.relays.set(eventId, r);
      try {
        unsubscribe = this.ctx.providers.gemini.subscribePrices(eventId, (p) => this.onPrice(p));
      } catch (e) {
        this.ctx.log.warn({ err: e, eventId }, 'price subscription failed');
      }
      r.unsubscribe = unsubscribe;
    }
    r.wanted_until_ms = Math.max(r.wanted_until_ms, now + RELAY_TTL_MS);
    r.pinned ||= pinned;
  }

  private onPrice(p: WorldPrice): void {
    const r = this.relays.get(p.event_id);
    if (!r) return;
    r.latest.set(p.contract_id, p);
    this.ctx.hub.publish(`world:${p.event_id}`, {
      type: 'world.price',
      event_id: p.event_id,
      contract_id: p.contract_id,
      prob_bps: p.prob_bps,
      at_ms: p.at_ms,
    });
  }

  latest(eventId: string): WorldPrice[] {
    return [...(this.relays.get(eventId)?.latest.values() ?? [])];
  }

  isActive(eventId: string): boolean {
    return this.relays.has(eventId);
  }

  /** Re-pins exactly `pinned` events and drops expired, unpinned relays. */
  gc(pinned: Set<string>): void {
    const now = this.ctx.clock.nowMs();
    for (const id of pinned) this.want(id, true);
    for (const [id, r] of this.relays) {
      r.pinned = pinned.has(id);
      if (!r.pinned && r.wanted_until_ms <= now) {
        r.unsubscribe();
        this.relays.delete(id);
      }
    }
  }

  stopAll(): void {
    for (const r of this.relays.values()) r.unsubscribe();
    this.relays.clear();
  }
}
