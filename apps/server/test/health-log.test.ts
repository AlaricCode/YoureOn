// The health log lines (chain/health.ts logHealthReport), no DB: the boot line (chain.boot_health)
// and the keeper's 10-minute line (chain.unhealthy). The judge (LLM) and toggle warnings
// (judge_no_success on every boot until the first judge call, judge_failing, cached_ruling_on)
// stay in the report and every line's warning list, but alone they never make the line a WARN:
// chain.unhealthy means a chain or money-path problem.
import { describe, expect, it } from 'vitest';
import {
  chainNeedsAttention,
  logHealthReport,
  type ChainHealthReport,
  type HealthWarning,
} from '../src/chain/health';
import type { Logger } from '../src/log';

const w = (code: string, level: HealthWarning['level'] = 'warn'): HealthWarning => ({
  code,
  level,
  message: code,
});

/** The fields healthLine reads; the rest of the report does not matter here. */
const report = (warnings: HealthWarning[]): ChainHealthReport =>
  ({
    ok: !warnings.some((x) => x.level === 'critical'),
    warnings,
    fee_payer_sol: 4.2,
    nonce_pool: { size: 5, free: 5, leased: 0, advancing: 0, retired: 0 },
    rpc_stats: null,
    balances: { treasury: null, demo_a: null, demo_b: null },
  }) as unknown as ChainHealthReport;

function recorder() {
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const at =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, msg, fields });
  const log: Logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
  return { log, lines };
}

const JUDGE_ONLY = [w('judge_no_success'), w('judge_failing'), w('cached_ruling_on')];

describe('health log lines: judge warnings alone are not chain.unhealthy', () => {
  for (const warnings of [[JUDGE_ONLY[0]!], [JUDGE_ONLY[1]!], JUDGE_ONLY]) {
    const codes = warnings.map((x) => `warn:${x.code}`);
    it(`${codes.join(' + ')}: no periodic line, an info boot line that still lists them`, () => {
      const r = report(warnings);
      expect(chainNeedsAttention(r)).toBe(false);

      const periodic = recorder();
      logHealthReport(periodic.log, r);
      expect(periodic.lines).toEqual([]);

      const forced = recorder();
      logHealthReport(forced.log, r, { always: true });
      expect(forced.lines.map((l) => [l.level, l.msg])).toEqual([['info', 'chain.healthy']]);
      expect(forced.lines[0]!.fields.warnings).toEqual(codes);

      const boot = recorder();
      logHealthReport(boot.log, r, { boot: true });
      expect(boot.lines.map((l) => [l.level, l.msg])).toEqual([['info', 'chain.boot_health']]);
      expect(boot.lines[0]!.fields.warnings).toEqual(codes);
    });
  }

  it('a chain warning beside them: chain.unhealthy (and a warn boot line) with every code', () => {
    const r = report([w('keeper_off'), ...JUDGE_ONLY]);
    expect(chainNeedsAttention(r)).toBe(true);
    const periodic = recorder();
    logHealthReport(periodic.log, r);
    expect(periodic.lines.map((l) => [l.level, l.msg])).toEqual([['warn', 'chain.unhealthy']]);
    expect(periodic.lines[0]!.fields.warnings).toEqual([
      'warn:keeper_off',
      'warn:judge_no_success',
      'warn:judge_failing',
      'warn:cached_ruling_on',
    ]);
    const boot = recorder();
    logHealthReport(boot.log, r, { boot: true });
    expect(boot.lines.map((l) => [l.level, l.msg])).toEqual([['warn', 'chain.boot_health']]);
  });

  it('a critical warning always counts', () => {
    expect(chainNeedsAttention(report([w('fee_payer_low', 'critical')]))).toBe(true);
    expect(chainNeedsAttention(report([w('judge_failing', 'critical')]))).toBe(true);
  });

  it('no warnings: nothing periodic, chain.healthy when asked, an info boot line', () => {
    const r = report([]);
    expect(chainNeedsAttention(r)).toBe(false);
    const periodic = recorder();
    logHealthReport(periodic.log, r);
    expect(periodic.lines).toEqual([]);
    const boot = recorder();
    logHealthReport(boot.log, r, { boot: true });
    expect(boot.lines.map((l) => [l.level, l.msg])).toEqual([['info', 'chain.boot_health']]);
  });
});
