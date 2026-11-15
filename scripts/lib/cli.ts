// Shared CLI plumbing for the deploy scripts (ESCROW §10.3; TASKS D1-L3/L5/L6).
//
// Every chain script takes:
//   --url <rpc>        RPC URL; default env SOLANA_RPC_URL; no other default (never a hardcoded
//                      QuickNode URL: it embeds an auth token, SETUP-CHECKLIST §5 item 12)
//   --keys-dir <dir>   keypair directory written by scripts/keys.ts (default ~/.config/solana/youre-on)
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';

export const DEFAULT_KEYS_DIR = '~/.config/solana/youre-on';

export const COMMON_OPTIONS = {
  url: { type: 'string' },
  'keys-dir': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies NonNullable<ParseArgsConfig['options']>;

type Options = NonNullable<ParseArgsConfig['options']>;

/** Parses argv with the common options plus `extra`; prints `usage` and exits on --help or a bad flag. */
export function parseCli<const O extends Options>(usage: string, extra: O) {
  const config = {
    args: process.argv.slice(2),
    options: { ...COMMON_OPTIONS, ...extra },
    strict: true,
    allowPositionals: true,
  } as const;
  let parsed: ReturnType<typeof parseArgs<typeof config>>;
  try {
    parsed = parseArgs(config);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${usage}`);
    process.exit(2);
  }
  if ((parsed.values as { help?: boolean }).help) {
    console.log(usage);
    process.exit(0);
  }
  return parsed;
}

/** Expands a leading `~` and resolves against the cwd. */
export function expandPath(p: string): string {
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export function keysDirFrom(flag: string | undefined): string {
  return expandPath(flag ?? DEFAULT_KEYS_DIR);
}

/** `--url`, else env SOLANA_RPC_URL, else exit 2. */
export function rpcUrlFrom(flag: string | undefined): string {
  const url = flag ?? process.env['SOLANA_RPC_URL'];
  if (!url) {
    console.error(
      'no RPC URL: pass --url <rpc> or set SOLANA_RPC_URL (local: http://127.0.0.1:8899)',
    );
    process.exit(2);
  }
  return url;
}

/** Parses a USD amount ("40", "1.5") into 6-dp micro-units. */
export function usdToMicro(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`not a USD amount with <= 6 decimals: ${s}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole ?? '0') * 1_000_000n + BigInt(frac.padEnd(6, '0'));
}

/** 6-dp micro-units as "$12.345678" with trailing zeros trimmed (at least 2 dp). */
export function fmtUsd(micro: bigint): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

export function fmtSol(lamports: bigint): string {
  return `${(Number(lamports) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '')} SOL`;
}

/** Runs `main`, printing an error (with program logs when present) and exiting 1 on failure. */
export function run(main: () => Promise<void>): void {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
      const logs = findLogs(err);
      if (logs) console.error(['program logs:', ...logs].join('\n  '));
      if (process.env['DEBUG'] && err instanceof Error) console.error(err.stack);
      process.exit(1);
    },
  );
}

/** Pulls `logs` out of a kit SolanaError context (preflight / simulation failures), if any. */
export function findLogs(err: unknown): string[] | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const ctx = (e as { context?: { logs?: unknown } }).context;
    if (ctx && Array.isArray(ctx.logs)) return ctx.logs as string[];
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}
