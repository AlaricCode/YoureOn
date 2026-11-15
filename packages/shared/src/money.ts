// SCHEMAS §1.1 — micro-USDC. A string on the wire; bigint only for arithmetic. No floats.
import { z } from 'zod/v4';
import { CENT, MICRO_PER_USD, U64_MAX } from './constants';

const MICRO_RE = /^(0|[1-9][0-9]{0,19})$/;

/**
 * True iff `s` is a base-10 u64 string. Total (never throws): Zod 4 keeps running later checks
 * after a failed regex, so every BigInt() inside a refinement must be guarded by this.
 */
export const isMicroUsdcString = (s: string): boolean => MICRO_RE.test(s) && BigInt(s) <= U64_MAX;

export const MicroUsdc = z
  .string()
  .regex(MICRO_RE, 'micro-USDC: base-10 integer string')
  .refine((s) => !MICRO_RE.test(s) || BigInt(s) <= U64_MAX, 'exceeds u64');
export type MicroUsdc = z.infer<typeof MicroUsdc>;

export const toMicro = (s: MicroUsdc): bigint => BigInt(s);

export function fromMicro(n: bigint): MicroUsdc {
  if (n < 0n || n > U64_MAX) throw new RangeError('micro-USDC out of u64 range');
  return n.toString();
}

/** Spoken/typed dollars → micro-USDC. Whole cents only: "$5", "5", "5.2", "6.20". */
export function parseUsd(input: string): MicroUsdc {
  const m = /^\$?(0|[1-9][0-9]{0,5})(?:\.([0-9]{1,2}))?$/.exec(input.trim());
  if (!m || m[1] === undefined) throw new Error(`not a dollar amount: ${input}`);
  return fromMicro(BigInt(m[1]) * MICRO_PER_USD + BigInt((m[2] ?? '').padEnd(2, '0')) * CENT);
}

/** "5000000" → "$5", "6200000" → "$6.20", "1234567" → "$1.234567" (sub-cent never appears in UI). */
export function formatUsd(s: MicroUsdc): string {
  const n = BigInt(s);
  const whole = n / MICRO_PER_USD;
  const frac = n % MICRO_PER_USD;
  if (frac === 0n) return `$${whole}`;
  if (frac % CENT === 0n) return `$${whole}.${(frac / CENT).toString().padStart(2, '0')}`;
  return `$${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
}
