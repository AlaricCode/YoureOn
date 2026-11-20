// SCHEMAS §10.2 — chain event payloads, mirroring ESCROW-PROGRAM §7.2 field for field (snake_case, Rust order, `ts`).
import { z } from 'zod/v4';
import { OnchainStatus } from './bet-state';
import { MicroUsdc } from './money';
import { BetId, Hex32, Pubkey, Signature, UnixSeconds } from './primitives';
import { OnchainOutcome } from './ruling';

/** Added by the webhook decoder, not part of the Anchor event. */
export const ChainMeta = {
  signature: Signature,
  /** getBlock objects have no slot field; rpc_poll always has it. */
  slot: z.number().int().nonnegative().nullable(),
  /** Streams block dataset carries blockHeight; getTransaction doesn't. */
  block_height: z.number().int().nonnegative().nullable(),
  /** Index of the top-level instruction in the tx. */
  outer_ix: z.number().int().nonnegative(),
  /** Index of the emit_cpi! self-CPI in meta.innerInstructions[outer_ix]. */
  inner_ix: z.number().int().nonnegative(),
  block_time: UnixSeconds.nullable(),
  observed_via: z.enum(['quicknode_stream', 'rpc_poll']),
};

/** Any u64 as a decimal string (token amounts are micro-USDC; rent is lamports). */
const U64 = MicroUsdc;

/** Common fields of the 5 token-moving events, in Rust order. */
const Terminal = {
  bet_id: BetId,
  final_status: OnchainStatus,
  outcome: OnchainOutcome,
  mint: Pubkey,
  party_a: Pubkey,
  party_b: Pubkey,
  /** '11111111111111111111111111111111' (Pubkey::default) if that side was omitted (amount 0). */
  party_a_token: Pubkey,
  party_b_token: Pubkey,
  to_a: MicroUsdc,
  to_b: MicroUsdc,
  ts: UnixSeconds,
};

export const ChainEvents = {
  BetCreated: z.strictObject({
    ...ChainMeta,
    bet_id: BetId,
    bet: Pubkey,
    vault: Pubkey,
    party_a: Pubkey,
    party_b: Pubkey,
    mint: Pubkey,
    stake_a: MicroUsdc,
    stake_b: MicroUsdc,
    terms_hash: Hex32,
    judge_authority: Pubkey,
    appeal_authority: Pubkey,
    accept_deadline: UnixSeconds,
    rent_payer: Pubkey,
    ts: UnixSeconds,
  }),
  BetAccepted: z.strictObject({
    ...ChainMeta,
    bet_id: BetId,
    party_a: Pubkey,
    party_b: Pubkey,
    terms_hash: Hex32,
    stake_a: MicroUsdc,
    stake_b: MicroUsdc,
    vault_amount: MicroUsdc,
    resolve_deadline: UnixSeconds,
    ts: UnixSeconds,
  }),
  BetResolved: z.strictObject({
    ...ChainMeta,
    bet_id: BetId,
    judge: Pubkey,
    outcome: OnchainOutcome,
    evidence_hash: Hex32,
    ruling_hash: Hex32,
    appeal_deadline: UnixSeconds,
    ts: UnixSeconds,
  }),
  BetAppealed: z.strictObject({
    ...ChainMeta,
    bet_id: BetId,
    appellant: Pubkey,
    original_outcome: OnchainOutcome,
    appeal_resolve_deadline: UnixSeconds,
    ts: UnixSeconds,
  }),
  BetConceded: z.strictObject({ ...ChainMeta, ...Terminal, conceded_by: Pubkey }),
  BetFinalized: z.strictObject({ ...ChainMeta, ...Terminal, caller: Pubkey }),
  AppealResolved: z.strictObject({
    ...ChainMeta,
    ...Terminal,
    original_outcome: OnchainOutcome,
    appeal_ruling_hash: Hex32,
    overturned: z.boolean(),
  }),
  BetRefunded: z.strictObject({
    ...ChainMeta,
    ...Terminal,
    from_status: OnchainStatus,
    caller: Pubkey,
  }),
  BetCancelled: z.strictObject({ ...ChainMeta, ...Terminal, cancelled_by: Pubkey }),
  BetClosed: z.strictObject({
    ...ChainMeta,
    bet_id: BetId,
    final_status: OnchainStatus,
    rent_payer: Pubkey,
    rent_returned: U64,
    residual_to_a: MicroUsdc,
    ts: UnixSeconds,
  }),
} as const;
// ConfigInitialized / ConfigUpdated are decoded and stored (chain_events, bet_id NULL) but never fanned out.

export type ChainEventName = keyof typeof ChainEvents;
export const CHAIN_EVENT_NAMES = Object.keys(ChainEvents) as ChainEventName[];
export type ChainEventPayload<N extends ChainEventName> = z.infer<(typeof ChainEvents)[N]>;

/** The five token-moving events ("money moved" ⇔ the payload has to_a). */
export const MONEY_MOVED_EVENTS = [
  'BetConceded',
  'BetFinalized',
  'AppealResolved',
  'BetRefunded',
  'BetCancelled',
] as const satisfies readonly ChainEventName[];

/** Streams delivers at least once: dedup on (signature, outer_ix, inner_ix) before assigning seq. */
export const chainEventDedupKey = (e: {
  signature: string;
  outer_ix: number;
  inner_ix: number;
}): string => `${e.signature}:${e.outer_ix}:${e.inner_ix}`;
