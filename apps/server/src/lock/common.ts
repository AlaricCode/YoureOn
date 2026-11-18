// Helpers shared by the terms sink, LockService and the payout service: the Drizzle tx type,
// bet row locking, bet.state payloads, fan-out to both parties + the bet channel + the stage.
import { eq } from 'drizzle-orm';
import type { ReadonlyUint8Array } from '@solana/kit';
import { bets, type Db } from '@youre-on/db';
import type { BetState } from '@youre-on/shared/bet-state';
import type { PendingTx } from '@youre-on/shared/bet-state';
import { findBetPda, getBetDecoder, type Bet } from '@youre-on/shared/escrow-client';
import { betIdToBytes } from '@youre-on/shared/primitives';
import type { AppDeps } from '../context';
import type { ChainRuntime } from '../chain/tx';
import { chainAckOf, toOnchainStatus, type BetRow } from '../bets/snapshot';
import type { BetEventEnvelope } from '../realtime/events';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type LifecycleDeps = Pick<AppDeps, 'db' | 'hub' | 'log' | 'now' | 'env'>;

/** SELECT … FOR UPDATE the bet (null when unknown). */
export async function lockBet(tx: Tx, betId: string): Promise<BetRow | null> {
  const [row] = await tx.select().from(bets).where(eq(bets.id, betId)).for('update').limit(1);
  return row ?? null;
}

export async function readBet(db: Pick<Db, 'select'>, betId: string): Promise<BetRow | null> {
  const [row] = await db.select().from(bets).where(eq(bets.id, betId)).limit(1);
  return row ?? null;
}

/** The `bet.state` payload for `row` (after the write) moving from `prev`. */
export function statePayload(
  row: Pick<BetRow, 'state' | 'onchain_status' | 'onchain_pending'>,
  prev: BetState | null,
  reason: string | null,
  pendingTx: PendingTx | null = null,
) {
  return {
    state: row.state,
    prev,
    onchain_status: toOnchainStatus(row.onchain_status),
    chain_ack: chainAckOf(row),
    pending_tx: pendingTx,
    reason: reason ? reason.slice(0, 80) : null,
  };
}

/** After COMMIT: bet:<id> (+ the room's stage) and both parties' user channels (deduped by seq). */
export function fanout(
  deps: Pick<AppDeps, 'hub'>,
  bet: Pick<BetRow, 'room_id' | 'party_a_id' | 'party_b_id'>,
  envs: readonly BetEventEnvelope[],
): void {
  for (const e of envs) {
    deps.hub.publishBetEvent(e, bet.room_id);
    deps.hub.publishToUser(bet.party_a_id, e);
    deps.hub.publishToUser(bet.party_b_id, e);
  }
}

/** The onchain Bet account of `betId` (our program only), or null when it does not exist. */
export async function readBetAccount(rt: ChainRuntime, betId: string): Promise<Bet | null> {
  const [pda] = await findBetPda({ betId: betIdToBytes(betId) });
  const acc = await rt.client.getAccount(pda);
  if (!acc || acc.owner !== rt.programId) return null;
  return getBetDecoder().decode(acc.data);
}

export const hexOf = (b: ReadonlyUint8Array): string =>
  Buffer.from(b as Uint8Array).toString('hex');

export const iso = (ms: number | Date): string => new Date(ms).toISOString();

/** Lowercase hex -> bytes. */
export function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

/** Tracks fire-and-forget work so tests (and shutdown) can wait for it. */
export class Inflight {
  private readonly set = new Set<Promise<unknown>>();
  constructor(private readonly log: AppDeps['log']) {}
  run(name: string, fn: () => Promise<unknown>): void {
    const p = fn()
      .catch((err: unknown) => this.log.error(`${name}.failed`, { err }))
      .finally(() => this.set.delete(p));
    this.set.add(p);
  }
  /** Resolves when everything started so far (and anything it started) has settled. */
  async idle(): Promise<void> {
    while (this.set.size) await Promise.allSettled([...this.set]);
  }
}
