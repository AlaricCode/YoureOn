import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHECKS, REQUIRED_CHECK_IDS, type CheckId } from '../catalog';
import {
  buildReport,
  CheckTimeoutError,
  confirmResult,
  describeError,
  runCheck,
  summarize,
  type CheckResults,
} from '../runner';

const fixedClock = () => new Date('2026-11-13T22:00:00.000Z');

function counter(step = 5) {
  let t = 0;
  return () => (t += step);
}

describe('runCheck', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes with the body detail and the elapsed time', async () => {
    const r = await runCheck(async () => 'ok detail', { now: counter(7), clock: fixedClock });
    expect(r).toEqual({
      status: 'pass',
      detail: 'ok detail',
      ms: 7,
      at: '2026-11-13T22:00:00.000Z',
    });
  });

  it('turns a thrown Error into a fail with its message', async () => {
    const r = await runCheck(
      async () => {
        throw new Error('no face found');
      },
      { now: counter(), clock: fixedClock },
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toBe('no face found');
    expect(r.ms).toBe(5);
  });

  it('catches a synchronous throw from the body', async () => {
    const r = await runCheck((() => {
      throw new Error('sync boom');
    }) as () => Promise<string>);
    expect(r).toMatchObject({ status: 'fail', detail: 'sync boom' });
  });

  it('includes a native error code', async () => {
    const e = Object.assign(new Error('Keychain error'), { code: 'ERR_KEY_CHAIN' });
    const r = await runCheck(async () => {
      throw e;
    });
    expect(r.detail).toBe('[ERR_KEY_CHAIN] Keychain error');
  });

  it('reports a confirm body as awaiting-confirm, then resolves it', async () => {
    const r = await runCheck(async () => ({ confirm: 'felt it?' }), {
      now: counter(),
      clock: fixedClock,
    });
    expect(r.status).toBe('awaiting-confirm');
    expect(confirmResult(r, true, fixedClock)).toEqual({
      status: 'pass',
      detail: 'felt it? | confirmed by user',
      ms: 5,
      at: '2026-11-13T22:00:00.000Z',
    });
    expect(confirmResult(r, false).status).toBe('fail');
  });

  it('fails a body that never settles once the timeout passes', async () => {
    vi.useFakeTimers();
    const p = runCheck(() => new Promise<string>(() => {}), { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.status).toBe('fail');
    expect(r.detail).toBe(new CheckTimeoutError(1000).message);
  });

  it('clears its timer when the body settles first', async () => {
    vi.useFakeTimers();
    await runCheck(async () => 'fast', { timeoutMs: 60_000 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('describeError', () => {
  it('handles non-Error values', () => {
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    expect(describeError(undefined)).toBe('undefined');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeError(cyclic)).toBe('[object Object]');
  });
});

describe('summarize', () => {
  it('is all pending with no results', () => {
    const s = summarize({});
    expect(s.requiredTotal).toBe(8);
    expect(s.requiredPassed).toBe(0);
    expect(s.pending).toEqual(REQUIRED_CHECK_IDS);
    expect(s.allRequiredGreen).toBe(false);
  });

  it('is green only when every required check passed; extras do not count', () => {
    const results: CheckResults = {};
    for (const id of REQUIRED_CHECK_IDS) results[id] = { status: 'pass', detail: '' };
    results['wallet'] = { status: 'fail', detail: 'extra failed' };
    expect(summarize(results)).toMatchObject({
      requiredPassed: 8,
      failed: [],
      pending: [],
      allRequiredGreen: true,
    });
  });

  it('lists failed and pending required checks separately', () => {
    const results: CheckResults = {
      'tflite-warmup': { status: 'fail', detail: 'x' },
      haptics: { status: 'awaiting-confirm', detail: 'y' },
      'secure-store-rw': { status: 'pass', detail: 'z' },
    };
    const s = summarize(results);
    expect(s.failed).toEqual(['tflite-warmup']);
    expect(s.pending).toContain('haptics');
    expect(s.pending).not.toContain('secure-store-rw');
    expect(s.requiredPassed).toBe(1);
    expect(s.allRequiredGreen).toBe(false);
  });
});

describe('buildReport', () => {
  it('lists every check in catalog order with rounded timings', () => {
    const report = buildReport(
      { 'local-auth-hardware': { status: 'pass', detail: 'hasHardware=true', ms: 12.345 } },
      { os: 'ios 26.1' },
      fixedClock,
    );
    expect(report.kind).toBe('youreon.diagnostics.v1');
    expect(report.at).toBe('2026-11-13T22:00:00.000Z');
    expect(report.os).toBe('ios 26.1');
    expect(report.checks.map((c) => c.id)).toEqual(CHECKS.map((c) => c.id));
    const la = report.checks.find((c) => c.id === ('local-auth-hardware' satisfies CheckId));
    expect(la).toEqual({
      id: 'local-auth-hardware',
      required: true,
      status: 'pass',
      detail: 'hasHardware=true',
      ms: 12.3,
    });
    expect(report.checks.find((c) => c.id === 'haptics')).toMatchObject({
      status: 'idle',
      ms: null,
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
