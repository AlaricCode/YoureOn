/**
 * Per-bet log of decoded chain events (signature, slot, data) for the
 * Receipt (§12.11): transaction links, payouts and biometric checks. Fed by a
 * "*" trigger on the §12.5 handler, so mock, QuickNode and rpc_ws sources all
 * populate it. Idempotent on (signature, index) like the handler itself.
 */
import type { AppContext } from '../context.js';
import type { ChainEventJson } from '../chain/events.js';
import type { Collection } from '../persistence/store.js';

export const EVENT_LOG_COLLECTION = 'bet_event_log';

export interface LoggedEvent {
  name: string;
  signature: string;
  slot: number;
  index: number;
  data: Record<string, unknown>;
}

export interface BetEventLog {
  bet: string;
  events: LoggedEvent[];
}

export class EventLog {
  readonly col: Collection<BetEventLog>;

  constructor(private readonly ctx: AppContext) {
    this.col = ctx.store.collection<BetEventLog>(EVENT_LOG_COLLECTION);
  }

  register(): void {
    this.ctx.events.on('*', (ev) => this.record(ev));
  }

  record(ev: ChainEventJson): void {
    const bet = typeof ev.data['bet'] === 'string' ? (ev.data['bet'] as string) : null;
    if (!bet) return;
    const entry: LoggedEvent = { name: ev.name, signature: ev.signature, slot: ev.slot, index: ev.index, data: ev.data };
    const cur = this.col.get(bet) ?? { bet, events: [] };
    if (cur.events.some((e) => e.signature === ev.signature && e.index === ev.index)) return;
    cur.events.push(entry);
    this.col.set(bet, cur);
  }

  of(bet: string): LoggedEvent[] {
    return this.col.get(bet)?.events ?? [];
  }

  last(bet: string, name: string): LoggedEvent | undefined {
    return this.of(bet)
      .filter((e) => e.name === name)
      .at(-1);
  }
}
