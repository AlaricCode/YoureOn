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
//  - A task that runs past its `timeoutMs` (default 60 s; RPC calls are time-boxed, so this means
//    something is badly stuck) is logged and the pass moves on to the next task: one hung sweep
//    never stalls the others. The stuck run is left to finish on its own and the task is skipped
//    until it does, so a task never overlaps itself.
//  - `status()` reports per-task runs / failures / timeouts / last error and the recent errors
//    (GET /v1/demo/health).
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
/** Default soft timeout of one task run. */
export const KEEPER_TASK_TIMEOUT_MS = 60_000;
/** How many recent task errors status() keeps. */
export const KEEPER_RECENT_ERRORS = 20;
/** stop() waits at most this long for task runs that already timed out. */
export const KEEPER_STOP_GRACE_MS = 5_000;

export interface KeeperTask {
  /** Short kebab-case name, used in logs. */
  name: string;
  /** Minimum ms between two runs of this task (by `now`). Default: every pass. */
  everyMs?: number;
  /** Soft timeout of one run (default KEEPER_TASK_TIMEOUT_MS): the pass stops waiting for it. */
  timeoutMs?: number;
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
  /** Default soft timeout for tasks without their own `timeoutMs`. */
  taskTimeoutMs?: number;
}

export interface KeeperTaskStatus {
  name: string;
  runs: number;
  failures: number;
  timeouts: number;
  /** A run that timed out is still going (the task is skipped until it settles). */
  running_stuck: boolean;
  last_started_at: string | null;
  last_ok_at: string | null;
  last_ms: number | null;
  last_error_at: string | null;
  last_error: string | null;
}

export interface KeeperStatus {
  started: boolean;
  passes: number;
  last_pass_at: string | null;
  tasks: KeeperTaskStatus[];
  /** Newest first. */
  recent_errors: Array<{ task: string; at: string; error: string }>;
}

interface TaskStats {
  runs: number;
  failures: number;
  timeouts: number;
  lastStartedAt: number | null;
  lastOkAt: number | null;
  lastMs: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

const errText = (err: unknown): string =>
  String((err as Error)?.message ?? err)
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 200);

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
  private readonly taskTimeoutMs: number;
  /** Runs that outlived their timeout and are still going (skipped until they settle). */
  private readonly stuck = new Map<KeeperTask, Promise<void>>();
  private readonly stats = new Map<KeeperTask, TaskStats>();
  private readonly recentErrors: Array<{ task: string; at: number; error: string }> = [];
  private lastPassAt: number | null = null;
  /** Completed passes (each coalesced re-run counts as one). */
  passes = 0;

  constructor(private readonly opts: KeeperOptions) {
    this.intervalMs = opts.intervalMs ?? KEEPER_INTERVAL_MS;
    this.jitterMs = opts.jitterMs ?? KEEPER_JITTER_MS;
    this.random = opts.random ?? Math.random;
    this.taskTimeoutMs = opts.taskTimeoutMs ?? KEEPER_TASK_TIMEOUT_MS;
  }

  /** Adds a task; returns its unregister function. */
  register(task: KeeperTask): () => void {
    this.tasks.push(task);
    return () => {
      const i = this.tasks.indexOf(task);
      if (i >= 0) this.tasks.splice(i, 1);
      this.lastRun.delete(task);
      this.stats.delete(task);
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

  /**
   * Stops the timer and resolves once any in-flight pass has finished (and runs that already
   * timed out have settled, or KEEPER_STOP_GRACE_MS passed). Idempotent.
   */
  async stop(graceMs = KEEPER_STOP_GRACE_MS): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.rerun = false;
    await this.inFlight;
    if (this.stuck.size) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.stuck.values()]),
        new Promise<void>((r) => (t = setTimeout(r, graceMs))),
      ]);
      clearTimeout(t);
    }
  }

  /** Per-task health for GET /v1/demo/health (JSON-safe). */
  status(): KeeperStatus {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      started: this.started,
      passes: this.passes,
      last_pass_at: iso(this.lastPassAt),
      tasks: this.tasks.map((t) => {
        const s = this.statsOf(t);
        return {
          name: t.name,
          runs: s.runs,
          failures: s.failures,
          timeouts: s.timeouts,
          running_stuck: this.stuck.has(t),
          last_started_at: iso(s.lastStartedAt),
          last_ok_at: iso(s.lastOkAt),
          last_ms: s.lastMs,
          last_error_at: iso(s.lastErrorAt),
          last_error: s.lastError,
        };
      }),
      recent_errors: [...this.recentErrors]
        .reverse()
        .map((e) => ({ task: e.task, at: new Date(e.at).toISOString(), error: e.error })),
    };
  }

  private statsOf(task: KeeperTask): TaskStats {
    let s = this.stats.get(task);
    if (!s) {
      s = {
        runs: 0,
        failures: 0,
        timeouts: 0,
        lastStartedAt: null,
        lastOkAt: null,
        lastMs: null,
        lastErrorAt: null,
        lastError: null,
      };
      this.stats.set(task, s);
    }
    return s;
  }

  private noteError(task: KeeperTask, at: number, error: string): void {
    const s = this.statsOf(task);
    s.lastErrorAt = at;
    s.lastError = error;
    this.recentErrors.push({ task: task.name, at, error });
    if (this.recentErrors.length > KEEPER_RECENT_ERRORS) this.recentErrors.shift();
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
      if (this.stuck.has(task)) continue; // its timed-out run is still going
      const last = this.lastRun.get(task);
      if (task.everyMs !== undefined && last !== undefined && now - last < task.everyMs) continue;
      this.lastRun.set(task, now);
      await this.runTask(task, now);
    }
    this.lastPassAt = this.opts.now();
  }

  /** One run with the soft timeout; never rejects. */
  private async runTask(task: KeeperTask, now: number): Promise<void> {
    const s = this.statsOf(task);
    const t0 = Date.now();
    s.runs++;
    s.lastStartedAt = now;
    let settled = false;
    const run = (async () => {
      try {
        await task.run(now);
        s.lastOkAt = this.opts.now();
      } catch (err) {
        s.failures++;
        this.noteError(task, this.opts.now(), errText(err));
        this.opts.log.error('keeper.task_failed', { task: task.name, err });
      } finally {
        settled = true;
        s.lastMs = Date.now() - t0;
        this.stuck.delete(task);
      }
    })();
    const timeoutMs = task.timeoutMs ?? this.taskTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      run.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), timeoutMs);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (timedOut && !settled) {
      s.timeouts++;
      this.stuck.set(task, run);
      this.noteError(task, this.opts.now(), `timed out after ${timeoutMs} ms`);
      this.opts.log.error('keeper.task_timeout', { task: task.name, timeout_ms: timeoutMs });
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
