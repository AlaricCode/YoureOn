// SCHEMAS §9.3 — offchain state machine and the onchain enums it mirrors.
import { z } from 'zod/v4';
import { TxKind } from './authorization';
import { IsoUtc, Signature } from './primitives';

/** Order is significant: Postgres bet_state has these exact values in this order (DATA-MODEL §4). */
export const BetState = z.enum([
  'DRAFTING',
  'TERMS_PROPOSED',
  'AWAITING_AUTHORIZATIONS',
  'AWAITING_LOCK',
  'LOCKED',
  'ATTEMPT',
  'JUDGING',
  'HEARING',
  'AWAITING_MARKET',
  'RULED',
  'CONCEDED',
  'FINALIZED',
  'APPEALED',
  'APPEAL_RESOLVED',
  'PAID',
  'VOIDED',
  'CANCELLED',
  'EXPIRED',
]);
export type BetState = z.infer<typeof BetState>;

export const TERMINAL_BET_STATES = [
  'PAID',
  'VOIDED',
  'CANCELLED',
  'EXPIRED',
] as const satisfies readonly BetState[];
export const isTerminalBetState = (s: BetState): boolean =>
  (TERMINAL_BET_STATES as readonly BetState[]).includes(s);

/** = Rust BetStatus, borsh 0..=6. */
export const OnchainStatus = z.enum([
  'Open',
  'Locked',
  'Resolved',
  'Appealed',
  'Settled',
  'Refunded',
  'Cancelled',
]);
export type OnchainStatus = z.infer<typeof OnchainStatus>;

/** = DATA-MODEL chain_ix (escrow instruction names). */
export const Instruction = z.enum([
  'create_bet',
  'accept_bet',
  'cancel_open_bet',
  'resolve',
  'concede',
  'appeal',
  'resolve_appeal',
  'finalize',
  'timeout_refund',
  'close_bet',
]);
export type Instruction = z.infer<typeof Instruction>;

export const ChainAck = z.enum(['none', 'rpc', 'stream']);
export type ChainAck = z.infer<typeof ChainAck>;

export const PendingTx = z.strictObject({
  /** What the tx is (§9); payouts carry a bundled close_bet. */
  kind: TxKind,
  signature: Signature,
  submitted_at: IsoUtc,
  /** Payout animation fires here; the lock shows "Locking…" here (§9.2). */
  rpc_processed_at: IsoUtc.nullable(),
  rpc_confirmed_at: IsoUtc.nullable(),
});
export type PendingTx = z.infer<typeof PendingTx>;
