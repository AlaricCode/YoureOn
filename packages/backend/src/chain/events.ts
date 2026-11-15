/**
 * §12.5 chain event handler. All three sources feed the same entry point:
 *  - mock: the mock chain calls it in-process (no HMAC);
 *  - quicknode: POST /v1/webhooks/quicknode (HMAC, see quicknode.ts);
 *  - rpc_ws: `logsSubscribe` (devnet) → parsed logs.
 * The handler is idempotent on (signature, index): processed keys are
 * persisted in the `chain_events` collection.
 *
 * For every new event it (1) relays WS `chain` to `bet:<id>`, then
 * (2) runs the triggers registered for the event name (service agents
 * register them; the default table below documents what each must do).
 */
import { eventToJson, EVENT_NAMES, type VerdictEventName } from '@verdict/engine';
import type { Collection } from '../persistence/store.js';
import type { WsHub } from '../ws/hub.js';
import type { ChainEventEnvelope } from './types.js';

/** Normalized §12.5 JSON event (decimal strings for u64/i64, hex for hashes). */
export interface ChainEventJson {
  signature: string;
  slot: number;
  block_time: number | null;
  index: number;
  name: VerdictEventName;
  data: Record<string, unknown>;
}

export interface ProcessedEventRecord {
  key: string;
  name: string;
  bet: string | null;
  slot: number;
  at_ms: number;
}

export type ChainTrigger = (ev: ChainEventJson) => void | Promise<void>;

/**
 * §12.5 trigger table (what the service agents must register):
 *   Funded{all_funded}  → notify "Ready"
 *   BetEnded            → start perception
 *   TracksPosted        → submit proofs, then run_rules
 *   PreRuled            → announcer + notify
 *   Disputed            → replay booth
 *   Settled / Refunded  → announcer, leaderboard, close-out
 */
export const TRIGGER_TABLE: Partial<Record<VerdictEventName, string>> = {
  Funded: 'notify "Ready" when all_funded',
  BetEnded: 'start perception',
  TracksPosted: 'submit proofs, then run_rules',
  PreRuled: 'announcer + notify',
  Disputed: 'replay booth',
  Settled: 'announcer, leaderboard, close-out',
  Refunded: 'announcer, leaderboard, close-out',
};

export const eventKey = (signature: string, index: number): string => `${signature}:${index}`;

export interface ChainEventHandlerOptions {
  processed: Collection<ProcessedEventRecord>;
  hub: WsHub | null;
  nowMs: () => number;
  log?: { warn: (o: unknown, msg?: string) => void; error: (o: unknown, msg?: string) => void };
}

export class ChainEventHandler {
  private readonly triggers = new Map<string, ChainTrigger[]>();
  private readonly any: ChainTrigger[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ChainEventHandlerOptions) {}

  /** Registers a trigger for one event name (or "*" for all). */
  on(name: VerdictEventName | '*', t: ChainTrigger): () => void {
    const list = name === '*' ? this.any : (this.triggers.get(name) ?? this.triggers.set(name, []).get(name)!);
    list.push(t);
    return () => {
      const i = list.indexOf(t);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** Typed envelopes from the mock chain / devnet logs. */
  handleEnvelopes(envs: ChainEventEnvelope[]): Promise<number> {
    return this.handle(
      envs.map((e) => {
        const j = eventToJson(e.event);
        return {
          signature: e.signature,
          slot: e.slot,
          block_time: e.block_time,
          index: e.index,
          name: j.name,
          data: j.data as Record<string, unknown>,
        };
      }),
    );
  }

  /**
   * Processes events serially (in arrival order). Returns how many were new.
   * Unknown event names are ignored (still marked processed).
   */
  handle(events: ChainEventJson[]): Promise<number> {
    const run = this.chain.then(() => this.process(events));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Resolves when all queued events have been processed. */
  async idle(): Promise<void> {
    await this.chain;
  }

  private async process(events: ChainEventJson[]): Promise<number> {
    let fresh = 0;
    for (const ev of events) {
      const key = eventKey(ev.signature, ev.index);
      const bet = typeof ev.data['bet'] === 'string' ? (ev.data['bet'] as string) : null;
      if (!this.opts.processed.insert(key, { key, name: ev.name, bet, slot: ev.slot, at_ms: this.opts.nowMs() })) continue;
      fresh++;
      if (!(EVENT_NAMES as readonly string[]).includes(ev.name)) continue;
      if (bet && this.opts.hub) {
        this.opts.hub.publish(`bet:${bet}`, {
          type: 'chain',
          bet_id: bet,
          name: ev.name,
          data: ev.data,
          signature: ev.signature,
          slot: ev.slot,
        });
      }
      for (const t of [...(this.triggers.get(ev.name) ?? []), ...this.any]) {
        try {
          await t(ev);
        } catch (e) {
          this.opts.log?.error({ err: e, event: ev.name, key }, 'chain trigger failed');
        }
      }
    }
    return fresh;
  }
}
