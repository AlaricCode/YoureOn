// scripts/lib/demo-check.ts: the pitch-morning GO / NO-GO rules over /health, /v1/demo/health and
// the Stream status (pure; the script's I/O is exercised end to end in money-path.test.ts).
import { describe, expect, it } from 'vitest';
import {
  evaluateBasicHealth,
  evaluateDemoHealth,
  evaluateStream,
  formatChecks,
  overall,
  type DemoHealth,
} from '../../../scripts/lib/demo-check';

const NOW = Date.parse('2026-11-20T15:00:00.000Z');

const healthy: DemoHealth = {
  ok: true,
  warnings: [],
  chain_configured: true,
  lock_signer: 'server',
  rpc: 'https://x.quiknode.pro/…',
  fee_payer: 'ADEMopwqe6cVs9cEyMSbK1pGsJgnyBc3zkC3Wsqf9pQ8',
  fee_payer_pinned: true,
  fee_payer_sol: 4.2,
  custodial: { a: 'A1', b: 'B1' },
  nonce_pool: { size: 5, free: 5, leased: 0, advancing: 0, retired: 0 },
  balances: {
    treasury: { address: 'T1', usdc: '120000000' },
    demo_a: { address: 'A1', usdc: '40000000' },
    demo_b: { address: 'B1', usdc: '40000000' },
  },
  rpc_stats: { calls: 80, p50_ms: 120, p95_ms: 400, errors: 0 },
  keeper: { started: true, tasks: [{ name: 'lock-sweep', running_stuck: false }] },
  escrow: { live: 0, orphans: [] },
  stream: { last_delivery_at: null, events_last_hour: 0 },
  markets: { last_ok_at: new Date(NOW - 5_000).toISOString(), last_error: null },
};
const ok = (body: unknown) => ({ status: 200, body });
const byId = (cs: ReturnType<typeof evaluateDemoHealth>) =>
  Object.fromEntries(cs.map((c) => [c.id, c.verdict]));

describe('demo-check: /health', () => {
  it('GO when ok, fast and in sync; NO-GO when unreachable or not ok', () => {
    const go = evaluateBasicHealth(
      { status: 200, ms: 120, body: { ok: true, server_time: new Date(NOW).toISOString() } },
      NOW,
    );
    expect(go.map((c) => c.verdict)).toEqual(['GO', 'GO']);
    expect(evaluateBasicHealth({ error: 'ECONNREFUSED' }, NOW)[0]!.verdict).toBe('NO-GO');
    expect(evaluateBasicHealth({ status: 503, ms: 50, body: null }, NOW)[0]!.verdict).toBe('NO-GO');
  });

  it('slow is WARN; a clock 30 s off is WARN, 2 min off is NO-GO', () => {
    const slow = evaluateBasicHealth({ status: 200, ms: 2_500, body: { ok: true } }, NOW);
    expect(slow[0]!.verdict).toBe('WARN');
    const skew = (ms: number) =>
      evaluateBasicHealth(
        { status: 200, ms: 100, body: { ok: true, server_time: new Date(NOW + ms).toISOString() } },
        NOW,
      )[1]!.verdict;
    expect(skew(30_000)).toBe('WARN');
    expect(skew(-120_000)).toBe('NO-GO');
  });
});

