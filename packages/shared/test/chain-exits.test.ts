// src/chain/exits.ts: the permissionless exit table (ESCROW §5.2, I10 half-open windows) and its
// payouts, shared by scripts/crank.ts and the server's timeout-refund sweep.
import { getAddressDecoder } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  BET_RENT_PAYER_OFFSET,
  exitActionFor,
  exitDeadline,
  exitPayout,
  refundEndReason,
} from '../src/chain/exits';
import { BetStatus, getBetEncoder, Outcome, type Bet } from '../src/chain/generated';

const base = {
  acceptDeadline: 100n,
  resolveDeadline: 200n,
  appealDeadline: 300n,
  appealResolveDeadline: 400n,
  stakeA: 5n,
  outcome: { __option: 'None' } as Bet['outcome'],
};
const at = (status: BetStatus, extra: Partial<typeof base> = {}) => ({ ...base, ...extra, status });

describe('exitActionFor / exitDeadline', () => {
  it('timeout_refund from Open / Locked / Appealed exactly at the deadline (>=), not before', () => {
    for (const [s, d] of [
      [BetStatus.Open, 100n],
      [BetStatus.Locked, 200n],
      [BetStatus.Appealed, 400n],
    ] as const) {
      expect(exitDeadline(at(s))).toBe(d);
      expect(exitActionFor(at(s), d - 1n)).toBeNull();
      expect(exitActionFor(at(s), d)).toBe('timeout_refund');
    }
  });

  it('Resolved: finalize at appeal_deadline; terminal statuses: close_bet', () => {
    expect(exitActionFor(at(BetStatus.Resolved), 299n)).toBeNull();
    expect(exitActionFor(at(BetStatus.Resolved), 300n)).toBe('finalize');
    for (const s of [BetStatus.Settled, BetStatus.Refunded, BetStatus.Cancelled])
      expect(exitActionFor(at(s), 0n)).toBe('close_bet');
    expect(exitDeadline(at(BetStatus.Settled))).toBeNull();
  });

  it('refundEndReason follows DATA-MODEL §3.5', () => {
    expect(refundEndReason(BetStatus.Open)).toBe('accept_timeout');
    expect(refundEndReason(BetStatus.Locked)).toBe('resolve_timeout');
    expect(refundEndReason(BetStatus.Appealed)).toBe('appeal_timeout');
    expect(refundEndReason(BetStatus.Resolved)).toBeNull();
  });
});

describe('exitPayout', () => {
  it('refunds: Open -> all to A; Locked / Appealed -> own stakes, excess to B', () => {
    expect(exitPayout(at(BetStatus.Open), 'timeout_refund', 7n)).toEqual({ to_a: 7n, to_b: 0n });
    expect(exitPayout(at(BetStatus.Open), 'cancel_open_bet', 7n)).toEqual({ to_a: 7n, to_b: 0n });
    expect(exitPayout(at(BetStatus.Locked), 'timeout_refund', 11n)).toEqual({
      to_a: 5n,
      to_b: 6n,
    });
    expect(exitPayout(at(BetStatus.Appealed), 'timeout_refund', 3n)).toEqual({
      to_a: 3n,
      to_b: 0n,
    });
  });

  it('finalize applies the stored outcome; close_bet pays nothing', () => {
    const r = (value: Outcome) =>
      at(BetStatus.Resolved, { outcome: { __option: 'Some', value } as Bet['outcome'] });
    expect(exitPayout(r(Outcome.PartyA), 'finalize', 10n)).toEqual({ to_a: 10n, to_b: 0n });
    expect(exitPayout(r(Outcome.PartyB), 'finalize', 10n)).toEqual({ to_a: 0n, to_b: 10n });
    expect(exitPayout(r(Outcome.Split), 'finalize', 11n)).toEqual({ to_a: 5n, to_b: 6n });
    expect(exitPayout(r(Outcome.Refund), 'finalize', 10n)).toEqual({ to_a: 5n, to_b: 5n });
    expect(exitPayout(at(BetStatus.Resolved), 'finalize', 10n)).toBeNull();
    expect(exitPayout(at(BetStatus.Settled), 'close_bet', 10n)).toBeNull();
  });

  it('BET_RENT_PAYER_OFFSET is where the encoder puts rent_payer', () => {
    const z = new Uint8Array(32);
    const key = (b: number) => Uint8Array.from({ length: 32 }, () => b);
    const addr = (b: number) => getAddressDecoder().decode(key(b));
    const bytes = getBetEncoder().encode({
      betId: new Uint8Array(16),
      partyA: addr(1),
      partyB: addr(2),
      mint: addr(3),
      rentPayer: addr(9),
      judgeAuthority: addr(4),
      appealAuthority: addr(5),
      stakeA: 1n,
      stakeB: 1n,
      termsHash: z,
      evidenceHash: z,
      rulingHash: z,
      status: BetStatus.Locked,
      outcome: { __option: 'None' },
      appealWindowSecs: 10,
      resolveWindowSecs: 3600,
      appealResolveSecs: 300,
      createdAt: 0n,
      acceptDeadline: 0n,
      lockedAt: 0n,
      resolveDeadline: 0n,
      resolvedAt: 0n,
      appealDeadline: 0n,
      appealedAt: 0n,
      appealResolveDeadline: 0n,
      bump: 255,
      vaultBump: 254,
    });
    expect([...bytes.slice(BET_RENT_PAYER_OFFSET, BET_RENT_PAYER_OFFSET + 32)]).toEqual([
      ...key(9),
    ]);
  });
});
