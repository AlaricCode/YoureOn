// DB helpers for the chain projector tests: CHECK-valid `bets` rows built from the same BetFacts
// the chain events are built from (chain-fixtures.ts), and the chain_txs lock row the LockService
// records at send (the projector's attribution source, DATA-MODEL §8.2 step 2).
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  auditLog,
  betEvents,
  bets,
  chainEvents,
  chainTxs,
  outbox,
  users,
  type Db,
} from '@youre-on/db';
import { randomPubkey, randomSig, type BetFacts } from './chain-fixtures';

type BetRow = typeof bets.$inferSelect;

export async function mkUser(db: Db, name = 'T'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      display_name: name,
      wallet_pubkey: randomPubkey(),
      age_attested_18plus: true,
      attested_at: new Date(),
    })
    .returning({ id: users.id });
  return u!.id;
}

export interface BetRowOptions {
  partyA: string;
  partyB: string;
  state?: BetRow['state'];
  end_reason?: BetRow['end_reason'];
  /** Both parties authorized (bets_locked_authorized); default true. */
  authorized?: boolean;
  /** The tx sender's own RPC confirm (onchain_pending 'locked' + pending_sig). */
  pendingSig?: string | null;
  room_id?: string | null;
  extra?: Partial<typeof bets.$inferInsert>;
}

/** A bets row whose binding fields equal `f` (what the escrow committed to). */
export async function mkBetRow(db: Db, f: BetFacts, o: BetRowOptions): Promise<string> {
  const at = new Date((f.t0 - 10) * 1000);
  const authorized = o.authorized ?? true;
  await db.insert(bets).values({
    id: f.bet_id,
    room_id: o.room_id ?? null,
    party_a_id: o.partyA,
    party_b_id: o.partyB,
    party_a_wallet: f.party_a,
    party_b_wallet: f.party_b,
    challenge_method: 'list',
    title: 'Bottle flip',
    evidence_source: 'camera',
    state: o.state ?? 'AWAITING_LOCK',
    end_reason: o.end_reason ?? null,
    mint: f.mint,
    stake_a: BigInt(f.stake_a),
    stake_b: BigInt(f.stake_b),
    terms_hash: f.terms_hash,
    ...(authorized
      ? {
          a_authorized_at: at,
          a_authorization_method: 'faceid_hold' as const,
          b_authorized_at: at,
          b_authorization_method: 'faceid_hold' as const,
        }
      : {}),
    ...(o.pendingSig ? { onchain_pending: 'locked' as const, pending_sig: o.pendingSig } : {}),
    ...o.extra,
  });
  return f.bet_id;
}

/** The atomic_lock chain_txs row the LockService writes at send (signature = the lock tx id). */
export async function mkLockTx(
  db: Db,
  betId: string,
  signature: string,
  status: 'sent' | 'confirmed' | 'expired' | 'failed' = 'confirmed',
): Promise<string> {
  const msg = randomBytes(120);
  const [row] = await db
    .insert(chainTxs)
    .values({
      bet_id: betId,
      kind: 'atomic_lock',
      signer_role: 'both_parties',
      message_b64: msg.toString('base64'),
      message_sha256: createHash('sha256').update(msg).digest('hex'),
      nonce_account: randomPubkey(),
      nonce_value: randomPubkey(),
      a_signature: randomSig(),
      b_signature: randomSig(),
      first_signer: 'A',
      expires_at: new Date(Date.now() + 300_000),
      signature,
      expected_status: 'locked',
      status,
      sent_at: new Date(),
    })
    .returning({ id: chainTxs.id });
  return row!.id;
}

/** A server-sent payout / resolve row (fee payer), e.g. so an rpc_poll copy is attributable. */
export async function mkServerTx(
  db: Db,
  betId: string,
  kind: 'resolve' | 'concede' | 'finalize',
  signature: string,
  status: 'sent' | 'confirmed' = 'confirmed',
): Promise<string> {
  const msg = randomBytes(80);
  const [row] = await db
    .insert(chainTxs)
    .values({
      bet_id: betId,
      kind,
      bundled_close: kind !== 'resolve',
      signer_role: kind === 'resolve' ? 'judge' : 'fee_payer',
      message_b64: msg.toString('base64'),
      message_sha256: createHash('sha256').update(msg).digest('hex'),
      signature,
      expected_status: kind === 'resolve' ? 'resolved' : 'settled',
      status,
      sent_at: new Date(),
    })
    .returning({ id: chainTxs.id });
  return row!.id;
}

export const betRow = async (db: Db, id: string): Promise<BetRow> =>
  (await db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;

export const logOf = (db: Db, betId: string) =>
  db.select().from(betEvents).where(eq(betEvents.bet_id, betId)).orderBy(asc(betEvents.seq));

export const rowsOf = (db: Db, signature: string) =>
  db
    .select()
    .from(chainEvents)
    .where(eq(chainEvents.signature, signature))
    .orderBy(asc(chainEvents.outer_ix), asc(chainEvents.inner_ix));

export const eventsOfBet = (db: Db, betId: string) =>
  db.select().from(chainEvents).where(eq(chainEvents.bet_id, betId)).orderBy(asc(chainEvents.id));

export const auditOf = (db: Db, betId: string, action?: string) =>
  db
    .select()
    .from(auditLog)
    .where(
      action
        ? and(eq(auditLog.bet_id, betId), eq(auditLog.action, action))
        : eq(auditLog.bet_id, betId),
    )
    .orderBy(asc(auditLog.id));

export const outboxOf = (db: Db, betId: string) =>
  db.select().from(outbox).where(eq(outbox.bet_id, betId)).orderBy(asc(outbox.id));

export const lockTxOf = async (db: Db, id: string) =>
  (await db.select().from(chainTxs).where(eq(chainTxs.id, id)).limit(1))[0]!;