describe('demo-check: /v1/demo/health', () => {
  it('a healthy server is GO across the board', () => {
    const cs = evaluateDemoHealth(ok(healthy), NOW);
    expect(overall(cs)).toBe('GO');
    expect(byId(cs)).toMatchObject({
      'chain.configured': 'GO',
      'chain.fee_payer_sol': 'GO',
      'chain.nonce_pool': 'GO',
      'wallet.demo_a': 'GO',
      'wallet.demo_b': 'GO',
      'wallet.treasury': 'GO',
      'chain.rpc_latency': 'GO',
      'server.keeper': 'GO',
      'chain.escrow': 'GO',
      'server.gemini_relay': 'GO',
    });
  });

  it('flags each money-path problem with a fix', () => {
    const cs = evaluateDemoHealth(
      ok({
        ...healthy,
        fee_payer_sol: 0.05,
        nonce_pool: { size: 5, free: 1, leased: 4, advancing: 0, retired: 0 },
        balances: {
          ...healthy.balances!,
          demo_a: { address: 'A1', usdc: '500000' },
          demo_b: { address: 'B1', usdc: '3000000' },
        },
        rpc_stats: { calls: 50, p50_ms: 900, p95_ms: 5_000, errors: 4 },
        keeper: { started: true, tasks: [{ name: 'timeout-refund', running_stuck: true }] },
        escrow: { live: 2, orphans: [{}] },
        warnings: [{ code: 'txs_stuck', level: 'warn', message: '1 tx sent for > 2 min' }],
      }),
      NOW,
    );
    expect(byId(cs)).toMatchObject({
      'chain.fee_payer_sol': 'NO-GO',
      'chain.nonce_pool': 'WARN',
      'wallet.demo_a': 'NO-GO',
      'wallet.demo_b': 'WARN',
      'chain.rpc_latency': 'NO-GO',
      'server.keeper': 'NO-GO',
      'chain.escrow': 'WARN',
      'server.txs_stuck': 'WARN',
    });
    expect(cs.find((c) => c.id === 'wallet.demo_a')!.fix).toMatch(/rebalance/);
    expect(overall(cs)).toBe('NO-GO');
  });

  it('no key: SKIP; 404: NO-GO with a hint; chain off: NO-GO and nothing else', () => {
    expect(evaluateDemoHealth(null, NOW)[0]!.verdict).toBe('SKIP');
    const nf = evaluateDemoHealth({ status: 404, body: null }, NOW)[0]!;
    expect(nf).toMatchObject({ verdict: 'NO-GO' });
    expect(nf.detail).toMatch(/DEMO_MODE/);
    const off = evaluateDemoHealth(ok({ ...healthy, chain_configured: false }), NOW);
    expect(off).toHaveLength(1);
    expect(off[0]!.verdict).toBe('NO-GO');
  });

  it('the escrow Config: live + matching judge is GO; paused or a judge mismatch is NO-GO', () => {
    const config = {
      address: 'C1',
      paused: false,
      judge_authority: 'J1',
      appeal_window_secs: 10,
      mint_allowed: true,
    };
    const go = evaluateDemoHealth(ok({ ...healthy, judge: 'J1', config }), NOW);
    expect(byId(go)['chain.config']).toBe('GO');
    const paused = evaluateDemoHealth(
      ok({ ...healthy, judge: 'J1', config: { ...config, paused: true } }),
      NOW,
    );
    expect(byId(paused)['chain.config']).toBe('NO-GO');
    const wrong = evaluateDemoHealth(ok({ ...healthy, judge: 'J2', config }), NOW);
    expect(byId(wrong)['chain.config']).toBe('NO-GO');
  });

  it('the build the server reports is printed (which image answers)', () => {
    const build = { image: 'registry.fly.io/youre-on:dep-1', machine: 'm1', region: 'dfw' };
    const cs = evaluateDemoHealth(ok({ ...healthy, build }), NOW);
    expect(cs.find((c) => c.id === 'server.build')).toMatchObject({
      verdict: 'GO',
      detail: 'registry.fly.io/youre-on:dep-1 on m1 (dfw)',
    });
  });

  it('phones + an unpinned fee payer is NO-GO (every lock is refused on device)', () => {
    const cs = evaluateDemoHealth(
      ok({ ...healthy, lock_signer: 'phones', fee_payer_pinned: false }),
      NOW,
    );
    expect(byId(cs)['chain.fee_payer_pinned']).toBe('NO-GO');
  });
});

describe('demo-check: Stream and output', () => {
  it('SKIP without keys; active GO; paused NO-GO', () => {
    expect(evaluateStream(null, null).verdict).toBe('SKIP');
    expect(evaluateStream({ status: 200, body: { status: 'active' } }, null).verdict).toBe('GO');
    expect(evaluateStream({ status: 200, body: { status: 'paused' } }, null).verdict).toBe('NO-GO');
    expect(evaluateStream({ error: 'timeout' }, null).verdict).toBe('WARN');
  });

  it('formatChecks prints one line per check, fixes under non-GO lines, and the verdict', () => {
    const text = formatChecks([
      { id: 'a', verdict: 'GO', detail: 'fine' },
      { id: 'bb', verdict: 'NO-GO', detail: 'broken', fix: 'do X' },
    ]);
    expect(text).toMatch(/^GO {5}a {2,}fine$/m);
    expect(text).toContain('fix: do X');
    expect(text.trim().split('\n').at(-1)).toBe('NO-GO: 1 go, 0 warn, 1 no-go, 0 skipped');
  });
});
