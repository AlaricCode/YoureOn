// Printing and comparing the onchain Config (ESCROW §3.1).
import type { Address } from '@solana/kit';

import type { Config } from '@youre-on/shared/escrow-client';

import { fmtUsd } from './cli';

export type WantedConfig = {
  admin?: Address;
  judgeAuthority?: Address;
  appealAuthority?: Address;
  maxStake: bigint;
  appealWindowSecs: number;
  acceptDeadlineSecs: number;
  resolveDeadlineSecs: number;
  appealResolveSecs: number;
  allowedMints?: readonly Address[];
  paused?: boolean;
};

export function printConfig(c: Config): void {
  const rows: [string, string][] = [
    ['admin', c.admin],
    ['judge_authority', c.judgeAuthority],
    ['appeal_authority', c.appealAuthority],
    ['max_stake', `${c.maxStake} (${fmtUsd(c.maxStake)} per side)`],
    ['appeal_window_secs', String(c.appealWindowSecs)],
    ['accept_deadline_secs', String(c.acceptDeadlineSecs)],
    ['resolve_deadline_secs', String(c.resolveDeadlineSecs)],
    ['appeal_resolve_secs', String(c.appealResolveSecs)],
    ['allowed_mints', c.allowedMints.join(', ')],
    ['paused', String(c.paused)],
    ['bump', String(c.bump)],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(22)} ${v}`);
}

/** Human-readable differences between the stored Config and the wanted fields (undefined = skip). */
export function configDiff(c: Config, w: WantedConfig): string[] {
  const out: string[] = [];
  const cmp = (name: string, got: unknown, want: unknown) => {
    if (want !== undefined && String(got) !== String(want)) {
      out.push(`${name}: onchain ${String(got)}, wanted ${String(want)}`);
    }
  };
  cmp('admin', c.admin, w.admin);
  cmp('judge_authority', c.judgeAuthority, w.judgeAuthority);
  cmp('appeal_authority', c.appealAuthority, w.appealAuthority);
  cmp('max_stake', c.maxStake, w.maxStake);
  cmp('appeal_window_secs', c.appealWindowSecs, w.appealWindowSecs);
  cmp('accept_deadline_secs', c.acceptDeadlineSecs, w.acceptDeadlineSecs);
  cmp('resolve_deadline_secs', c.resolveDeadlineSecs, w.resolveDeadlineSecs);
  cmp('appeal_resolve_secs', c.appealResolveSecs, w.appealResolveSecs);
  cmp('allowed_mints', c.allowedMints.join(','), w.allowedMints?.join(','));
  cmp('paused', c.paused, w.paused);
  return out;
}
