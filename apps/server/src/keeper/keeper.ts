// The keeper: one in-process scheduler for the server's periodic sweeps (ARCHITECTURE §1
// "every timer is a DB row first"; SCHEMAS §9.2 "Deadline sweep: this happens server-side").
// Ported from Verdict packages/backend/src/keeper/keeper.ts (the scheduler idea only: tasks
// register, a pass runs them serially, overlapping passes coalesce). Re-done for this server:
//
//  - Tasks read and write Postgres, never in-memory state, so a restart loses nothing: the
//    first pass after boot catches up on every deadline that passed while the machine was down.
//  - Every task must be safe when two keepers run it at once (two Fly machines during a deploy,
//    or a manual `tick()` racing the timer): lock rows with FOR UPDATE SKIP LOCKED and re-check
//    the condition after the lock (see draft-idle.ts).
//  - The clock is `deps.now` (injectable), passed to each task as `nowMs`.
//  - The timer is a setTimeout chain (interval + random jitter, unref'd), so timer passes never
//    overlap; `stop()` waits for an in-flight pass, so server close() never closes the DB pool
//    under a running sweep.
//
//   const keeper = new Keeper({ now: deps.now, log: deps.log });
//   keeper.register({ name: 'draft-idle', run: (now) => expireIdleDrafts(deps, { now }) });
//   keeper.start();            // server.ts startServer
//   await keeper.stop();       // server.ts close()
import type { Logger } from '../log';

/** Default pass interval: the reconciler cadence (= SCHEMAS `STREAM_FALLBACK_MS`, 5 s). */
export const KEEPER_INTERVAL_MS = 5_000;
/** Default random extra delay per pass, so several keepers don't sweep in lockstep. */
export const KEEPER_JITTER_MS = 1_000;

export interface KeeperTask {
  /** Short kebab-case name, used in logs. */
  name: string;
  /** Minimum ms between two runs of this task (by `now`). Default: every pass. */
  everyMs?: number;
  /** One idempotent sweep. A throw is logged and does not stop the other tasks. */
  run(nowMs: number): Promise<unknown> | unknown;
}

export interface KeeperOptions {
  now: () => number;
  log: Logger;
  /** Default KEEPER_INTERVAL_MS. */
  intervalMs?: number;
  /** Default KEEPER_JITTER_MS; 0 disables jitter. */
  jitterMs?: number;
  /** [0, 1); injectable for tests. Default Math.random. */
  random?: () => number;
}

export class Keeper {
  private readonly tasks: KeeperTask[] = [];
  private readonly lastRun = new Map<KeeperTask, number>();
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly random: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  /** Completed passes (each coalesced re-run counts as one). */
  passes = 0;

  constructor(private readonly opts: KeeperOptions) {
    this.intervalMs = opts.intervalMs ?? KEEPER_INTERVAL_MS;
    this.jitterMs = opts.jitterMs ?? KEEPER_JITTER_MS;
    this.random = opts.random ?? Math.random;
  }

  /** Adds a task; returns its unregister function. */
  register(task: KeeperTask): () => void {
    this.tasks.push(task);
    return () => {
      const i = this.tasks.indexOf(task);
      if (i >= 0) this.tasks.splice(i, 1);
      this.lastRun.delete(task);
    };
  }

  get taskNames(): string[] {
    return this.tasks.map((t) => t.name);
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** The delay before the next timer pass: interval + [0, jitter). */
  nextDelayMs(): number {
    return this.intervalMs + Math.floor(this.random() * this.jitterMs);
  }

  /** Starts the timer chain. The first pass runs after one delay. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule();
    this.opts.log.info('keeper.started', { tasks: this.taskNames, interval_ms: this.intervalMs });
  }

  /** Stops the timer and resolves once any in-flight pass has finished. Idempotent. */
  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.rerun = false;
    await this.inFlight;
  }

  /**
   * Runs every due task once, serially, with one `now`. Overlap guard: a call while a pass is
   * running does not start a second one; it marks exactly one more pass to follow and returns
   * the in-flight promise (which settles after that re-run). Never rejects.
   */
  tick(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    const pass = (async () => {
      try {
        do {
          this.rerun = false;
          await this.runOnce();
          this.passes++;
        } while (this.rerun);
      } finally {
        this.inFlight = null;
      }
    })();
    this.inFlight = pass;
    return pass;
  }

  private async runOnce(): Promise<void> {
    const now = this.opts.now();
    for (const task of [...this.tasks]) {
      const last = this.lastRun.get(task);
      if (task.everyMs !== undefined && last !== undefined && now - last < task.everyMs) continue;
      this.lastRun.set(task, now);
      try {
        await task.run(now);
      } catch (err) {
        this.opts.log.error('keeper.task_failed', { task: task.name, err });
      }
    }
  }

  private schedule(): void {
    // `this.timer` set: a stop() + start() during a pass already scheduled the next one.
    if (!this.started || this.timer) return;
    const t = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule());
    }, this.nextDelayMs());
    t.unref?.();
    this.timer = t;
  }
}
