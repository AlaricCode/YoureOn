// Keeper soft timeouts and status (src/keeper/keeper.ts): a hung task never stalls the other
// sweeps, never overlaps itself, and shows up in status() for GET /v1/demo/health. Pure.
import { describe, expect, it } from 'vitest';
import { Keeper } from '../src/keeper';
import type { Logger } from '../src/log';

function recordingLog(): Logger & { lines: Array<[string, Record<string, unknown> | undefined]> } {
  const lines: Array<[string, Record<string, unknown> | undefined]> = [];
  const at = (msg: string, fields?: Record<string, unknown>) => void lines.push([msg, fields]);
  return { lines, debug: at, info: at, warn: at, error: at };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Keeper soft timeouts', () => {
  it('a hung task times out; the pass goes on; the task is skipped until its run settles', async () => {
    const log = recordingLog();
    const k = new Keeper({ now: () => 1_000, log, taskTimeoutMs: 30 });
    const gate = deferred();
    let hungRuns = 0;
    let afterRuns = 0;
    k.register({
      name: 'hung',
      run: async () => {
        hungRuns++;
        await gate.promise;
      },
    });
    k.register({ name: 'after', run: () => void afterRuns++ });

    await k.tick();
    expect(afterRuns).toBe(1); // not blocked by the hung task
    expect(log.lines.some(([m, f]) => m === 'keeper.task_timeout' && f?.task === 'hung')).toBe(
      true,
    );
    let st = k.status();
    expect(st.tasks.find((t) => t.name === 'hung')).toMatchObject({
      runs: 1,
      timeouts: 1,
      running_stuck: true,
      last_error: 'timed out after 30 ms',
    });
    expect(st.recent_errors[0]).toMatchObject({ task: 'hung' });

    await k.tick(); // still stuck: not started a second time
    expect(hungRuns).toBe(1);
    expect(afterRuns).toBe(2);

    gate.resolve();
    await new Promise((r) => setTimeout(r, 0));
    st = k.status();
    expect(st.tasks.find((t) => t.name === 'hung')!.running_stuck).toBe(false);
    await k.tick();
    expect(hungRuns).toBe(2);
  });

  it('a per-task timeoutMs overrides the default', async () => {
    const k = new Keeper({ now: () => 0, log: recordingLog(), taskTimeoutMs: 10_000 });
    const gate = deferred();
    k.register({ name: 'quick', timeoutMs: 20, run: () => gate.promise });
    const t0 = Date.now();
    await k.tick();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(k.status().tasks[0]!.timeouts).toBe(1);
    gate.resolve();
  });

  it('status(): runs, failures, last ok / error, newest error first; URLs are redacted', async () => {
    let t = 5_000;
    const k = new Keeper({ now: () => t, log: recordingLog() });
    let fail = true;
    k.register({
      name: 'flaky',
      run: () => {
        if (fail) throw new Error('rpc https://x.quiknode.pro/TOKEN/ said no');
      },
    });
    await k.tick();
    fail = false;
    t = 6_000;
    await k.tick();
    const s = k.status();
    expect(s).toMatchObject({ started: false, passes: 2 });
    expect(s.tasks[0]).toMatchObject({
      name: 'flaky',
      runs: 2,
      failures: 1,
      timeouts: 0,
      last_ok_at: new Date(6_000).toISOString(),
      last_error: 'rpc <url> said no',
    });
    expect(s.recent_errors).toHaveLength(1);
    expect(s.last_pass_at).toBe(new Date(6_000).toISOString());
  });

  it('stop() waits for a timed-out run only up to the grace period', async () => {
    const k = new Keeper({ now: () => 0, log: recordingLog(), taskTimeoutMs: 10 });
    const gate = deferred();
    k.register({ name: 'forever', run: () => gate.promise });
    await k.tick();
    const t0 = Date.now();
    await k.stop(50);
    expect(Date.now() - t0).toBeLessThan(1_000);
    gate.resolve();
  });
});
