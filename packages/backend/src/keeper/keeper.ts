/**
 * §12.6 keeper loop: runs every KEEPER_INTERVAL_S (mock chain: on every
 * mock-clock tick). For each non-terminal bet it sends the first applicable
 * action; all actions are idempotent and a "wrong state" reply counts as done.
 *
 * This module is the scheduler only. TODO(bets/keeper agent): register a task
 * that walks the bets mirror and applies, in order:
 *   1. Market, Funded → start (oracle)
 *   2. Live, rules/ai_judged, now ≥ t0 + time_limit_s·1000 + TAIL_MS → POST /end flow
 *   3. Live, market, all events resolved → end
 *   4. Perceiving → perception → post_tracks chunks → verify_biometric_proof ×k → run_rules (resume)
 *   5. PreRuled, now > consent_deadline + 5 s → consent with authority = oracle
 *   6. Disputed, no booth running → start the booth; when ruled → settle_panel
 *   7. Any §9.4 #15 refund condition → refund
 *   8. Before any payout tx, create missing participant ATAs (idempotent, payer-funded)
 */
import { KEEPER_INTERVAL_S } from '@verdict/engine';
import type { Clock } from '../util/clock.js';
import { ManualClock } from '../util/clock.js';

export interface KeeperTask {
  name: string;
  run(nowMs: number): Promise<void> | void;
}

export interface KeeperOptions {
  clock: Clock;
  log?: { error: (o: unknown, msg?: string) => void };
  /** default KEEPER_INTERVAL_S·1000 */
  intervalMs?: number | undefined;
}

export class Keeper {
  private readonly tasks: KeeperTask[] = [];
  private timer: NodeJS.Timeout | null = null;
  private unsubscribeTick: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  ticks = 0;

  constructor(private readonly opts: KeeperOptions) {}

  register(task: KeeperTask): () => void {
    this.tasks.push(task);
    return () => {
      const i = this.tasks.indexOf(task);
      if (i >= 0) this.tasks.splice(i, 1);
    };
  }

  get taskNames(): string[] {
    return this.tasks.map((t) => t.name);
  }

  /** Starts the loop: a timer, or (ManualClock) every clock tick. */
  start(): void {
    if (this.timer || this.unsubscribeTick) return;
    if (this.opts.clock instanceof ManualClock) {
      this.unsubscribeTick = this.opts.clock.onTick(() => void this.tick());
      return;
    }
    const every = this.opts.intervalMs ?? KEEPER_INTERVAL_S * 1000;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribeTick?.();
    this.unsubscribeTick = null;
  }

  /**
   * Runs every task once, serially. Overlapping calls coalesce: a tick that
   * arrives while one is running schedules exactly one more pass.
   */
  tick(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        this.ticks++;
        const now = this.opts.clock.nowMs();
        for (const t of [...this.tasks]) {
          try {
            await t.run(now);
          } catch (e) {
            this.opts.log?.error({ err: e, task: t.name }, 'keeper task failed');
          }
        }
      } while (this.rerun);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
}
