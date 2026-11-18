// LockService (ESCROW §5.0.1, API-CONTRACT §2.8, DATA-MODEL §5.8 / §5.20 / §8.1, SCHEMAS §9.4).
//
// The atomic lock is ONE server-built transaction on a leased durable nonce:
//   [AdvanceNonceAccount, SetComputeUnitLimit, create_bet, accept_bet]     (packages/shared lock-tx)
// built and simulated once at confirm_terms, stored as exact message bytes in chain_txs, and sent
// once with preflight ON when the second party signature arrives.
//
// LOCK_SIGNER (env):
//   'phones'  API-CONTRACT §2.8: both phones get the same AuthorizeRequest (terms.authorize_request
//             + GET /lock), sign the stored bytes after hold + Face ID, POST /lock/authorizations.
//   'server'  custodial demo path (D-A): right after the build the server signs the stored bytes
//             as demo-a and demo-b (DEMO_A/B_SECRET_KEY, which must equal the Terms pubkeys) and
//             feeds both signatures through the SAME recordSignature path. CHECK-compatibility
//             (bets_locked_authorized, bets_auth_pairs): a_/b_authorized_at = server time,
//             a_/b_authorization_method = 'faceid_hold' (the enum has no custodial value),
//             a_/b_authorized_device_at = NULL (no device: that NULL marks a custodial row), and an
//             audit_log 'lock.custodial_signed' row per party.
//
// Gemini bets (Beat 6): the lock's accept_deadline is unix(Terms.market.quotedAt) + 60 s (SCHEMAS
// §8.3; the phones' device policy L3 checks exactly this), so a quote too old to lock is EXPIRED
// (quote_expired) before a nonce is leased; at landing the bet goes LOCKED -> AWAITING_MARKET in
// the same transaction (markets/settlement.ts) and the settlement keeper takes over.
//
// Projector compatibility (chain/projector.ts betsColumnLockSignatures): at the lock's own RPC
// `confirmed` the bet gets onchain_pending='locked' + pending_sig=<lock signature> (bets_pending_pair).
// Later server txs (resolve, payout) do NOT overwrite them, so the stub projector keeps attributing
// every later event of the bet to our lock (see lockSignaturesFromChainTxs for the chain_txs-based
// lookup a full projector should switch to).
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  address,
  createNoopSigner,
  getBase58Decoder,
  getBase58Encoder,
  getCompiledTransactionMessageDecoder,
  signBytes,
  type Address,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit';
import { auditLog, bets, chainTxs, noncePool, users } from '@youre-on/db';
import type { AuthorizationResult } from '@youre-on/shared/api';
import type {
  AuthorizeRequest,
  PartyAuthorization,
  PartyDecline,
} from '@youre-on/shared/authorization';
import { LOCK_SUBMIT_MARGIN_SECS, NONCE_POOL_SIZE } from '@youre-on/shared/constants';
import { compileLock, lockBody } from '@youre-on/shared/chain/lock-tx';
import { BetStatus } from '@youre-on/shared/escrow-client';
import { formatUsd } from '@youre-on/shared/money';
import { betIdToBytes, otherParty, type Party } from '@youre-on/shared/primitives';
import { asciiFold, declinedCue, judgeCue } from '../bets/cues';
import { partyOf, type BetRow } from '../bets/snapshot';
import { HttpError } from '../errors';
import { sha256Hex, verifyEd25519 } from '../crypto';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';
import {
  ataOf,
  buildNonceAdvance,
  confirmSent,
  cosignTx,
  customErrorCode,
  cuWithMargin,
  heightOnce,
  messageB64,
  poolAddress,
  PreflightError,
  readNonce,
  SimulationError,
  TxFailedError,
  txFate,
  wireOf,
  type ChainRuntime,
  type SendOptions,
} from '../chain/tx';
import {
  fanout,
  hexBytes,
  hexOf,
  iso,
  Inflight,
  lockBet,
  readBetAccount,
  statePayload,
  type LifecycleDeps,
  type Tx,
} from './common';
import { enterAwaitingMarket, settlementOf } from '../markets/settlement';
import { acceptDeadlineFor, loadEnvelope, quoteAcceptDeadline } from './terms';

type LockRow = typeof chainTxs.$inferSelect;
type NonceRow = typeof noncePool.$inferSelect;

const b58enc = getBase58Encoder();
const b58dec = getBase58Decoder();
const sigBytes = (s: string) => new Uint8Array(b58enc.encode(s)) as SignatureBytes;
const sigString = (b: Uint8Array) => b58dec.decode(b);

/** SPL Token InsufficientFunds (a party's ATA is short). */
const TOKEN_INSUFFICIENT_FUNDS = 1;
/** The sweep stops re-broadcasting a lost lock this long before its expires_at. */
export const LOCK_RESEND_STOP_MS = 5_000;
/**
 * A gemini lock is only built with at least this long to sign and land it before expires_at
 * (accept_deadline - 5 s); otherwise the quote is EXPIRED (quote_expired) without a lease.
 */
export const MIN_LOCK_WINDOW_SECS = 5;

export interface LockServiceOptions {
  deps: LifecycleDeps;
  runtime: () => Promise<ChainRuntime | null>;
  inflight: Inflight;
  signer: 'phones' | 'server';
  send?: SendOptions;
}

/** Rebuilds the wire transaction from the stored message bytes and the held signatures. */
export function txFromStored(b64: string, sigs: ReadonlyMap<string, SignatureBytes>): Transaction {
  const messageBytes = new Uint8Array(Buffer.from(b64, 'base64'));
  const compiled = getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: Address[];
  };
  const signers = compiled.staticAccounts.slice(0, compiled.header.numSignerAccounts);
  return {
    messageBytes,
    signatures: Object.fromEntries(signers.map((a) => [a, sigs.get(a) ?? null])),
  } as unknown as Transaction;
}

/** Why a lock failed, for the LOCK_FAILED cue and chain_txs.err. */
function failureReason(err: unknown): { reason: string; party: Party | null } {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const ix = Array.isArray(ie) ? Number(ie[0]) : null;
  // ix 0 AdvanceNonce, 1 ComputeBudget, 2 create_bet (A deposits), 3 accept_bet (B deposits)
  const party: Party | null = ix === 2 ? 'A' : ix === 3 ? 'B' : null;
  const code = customErrorCode(err);
  if (code === TOKEN_INSUFFICIENT_FUNDS) return { reason: 'insufficient_funds', party };
  if (code !== null) return { reason: code >= 6000 ? `escrow_${code}` : `error_${code}`, party };
  return { reason: 'rejected', party };
}

export class LockService {
  private readonly confirming = new Set<string>();
  constructor(private readonly o: LockServiceOptions) {}

  private get deps() {
    return this.o.deps;
  }

  // ---- build (confirm_terms step 2) -------------------------------------------------------

  /** start() off the request path (confirm_terms answers the judge first). */
  startInBackground(betId: string): void {
    this.o.inflight.run('lock.start', () => this.start(betId));
  }

  /** Leases a nonce, builds + simulates + stores the lock, pushes it (or signs it, custodial). */
  async start(betId: string): Promise<void> {
    const rt = await this.o.runtime();
    if (!rt) return this.failLock(betId, 'chain_unavailable', null, null);
    try {
      await rt.client.assertSafeCluster();
      await this.ensurePool(rt);
      const built = await this.build(rt, betId);
      if (!built) return;
      if ('quoteExpired' in built) {
        await this.expire(betId, null, this.deps.now());
        return;
      }
      if (this.o.signer === 'server') await this.custodialSign(rt, betId, built.lockId);
    } catch (err) {
      const reason =
        err instanceof HttpError
          ? err.code.toLowerCase()
          : err instanceof SimulationError
            ? failureReason(err.err).reason
            : 'build_failed';
      const party = err instanceof SimulationError ? failureReason(err.err).party : null;
      this.deps.log.warn('lock.build_failed', { bet_id: betId, reason, err });
      if (err instanceof HttpError && err.code === 'NONCE_POOL_EXHAUSTED')
        return this.failLock(betId, 'nonce_pool_exhausted', null, null);
      return this.failLock(betId, reason, party, null);
    }
  }

  /** Inserts nonce_pool rows for pool accounts that exist on chain when the table is empty. */
  async ensurePool(rt: ChainRuntime): Promise<number> {
    const [c] = await this.deps.db.select({ n: sql<number>`count(*)::int` }).from(noncePool);
    if ((c?.n ?? 0) > 0) return 0;
    return syncNoncePool(this.deps, rt);
  }

  private async build(
    rt: ChainRuntime,
    betId: string,
  ): Promise<{ lockId: string } | { quoteExpired: true } | null> {
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const bet = await lockBet(tx, betId);
      if (!bet || bet.state !== 'AWAITING_AUTHORIZATIONS') return null;
      const [existing] = await tx
        .select({ id: chainTxs.id })
        .from(chainTxs)
        .where(
          and(
            eq(chainTxs.bet_id, betId),
            eq(chainTxs.kind, 'atomic_lock'),
            inArray(chainTxs.status, ['built', 'signed', 'sent', 'confirmed']),
          ),
        )
        .limit(1);
      if (existing) return null; // already built (a duplicate confirm)
      const final = await loadEnvelope(tx, betId, { finalOnly: true });
      if (!final || final.envelope.terms_hash !== bet.terms_hash)
        throw new HttpError('TERMS_NOT_FINAL');
      const terms = final.envelope.terms;
      // Gemini: the quote's TTL is the lock window (SCHEMAS §8.3); skill: build time + 300 s.
      const acceptDeadline = terms.market
        ? quoteAcceptDeadline(terms.market.quotedAt)
        : acceptDeadlineFor(now);
      if (
        terms.market &&
        acceptDeadline - LOCK_SUBMIT_MARGIN_SECS < Math.floor(now / 1000) + MIN_LOCK_WINDOW_SECS
      )
        return { quoteExpired: true as const };

      // 1. lease the least-recently-advanced free nonce (DATA-MODEL §5.20 "Allocate").
      const [nonce] = await tx
        .select()
        .from(noncePool)
        .where(eq(noncePool.status, 'free'))
        .orderBy(sql`${noncePool.last_advanced_at} ASC NULLS FIRST`, asc(noncePool.seed_index))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!nonce) throw new HttpError('NONCE_POOL_EXHAUSTED');
      const onchain = await readNonce(rt.client, address(nonce.nonce_account));
      if (!onchain) throw new Error(`nonce ${nonce.nonce_account} unreadable`);
      if (onchain.authority !== rt.keys.feePayer.address)
        throw new Error(`nonce ${nonce.nonce_account} authority mismatch`);
      if (onchain.value !== nonce.nonce_value)
        await tx.insert(auditLog).values({
          actor_kind: 'server',
          action: 'nonce.mismatch',
          bet_id: betId,
          details: { seed_index: nonce.seed_index, db: nonce.nonce_value, chain: onchain.value },
        });

      // 2. build + simulate (sigVerify off) + rebuild with the CU margin; the bytes are final.
      const parties = {
        s: rt.keys.feePayer,
        a: createNoopSigner(address(terms.party_a.pubkey)),
        b: createNoopSigner(address(terms.party_b.pubkey)),
        mint: address(terms.escrow.mint),
        aToken: await ataOf(address(terms.party_a.pubkey), address(terms.escrow.mint)),
        bToken: await ataOf(address(terms.party_b.pubkey), address(terms.escrow.mint)),
      };
      const args = {
        betId: betIdToBytes(betId),
        stakeA: BigInt(terms.stakes.a),
        stakeB: BigInt(terms.stakes.b),
        termsHash: hexBytes(final.envelope.terms_hash),
        acceptDeadline: BigInt(acceptDeadline),
      };
      const nonceRef = { account: address(nonce.nonce_account), value: onchain.value };
      const probe = compileLock(
        rt.keys.feePayer.address,
        nonceRef,
        await lockBody(parties, { ...args, cuLimit: 1_400_000 }),
      );
      const sim = await rt.client.simulate(wireOf(probe), false);
      if (sim.err) throw new SimulationError('atomic_lock', sim.err, sim.logs);
      const simulated = sim.unitsConsumed ?? 200_000n;
      const cuLimit = cuWithMargin(simulated);
      const lock = compileLock(
        rt.keys.feePayer.address,
        nonceRef,
        await lockBody(parties, { ...args, cuLimit }),
      );
      const b64 = messageB64(lock);
      const expiresAt = new Date((acceptDeadline - LOCK_SUBMIT_MARGIN_SECS) * 1000);

      // 3. store the bytes, lease the nonce (one transaction).
      const [row] = await tx
        .insert(chainTxs)
        .values({
          bet_id: betId,
          kind: 'atomic_lock',
          signer_role: 'both_parties',
          message_b64: b64,
          message_sha256: sha256Hex(new Uint8Array(lock.messageBytes)),
          nonce_account: nonce.nonce_account,
          nonce_value: onchain.value,
          expires_at: expiresAt,
          simulated_cu: Number(simulated),
          cu_limit: cuLimit,
          expected_status: 'locked',
          status: 'built',
          built_at: new Date(now),
        })
        .returning();
      await tx
        .update(noncePool)
        .set({
          status: 'leased',
          nonce_value: onchain.value,
          value_read_at: new Date(now),
          leased_bet_id: betId,
          leased_tx_id: row!.id,
          leased_at: new Date(now),
        })
        .where(eq(noncePool.seed_index, nonce.seed_index));
      await tx
        .update(bets)
        .set({ accept_deadline: new Date(acceptDeadline * 1000), lock_mode: 'atomic' })
        .where(eq(bets.id, betId));

      const request = this.authorizeRequest(row!, final.envelope, nonce.seed_index, acceptDeadline);
      const envs: BetEventEnvelope[] = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'terms.proposed',
          payload: { envelope: final.envelope },
          now,
        }),
      ];
      if (this.o.signer === 'phones')
        envs.push(
          await appendBetEvent(tx, {
            bet_id: betId,
            type: 'terms.authorize_request',
            payload: request,
            now,
          }),
        );
      return { bet, envs, lockId: row!.id };
    });
    if (!out) return null;
    if ('quoteExpired' in out) {
      this.deps.log.warn('lock.quote_expired', { bet_id: betId });
      return out;
    }
    fanout(this.deps, out.bet, out.envs);
    this.deps.log.info('lock.built', { bet_id: betId, lock_request_id: out.lockId });
    return { lockId: out.lockId };
  }

  private authorizeRequest(
    row: LockRow,
    envelope: AuthorizeRequest['envelope'],
    seedIndex: number,
    acceptDeadline: number,
  ): AuthorizeRequest {
    return {
      bet_id: row.bet_id,
      lock_request_id: row.id,
      kind: 'atomic_lock',
      envelope,
      message_b64: row.message_b64!,
      message_sha256: row.message_sha256,
      nonce_index: seedIndex,
      accept_deadline: acceptDeadline,
      expires_at: iso((acceptDeadline - LOCK_SUBMIT_MARGIN_SECS) * 1000),
    };
  }

  /** LOCK_SIGNER=server: sign the stored bytes as demo-a and demo-b (see the header). */
  private async custodialSign(rt: ChainRuntime, betId: string, lockId: string): Promise<void> {
    const { demoA, demoB } = rt.keys;
    const [row] = await this.deps.db
      .select()
      .from(chainTxs)
      .where(eq(chainTxs.id, lockId))
      .limit(1);
    const [bet] = await this.deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
    if (!row || !bet) return;
    if (
      !demoA ||
      !demoB ||
      demoA.address !== bet.party_a_wallet ||
      demoB.address !== bet.party_b_wallet
    ) {
      this.deps.log.warn('lock.custodial_key_mismatch', { bet_id: betId });
      return this.failLock(betId, 'custodial_key_mismatch', null, null);
    }
    const msg = new Uint8Array(Buffer.from(row.message_b64!, 'base64'));
    for (const [party, kp] of [
      ['A', demoA],
      ['B', demoB],
    ] as const) {
      const sig = sigString(await signBytes(kp.keyPair.privateKey, msg));
      await this.recordSignature({
        betId,
        party,
        lockRequestId: lockId,
        signature: sig,
        method: 'faceid_hold',
        deviceAt: null,
        termsHash: bet.terms_hash!,
        messageSha: row.message_sha256,
        custodial: true,
      });
    }
  }

  // ---- reads ------------------------------------------------------------------------------

  /** GET /v1/bets/:id/lock (recovery after a reconnect). */
  async getLock(betId: string, userId: string): Promise<AuthorizeRequest> {
    const bet = await this.betForParty(betId, userId);
    if (bet.state === 'CANCELLED') throw new HttpError('LOCK_REVOKED');
    if (bet.state === 'EXPIRED') throw new HttpError('LOCK_EXPIRED');
    const row = await this.currentLock(this.deps.db, betId);
    if (!row || bet.state < 'AWAITING_AUTHORIZATIONS' || !bet.accept_deadline)
      throw new HttpError('TERMS_NOT_FINAL');
    if (row.status === 'revoked') throw new HttpError('LOCK_REVOKED');
    const final = await loadEnvelope(this.deps.db, betId, { finalOnly: true });
    const [nonce] = await this.deps.db
      .select({ k: noncePool.seed_index })
      .from(noncePool)
      .where(eq(noncePool.nonce_account, row.nonce_account!))
      .limit(1);
    if (!final || !nonce) throw new HttpError('TERMS_NOT_FINAL');
    return this.authorizeRequest(
      row,
      final.envelope,
      nonce.k,
      Math.floor(bet.accept_deadline.getTime() / 1000),
    );
  }

  private async betForParty(betId: string, userId: string): Promise<BetRow & { party: Party }> {
    const [bet] = await this.deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
    if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
    const party = partyOf(bet, userId);
    if (!party) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
    return { ...bet, party };
  }

  private async currentLock(db: Pick<Tx, 'select'>, betId: string, forUpdate = false) {
    const q = db
      .select()
      .from(chainTxs)
      .where(and(eq(chainTxs.bet_id, betId), eq(chainTxs.kind, 'atomic_lock')))
      .orderBy(desc(chainTxs.built_at))
      .limit(1);
    const [row] = forUpdate ? await q.for('update') : await q;
    return row ?? null;
  }

  // ---- authorizations ---------------------------------------------------------------------

  /** POST /v1/bets/:id/lock/authorizations (API-CONTRACT §2.8 server steps 1-7). */
  async authorize(
    betId: string,
    userId: string,
    body: PartyAuthorization,
    requestId?: string,
  ): Promise<AuthorizationResult> {
    if (body.bet_id !== betId)
      throw new HttpError('VALIDATION_FAILED', undefined, {
        issues: [{ path: 'bet_id', message: 'must equal the path bet_id' }],
      });
    const bet = await this.betForParty(betId, userId);
    if (bet.party !== body.party)
      throw new HttpError('NOT_A_PARTY', 'That is not your side of the bet.', {
        you: bet.party,
      });
    return this.recordSignature({
      betId,
      party: body.party,
      lockRequestId: body.lock_request_id,
      signature: body.party_signature,
      method: body.method,
      deviceAt: new Date(body.authorized_at),
      termsHash: body.terms_hash,
      messageSha: body.message_sha256,
      custodial: false,
      requestId,
    });
  }

  private async recordSignature(i: {
    betId: string;
    party: Party;
    lockRequestId: string;
    signature: string;
    method: 'faceid_hold' | 'passcode_hold';
    deviceAt: Date | null;
    termsHash: string;
    messageSha: string;
    custodial: boolean;
    requestId?: string;
  }): Promise<AuthorizationResult> {
    const rt = await this.o.runtime();
    if (!rt) throw new HttpError('RPC_UNAVAILABLE');
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const bet = await lockBet(tx, i.betId);
      if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
      const row = await this.currentLock(tx, i.betId, true);
      if (!row) throw new HttpError('TERMS_NOT_FINAL');
      if (row.id !== i.lockRequestId) {
        const [old] = await tx
          .select({ status: chainTxs.status })
          .from(chainTxs)
          .where(and(eq(chainTxs.id, i.lockRequestId), eq(chainTxs.bet_id, i.betId)))
          .limit(1);
        throw new HttpError(old?.status === 'revoked' ? 'LOCK_REVOKED' : 'STALE_LOCK_REQUEST');
      }
      const col = i.party === 'A' ? row.a_signature : row.b_signature;
      const otherCol = i.party === 'A' ? row.b_signature : row.a_signature;
      if (col) {
        // Idem (lock_request_id, party): ed25519 is deterministic, so a repeat is the same bytes.
        if (col !== i.signature) throw new HttpError('SIGNATURE_INVALID');
        if (row.signature && otherCol)
          return {
            res: { status: 'submitted', signature: row.signature } as AuthorizationResult,
            envs: [],
            bet,
            send: null,
          };
        return {
          res: { status: 'recorded', waiting_for: otherParty(i.party) } as AuthorizationResult,
          envs: [],
          bet,
          send: null,
        };
      }
      if (row.status === 'revoked' || bet.state === 'CANCELLED')
        throw new HttpError('LOCK_REVOKED');
      if (row.status === 'expired' || bet.state === 'EXPIRED') throw new HttpError('LOCK_EXPIRED');
      if (bet.state !== 'AWAITING_AUTHORIZATIONS' || !['built', 'signed'].includes(row.status))
        throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
      if (row.expires_at && now >= row.expires_at.getTime()) throw new HttpError('LOCK_EXPIRED');
      if (i.termsHash !== bet.terms_hash) throw new HttpError('TERMS_HASH_MISMATCH');
      if (i.messageSha !== row.message_sha256) throw new HttpError('MESSAGE_MISMATCH');
      const wallet = i.party === 'A' ? bet.party_a_wallet : bet.party_b_wallet;
      const msg = new Uint8Array(Buffer.from(row.message_b64!, 'base64'));
      let sig: SignatureBytes;
      try {
        sig = sigBytes(i.signature);
      } catch {
        throw new HttpError('SIGNATURE_INVALID');
      }
      if (!wallet || !verifyEd25519(wallet, msg, sig)) throw new HttpError('SIGNATURE_INVALID');

      const at = new Date(now);
      const sigCols =
        i.party === 'A'
          ? { a_signature: i.signature, a_signed_at: at }
          : { b_signature: i.signature, b_signed_at: at };
      const count = otherCol ? 2 : 1;
      await tx
        .update(chainTxs)
        .set({ ...sigCols, first_signer: row.first_signer ?? i.party, status: 'signed' })
        .where(eq(chainTxs.id, row.id));
      const authCols =
        i.party === 'A'
          ? {
              a_authorized_at: at,
              a_authorization_method: i.method,
              a_authorized_device_at: i.deviceAt,
            }
          : {
              b_authorized_at: at,
              b_authorization_method: i.method,
              b_authorized_device_at: i.deviceAt,
            };
      await tx.update(bets).set(authCols).where(eq(bets.id, i.betId));
      if (i.custodial)
        await tx.insert(auditLog).values({
          actor_kind: 'server',
          action: 'lock.custodial_signed',
          bet_id: i.betId,
          details: { party: i.party, lock_request_id: row.id },
        });
      const names = await partyNames(tx, bet);
      const me = names[i.party];
      const other = names[otherParty(i.party)];
      const envs: BetEventEnvelope[] = [
        await appendBetEvent(tx, {
          bet_id: i.betId,
          type: 'terms.authorized',
          payload: { party: i.party, method: i.method, authorized_at: iso(at), count },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: i.betId,
          type: 'judge.cue',
          payload:
            count === 1
              ? judgeCue(
                  'AUTHORIZED',
                  { party: i.party, name: me, waiting_for: other },
                  `Say ${asciiFold(me)} is locked in and ${asciiFold(other)} should hold their button.`,
                )
              : judgeCue(
                  'AUTHORIZED',
                  { party: i.party, name: me, waiting_for: 'none' },
                  'Say both are in and the lock is going through. Nothing else yet.',
                  false,
                ),
          now,
        }),
      ];
      if (count === 1)
        return {
          res: { status: 'recorded', waiting_for: otherParty(i.party) } as AuthorizationResult,
          envs,
          bet,
          send: null,
        };

      // Second signature: assemble in message-key order, co-sign as fee payer, mark sent ONCE.
      const sigs = new Map<string, SignatureBytes>([
        [bet.party_a_wallet!, i.party === 'A' ? sig : sigBytes(row.a_signature!)],
        [bet.party_b_wallet!, i.party === 'B' ? sig : sigBytes(row.b_signature!)],
      ]);
      const full = await cosignTx(txFromStored(row.message_b64!, sigs), [rt.keys.feePayer]);
      const signature = sigString(full.signatures[rt.keys.feePayer.address]!);
      await tx
        .update(chainTxs)
        .set({ status: 'sent', signature, sent_at: at })
        .where(eq(chainTxs.id, row.id));
      const [moved] = await tx
        .update(bets)
        .set({ state: 'AWAITING_LOCK' })
        .where(eq(bets.id, i.betId))
        .returning();
      const pending = {
        kind: 'atomic_lock' as const,
        signature,
        submitted_at: iso(at),
        rpc_processed_at: null,
        rpc_confirmed_at: null,
      };
      envs.push(
        await appendBetEvent(tx, {
          bet_id: i.betId,
          type: 'bet.state',
          payload: statePayload(moved!, bet.state, null, pending),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: i.betId,
          type: 'tx.submitted',
          payload: { kind: 'atomic_lock', signature },
          now,
        }),
      );
      return {
        res: { status: 'submitted', signature } as AuthorizationResult,
        envs,
        bet,
        send: { full, lockId: row.id },
      };
    });
    fanout(this.deps, out.bet, out.envs);
    if (!out.send) return out.res;

    // Send once, preflight ON. A rejection means nothing landed: fail + revoke the nonce.
    try {
      await rt.client.send(wireOf(out.send.full), false);
    } catch (err) {
      if (err instanceof PreflightError) {
        const why = failureReason(err.err);
        await this.failLock(i.betId, why.reason, why.party, String(err.message).slice(0, 200));
        throw new HttpError(
          why.reason === 'insufficient_funds' ? 'INSUFFICIENT_FUNDS' : 'LOCK_PREFLIGHT_FAILED',
          "Couldn't lock it. Nothing moved.",
          { reason: why.reason, party: why.party },
        );
      }
      // Transport trouble: the confirm loop re-broadcasts the same bytes.
      this.deps.log.warn('lock.send_retry', { bet_id: i.betId, err });
    }
    const { full, lockId } = out.send;
    this.o.inflight.run('lock.confirm', () => this.confirmLock(rt, i.betId, lockId, full));
    return out.res;
  }

  // ---- landing ----------------------------------------------------------------------------

  private async confirmLock(rt: ChainRuntime, betId: string, lockId: string, full: Transaction) {
    if (this.confirming.has(lockId)) return;
    this.confirming.add(lockId);
    try {
      const landed = await confirmSent(rt.client, full, {
        ...this.o.send,
        onProcessed: (at) => {
          void this.deps.db
            .update(chainTxs)
            .set({ rpc_processed_at: new Date(at) })
            .where(eq(chainTxs.id, lockId))
            .catch(() => {});
        },
      });
      await this.onLanded(
        rt,
        betId,
        lockId,
        landed.signature,
        landed.processedAt,
        landed.confirmedAt,
        landed.slot,
      );
    } catch (err) {
      if (err instanceof TxFailedError && err.kind === 'onchain') {
        const why = failureReason(err.err);
        // Agave advanced the nonce on a committed failure: re-read it, nothing to revoke.
        await this.failLock(betId, why.reason, why.party, err.message.slice(0, 200), {
          nonceAdvanced: true,
        });
        return;
      }
      // timeout / unknown: the sweep decides at expires_at.
      this.deps.log.warn('lock.confirm_pending', { bet_id: betId, err });
    } finally {
      this.confirming.delete(lockId);
    }
  }

  private async onLanded(
    rt: ChainRuntime,
    betId: string,
    lockId: string,
    signature: string,
    processedAt: number,
    confirmedAt: number,
    slot: bigint | null,
  ) {
    const now = this.deps.now();
    const [lockRow] = await this.deps.db
      .select()
      .from(chainTxs)
      .where(eq(chainTxs.id, lockId))
      .limit(1);
    const fresh = lockRow?.nonce_account
      ? await readNonce(rt.client, address(lockRow.nonce_account))
      : null;
    const out = await this.deps.db.transaction(async (tx) => {
      const bet = await lockBet(tx, betId);
      if (!bet) return null;
      await tx
        .update(chainTxs)
        .set({
          status: 'confirmed',
          rpc_processed_at: new Date(processedAt),
          rpc_confirmed_at: new Date(confirmedAt),
        })
        .where(eq(chainTxs.id, lockId));
      await this.releaseNonce(tx, lockId, fresh?.value ?? null, now);
      // The chain wins (DATA-MODEL §8.3): a lock that landed after the bet was expired or
      // lock_failed still moved both stakes, so the bet is LOCKED. bets_guard only lets a
      // terminal row move when onchain_status is locked or later in the same UPDATE, so this
      // path writes it (the landed atomic lock is exactly that status).
      const revived =
        (bet.state === 'EXPIRED' &&
          (bet.end_reason === 'accept_timeout' || bet.end_reason === 'quote_expired')) ||
        (bet.state === 'CANCELLED' && bet.end_reason === 'lock_failed');
      if (bet.state !== 'AWAITING_LOCK' && !revived) return { bet, envs: [] as BetEventEnvelope[] };
      if (revived)
        this.deps.log.warn('lock.chain_wins', { bet_id: betId, from: bet.state, signature });
      const [row] = await tx
        .update(bets)
        .set({
          state: 'LOCKED',
          onchain_pending: 'locked',
          pending_sig: signature,
          ...(revived
            ? {
                end_reason: null,
                onchain_status: ['none', 'open'].includes(bet.onchain_status)
                  ? ('locked' as const)
                  : bet.onchain_status,
              }
            : {}),
        })
        .where(eq(bets.id, betId))
        .returning();
      const names = await partyNames(tx, bet);
      const pot = formatUsd(((bet.stake_a ?? 0n) + (bet.stake_b ?? 0n)).toString());
      const final = await loadEnvelope(tx, betId, { finalOnly: true });
      const performer = final?.envelope.terms.performer;
      const market = final?.envelope.terms.market ?? null;
      const pending = {
        kind: 'atomic_lock' as const,
        signature,
        submitted_at: iso(lockRow?.sent_at ?? now),
        rpc_processed_at: iso(processedAt),
        rpc_confirmed_at: iso(confirmedAt),
      };
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(row!, bet.state, null, pending),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'tx.confirmed',
          payload: { kind: 'atomic_lock', signature, slot: Number(slot ?? 0n) },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: judgeCue(
            'LOCKED',
            {
              pot,
              a: names.A,
              b: names.B,
              ...(performer ? { performer: names[performer] } : {}),
              tx: 1,
            },
            market
              ? `Announce both stakes are locked in one transaction at Gemini's odds, and that Gemini settles it at ${market.expiry.slice(11, 16)} UTC.`
              : 'Announce both stakes are locked in one transaction, then call request_attempt with attempt_no 1.',
          ),
          now,
        }),
      ];
      // Gemini (Beat 6): straight on to AWAITING_MARKET in this same commit.
      if (market && final)
        envs.push(...(await enterAwaitingMarket(tx, betId, final.envelope.terms, now)));
      return { bet, envs, terms: market && final ? final.envelope.terms : null };
    });
    if (out) fanout(this.deps, out.bet, out.envs);
    if (out?.terms) settlementOf(this.deps).follow(betId, out.terms);
    this.deps.log.info('lock.confirmed', {
      bet_id: betId,
      signature,
      ms: confirmedAt - (lockRow?.sent_at?.getTime() ?? confirmedAt),
    });
  }

  /** The lock's own ix 0 advanced the nonce: back to free with the new value. */
  private async releaseNonce(tx: Tx, lockId: string, value: string | null, now: number) {
    const [n] = await tx
      .select()
      .from(noncePool)
      .where(eq(noncePool.leased_tx_id, lockId))
      .for('update')
      .limit(1);
    if (!n) return;
    if (!value) {
      // Unknown value: keep it out of rotation until the sweep re-reads it.
      await tx
        .update(noncePool)
        .set({
          status: 'retired',
          retired_at: new Date(now),
          leased_bet_id: null,
          leased_tx_id: null,
          leased_at: null,
        })
        .where(eq(noncePool.seed_index, n.seed_index));
      return;
    }
    await tx
      .update(noncePool)
      .set({
        status: 'free',
        nonce_value: value,
        value_read_at: new Date(now),
        leased_bet_id: null,
        leased_tx_id: null,
        leased_at: null,
        last_advanced_at: new Date(now),
        uses: sql`${noncePool.uses} + 1`,
        failures: 0,
      })
      .where(eq(noncePool.seed_index, n.seed_index));
  }

  // ---- failure, decline, expiry, revoke ---------------------------------------------------

  /** CANCELLED (lock_failed) + LOCK_FAILED cue; revokes (or releases) the leased nonce. */
  async failLock(
    betId: string,
    reason: string,
    party: Party | null,
    errText: string | null,
    o: { nonceAdvanced?: boolean } = {},
  ): Promise<void> {
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const bet = await lockBet(tx, betId);
      if (!bet) return null;
      const row = await this.currentLock(tx, betId, true);
      if (row && ['built', 'signed', 'sent'].includes(row.status))
        await tx
          .update(chainTxs)
          .set({ status: 'failed', err: (errText ?? reason).slice(0, 200) })
          .where(eq(chainTxs.id, row.id));
      if (!['AWAITING_AUTHORIZATIONS', 'AWAITING_LOCK'].includes(bet.state))
        return { bet, envs: [] as BetEventEnvelope[], row };
      const [moved] = await tx
        .update(bets)
        .set({ state: 'CANCELLED', end_reason: 'lock_failed' })
        .where(eq(bets.id, betId))
        .returning();
      const names = await partyNames(tx, bet);
      const kv: Record<string, string> = { reason };
      if (party) kv.party = names[party];
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(moved!, bet.state, `lock_failed:${reason}`),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: judgeCue('LOCK_FAILED', kv, 'Say the lock failed and nothing moved.'),
          now,
        }),
      ];
      return { bet, envs, row };
    });
    if (!out) return;
    fanout(this.deps, out.bet, out.envs);
    if (out.row) await this.revokeOrRelease(betId, out.row.id, !!o.nonceAdvanced);
  }

  private async revokeOrRelease(betId: string, lockId: string, nonceAdvanced: boolean) {
    const rt = await this.o.runtime();
    if (!rt) return;
    if (nonceAdvanced) {
      const [lockRow] = await this.deps.db
        .select()
        .from(chainTxs)
        .where(eq(chainTxs.id, lockId))
        .limit(1);
      const fresh = lockRow?.nonce_account
        ? await readNonce(rt.client, address(lockRow.nonce_account))
        : null;
      await this.deps.db.transaction((tx) =>
        this.releaseNonce(tx, lockId, fresh?.value ?? null, this.deps.now()),
      );
      return;
    }
    const [n] = await this.deps.db
      .select()
      .from(noncePool)
      .where(eq(noncePool.leased_tx_id, lockId))
      .limit(1);
    if (n) await this.revokeNonce(rt, n, betId);
  }

  /** POST /v1/bets/:id/lock/decline. Allowed until the lock tx is submitted. */
  async decline(
    betId: string,
    userId: string,
    body: PartyDecline,
    requestId?: string,
  ): Promise<void> {
    const bet0 = await this.betForParty(betId, userId);
    if (bet0.party !== body.party)
      throw new HttpError('NOT_A_PARTY', 'That is not your side of the bet.');
    const now = this.deps.now();
    const out = await this.deps.db.transaction(async (tx) => {
      const bet = await lockBet(tx, betId);
      if (!bet) throw new HttpError('NOT_FOUND');
      if (bet.state === 'CANCELLED' && bet.end_reason === 'declined') return null; // idempotent
      if (!['TERMS_PROPOSED', 'AWAITING_AUTHORIZATIONS'].includes(bet.state))
        throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
      const row = await this.currentLock(tx, betId, true);
      if (row && !['built', 'signed', 'failed', 'revoked'].includes(row.status))
        throw new HttpError('INVALID_STATE', 'The lock is already on its way.', {
          state: bet.state,
        });
      const [moved] = await tx
        .update(bets)
        .set({ state: 'CANCELLED', end_reason: 'declined' })
        .where(eq(bets.id, betId))
        .returning();
      await tx.insert(auditLog).values({
        actor_kind: 'user',
        actor_user_id: userId,
        action: 'bet.state_changed',
        bet_id: betId,
        request_id: requestId ?? null,
        details: { from: bet.state, to: 'CANCELLED', end_reason: 'declined', party: body.party },
      });
      const names = await partyNames(tx, bet);
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'terms.declined',
          payload: { party: body.party },
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(moved!, bet.state, 'declined'),
          now,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: declinedCue(names[body.party]),
          now,
        }),
      ];
      return { bet, envs, lockId: row && ['built', 'signed'].includes(row.status) ? row.id : null };
    });
    if (!out) return;
    fanout(this.deps, out.bet, out.envs);
    if (out.lockId) {
      const lockId = out.lockId;
      this.o.inflight.run('lock.revoke', () => this.revokeOrRelease(betId, lockId, false));
    }
  }

  /**
   * Sends a fee-payer-only AdvanceNonceAccount: every stored signature over the old value becomes
   * useless. The nonce stays `advancing` until it confirms, then is re-read -> free, and the lock
   * row (if still built/signed) -> revoked.
   */
  async revokeNonce(rt: ChainRuntime, n: NonceRow, betId: string): Promise<void> {
    const built = await buildNonceAdvance(rt, address(n.nonce_account));
    const signature = sigString(built.tx.signatures[rt.keys.feePayer.address]!);
    const now = this.deps.now();
    const lockId = n.leased_tx_id;
    const adv = await this.deps.db.transaction(async (tx) => {
      const [cur] = await tx
        .select()
        .from(noncePool)
        .where(eq(noncePool.seed_index, n.seed_index))
        .for('update')
        .limit(1);
      if (!cur || (cur.status !== 'leased' && cur.status !== 'advancing')) return null;
      const [row] = await tx
        .insert(chainTxs)
        .values({
          bet_id: betId,
          kind: 'nonce_advance',
          signer_role: 'fee_payer',
          message_b64: messageB64(built.tx),
          message_sha256: sha256Hex(new Uint8Array(built.tx.messageBytes)),
          nonce_account: n.nonce_account,
          signature,
          expected_status: 'none',
          status: 'sent',
          last_valid_block_height: built.lastValidBlockHeight,
          sent_at: new Date(now),
        })
        .returning();
      await tx
        .update(noncePool)
        .set({
          status: 'advancing',
          advance_tx_id: row!.id,
          nonce_value: null,
          leased_bet_id: null,
          leased_tx_id: null,
          leased_at: null,
        })
        .where(eq(noncePool.seed_index, n.seed_index));
      return { id: row!.id, lockId: cur.leased_tx_id ?? lockId };
    });
    if (!adv) return;
    try {
      await rt.client.send(wireOf(built.tx), false);
      await confirmSent(rt.client, built.tx, {
        ...this.o.send,
        lastValidBlockHeight: built.lastValidBlockHeight,
      });
      await this.finishAdvance(rt, n.seed_index, adv.id, adv.lockId);
    } catch (err) {
      this.deps.log.warn('nonce.advance_failed', { seed_index: n.seed_index, err });
      await this.deps.db.transaction(async (tx) => {
        // Only while still 'sent': the sweep may have settled it from the chain meanwhile.
        await tx
          .update(chainTxs)
          .set({ status: 'failed', err: String(err).slice(0, 200) })
          .where(and(eq(chainTxs.id, adv.id), eq(chainTxs.status, 'sent')));
        await tx
          .update(noncePool)
          .set({ failures: sql`${noncePool.failures} + 1` })
          .where(eq(noncePool.seed_index, n.seed_index));
      });
    }
  }

  private async finishAdvance(
    rt: ChainRuntime,
    seedIndex: number,
    advId: string,
    lockId: string | null,
  ) {
    const [n] = await this.deps.db
      .select()
      .from(noncePool)
      .where(eq(noncePool.seed_index, seedIndex))
      .limit(1);
    if (!n) return;
    const fresh = await readNonce(rt.client, address(n.nonce_account));
    const now = new Date(this.deps.now());
    await this.deps.db.transaction(async (tx) => {
      await tx
        .update(chainTxs)
        .set({ status: 'confirmed', rpc_confirmed_at: now })
        .where(eq(chainTxs.id, advId));
      if (lockId)
        await tx
          .update(chainTxs)
          .set({ status: 'revoked', revoked_by_tx_id: advId })
          .where(and(eq(chainTxs.id, lockId), inArray(chainTxs.status, ['built', 'signed'])));
      await tx
        .update(noncePool)
        .set(
          fresh
            ? {
                status: 'free',
                nonce_value: fresh.value,
                value_read_at: now,
                advance_tx_id: null,
                last_advanced_at: now,
                failures: 0,
              }
            : { status: 'retired', retired_at: now, advance_tx_id: null },
        )
        .where(and(eq(noncePool.seed_index, seedIndex), eq(noncePool.advance_tx_id, advId)));
    });
  }

  /** Sweep step 2 for one 'sent' lock whose confirm loop is not running (see sweep()). */
  private async sweepSentLock(
    rt: ChainRuntime,
    row: LockRow,
    nowMs: number,
    result: { expired: string[]; landed: string[] },
  ): Promise<void> {
    const st = await rt.client.signatureStatus(row.signature!, { searchHistory: true });
    if (
      st &&
      !st.err &&
      (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')
    ) {
      await this.onLanded(rt, row.bet_id, row.id, row.signature!, nowMs, nowMs, st.slot);
      result.landed.push(row.bet_id);
      return;
    }
    if (st?.err) {
      const why = failureReason(st.err);
      await this.failLock(row.bet_id, why.reason, why.party, null, { nonceAdvanced: true });
      return;
    }
    if (!row.expires_at || nowMs < row.expires_at.getTime()) {
      // Unseen and its confirm loop is gone (it timed out, or the server restarted, maybe
      // before the first send): re-broadcast the exact signed bytes. A durable-nonce tx is
      // valid until accept_deadline and can land at most once (its ix 0 advances the nonce),
      // so this is always safe; the next pass sees the status. Not in the last seconds before expires_at, so a re-send
      // never races the expire + revoke below.
      if (!st && row.expires_at && nowMs < row.expires_at.getTime() - LOCK_RESEND_STOP_MS)
        await this.rebroadcastLock(rt, row);
      return;
    }
    // Fate unknown at expires_at. A status lookup can miss a landed tx, so the chain decides:
    // the Bet PDA (Locked, our terms_hash) means it landed; a consumed nonce without one means
    // it never can; otherwise expire + revoke, and the next pass settles it either way.
    const fate = await this.lockFate(rt, row);
    if (fate === 'landed') {
      this.deps.log.warn('lock.landed_late', { bet_id: row.bet_id, signature: row.signature });
      await this.onLanded(rt, row.bet_id, row.id, row.signature!, nowMs, nowMs, st?.slot ?? null);
      result.landed.push(row.bet_id);
      return;
    }
    if (await this.expire(row.bet_id, row.id, nowMs)) result.expired.push(row.bet_id);
    if (fate === 'dead') {
      await this.deps.db
        .update(chainTxs)
        .set({ status: 'expired' })
        .where(and(eq(chainTxs.id, row.id), eq(chainTxs.status, 'sent')));
      await this.revokeOrRelease(row.bet_id, row.id, true);
    } else {
      await this.revokeOrRelease(row.bet_id, row.id, false);
    }
  }

  // ---- sweep (keeper) ---------------------------------------------------------------------

  /** Keeper task: expire locks past expires_at, settle sent locks, finish/retry nonce advances. */
  async sweep(nowMs: number): Promise<{ expired: string[]; landed: string[] }> {
    const rt = await this.o.runtime();
    const result = { expired: [] as string[], landed: [] as string[] };
    if (!rt) return result;
    const now = new Date(nowMs);

    // 1. built/signed past expires_at -> EXPIRED (accept_timeout) + revoke.
    const stale = await this.deps.db
      .select({ id: chainTxs.id, bet_id: chainTxs.bet_id })
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.kind, 'atomic_lock'),
          inArray(chainTxs.status, ['built', 'signed']),
          lte(chainTxs.expires_at, now),
        ),
      )
      .limit(25);
    for (const s of stale) {
      if (await this.expire(s.bet_id, s.id, nowMs)) {
        result.expired.push(s.bet_id);
        await this.revokeOrRelease(s.bet_id, s.id, false);
      }
    }

    // 2. sent locks whose confirm loop is not running (e.g. after a restart): ask the chain.
    //    searchTransactionHistory, since the default lookup only sees the recent status cache.
    const sent = await this.deps.db
      .select()
      .from(chainTxs)
      .where(and(eq(chainTxs.kind, 'atomic_lock'), eq(chainTxs.status, 'sent')))
      .limit(25);
    for (const row of sent) {
      if (this.confirming.has(row.id) || !row.signature) continue;
      try {
        await this.sweepSentLock(rt, row, nowMs, result);
      } catch (e) {
        // One bad row (undecodable stored bytes, an RPC error) must not stall every other lock.
        this.deps.log.error('lock.sweep_row_failed', {
          bet_id: row.bet_id,
          tx_id: row.id,
          error: String((e as Error)?.message ?? e).slice(0, 200),
        });
      }
    }

    // 3. advancing nonces: finish confirmed advances, retry failed ones.
    const advancing = await this.deps.db
      .select({ n: noncePool, adv: chainTxs })
      .from(noncePool)
      .innerJoin(chainTxs, eq(chainTxs.id, noncePool.advance_tx_id))
      .where(eq(noncePool.status, 'advancing'));
    for (const { n, adv } of advancing) {
      if (adv.status === 'sent' && adv.signature) {
        const st = await rt.client.signatureStatus(adv.signature);
        if (st && !st.err && st.confirmationStatus !== 'processed') {
          const [lock] = await this.deps.db
            .select({ id: chainTxs.id })
            .from(chainTxs)
            .where(
              and(
                eq(chainTxs.bet_id, adv.bet_id),
                eq(chainTxs.kind, 'atomic_lock'),
                inArray(chainTxs.status, ['built', 'signed']),
              ),
            )
            .limit(1);
          await this.finishAdvance(rt, n.seed_index, adv.id, lock?.id ?? null);
          continue;
        }
        if (!st && adv.sent_at && nowMs - adv.sent_at.getTime() > 60_000)
          await this.deps.db
            .update(chainTxs)
            .set({ status: 'expired' })
            .where(eq(chainTxs.id, adv.id));
        else continue;
      }
      if (n.failures >= 3) {
        await this.deps.db
          .update(noncePool)
          .set({ status: 'retired', retired_at: now, advance_tx_id: null })
          .where(eq(noncePool.seed_index, n.seed_index));
        continue;
      }
      await this.revokeNonce(rt, n, adv.bet_id);
    }

    // 4. 'sent' nonce advances no advancing nonce points at any more (the nonce was retired
    //    after 3 failures, or re-advanced by a later revoke): settle the row from the chain so
    //    it does not sit 'sent' for good. The nonce itself is already handled.
    const orphanAdvances = await this.deps.db
      .select()
      .from(chainTxs)
      .where(
        and(
          eq(chainTxs.kind, 'nonce_advance'),
          eq(chainTxs.status, 'sent'),
          isNotNull(chainTxs.signature),
          sql`NOT EXISTS (SELECT 1 FROM ${noncePool} p WHERE p.advance_tx_id = ${chainTxs.id})`,
        ),
      )
      .orderBy(asc(chainTxs.sent_at))
      .limit(25);
    const height = heightOnce(rt.client);
    for (const row of orphanAdvances) {
      // An unknown send time is never declared dead (txFate): such a row just waits.
      const { fate } = await txFate(rt.client, row.signature!, row.last_valid_block_height, {
        sentAtMs: row.sent_at?.getTime(),
        nowMs,
        height,
      });
      if (fate === 'pending') continue;
      await this.deps.db
        .update(chainTxs)
        .set(
          fate === 'landed'
            ? { status: 'confirmed', rpc_confirmed_at: now }
            : { status: fate === 'failed' ? 'failed' : 'expired', err: `orphan advance ${fate}` },
        )
        .where(and(eq(chainTxs.id, row.id), eq(chainTxs.status, 'sent')));
    }
    return result;
  }

  /** Re-sends a 'sent' lock's stored bytes (both party signatures + the fee payer's, re-signed). */
  private async rebroadcastLock(rt: ChainRuntime, row: LockRow): Promise<void> {
    if (!row.message_b64 || !row.a_signature || !row.b_signature) return;
    const [bet] = await this.deps.db
      .select({ a: bets.party_a_wallet, b: bets.party_b_wallet })
      .from(bets)
      .where(eq(bets.id, row.bet_id))
      .limit(1);
    if (!bet?.a || !bet.b) return;
    const full = await cosignTx(
      txFromStored(
        row.message_b64,
        new Map([
          [bet.a, sigBytes(row.a_signature)],
          [bet.b, sigBytes(row.b_signature)],
        ]),
      ),
      [rt.keys.feePayer],
    );
    // ed25519 is deterministic: the re-signed fee payer signature is the stored tx id.
    if (sigString(full.signatures[rt.keys.feePayer.address]!) !== row.signature) return;
    // Preflight stays ON (TM-N4: a doomed lock is rejected for free instead of burning the
    // nonce). A rejection here (already processed, nonce moved, deadline) changes nothing: the
    // status poll and the expires_at path below decide the lock's fate.
    await rt.client
      .send(wireOf(full), false)
      .then(() => this.deps.log.info('lock.rebroadcast', { bet_id: row.bet_id }))
      .catch((err: unknown) =>
        this.deps.log.warn('lock.rebroadcast_failed', { bet_id: row.bet_id, err }),
      );
  }

  /**
   * A sent lock's fate from chain state alone: 'landed' when the Bet PDA is Locked with the bet's
   * terms_hash; 'dead' when the lock's nonce value is consumed and no such Bet exists (the nonce
   * is read first, so a lock that consumed it is visible in the PDA read after); else 'unknown'.
   */
  private async lockFate(rt: ChainRuntime, row: LockRow): Promise<'landed' | 'dead' | 'unknown'> {
    const nonce = row.nonce_account ? await readNonce(rt.client, address(row.nonce_account)) : null;
    const [bet] = await this.deps.db
      .select({ terms_hash: bets.terms_hash })
      .from(bets)
      .where(eq(bets.id, row.bet_id))
      .limit(1);
    const onchain = await readBetAccount(rt, row.bet_id);
    if (
      onchain &&
      onchain.status === BetStatus.Locked &&
      bet?.terms_hash &&
      hexOf(onchain.termsHash) === bet.terms_hash
    )
      return 'landed';
    if (nonce && nonce.value !== row.nonce_value) return 'dead';
    return 'unknown';
  }

  /**
   * built/signed (or sent, fate unknown) at expires_at -> EXPIRED (accept_timeout; gemini:
   * quote_expired, SCHEMAS §8.3). `lockId` null: a gemini quote too old to build a lock for.
   */
  private async expire(betId: string, lockId: string | null, nowMs: number): Promise<boolean> {
    const out = await this.deps.db.transaction(async (tx) => {
      const bet = await lockBet(tx, betId);
      if (!bet || !['AWAITING_AUTHORIZATIONS', 'AWAITING_LOCK'].includes(bet.state)) return null;
      const reason = bet.evidence_source === 'gemini' ? 'quote_expired' : 'accept_timeout';
      const [moved] = await tx
        .update(bets)
        .set({ state: 'EXPIRED', end_reason: reason })
        .where(eq(bets.id, betId))
        .returning();
      if (lockId)
        await tx
          .update(chainTxs)
          .set({ err: 'expired' })
          .where(
            and(
              eq(chainTxs.id, lockId),
              or(
                eq(chainTxs.status, 'built'),
                eq(chainTxs.status, 'signed'),
                eq(chainTxs.status, 'sent'),
              ),
              isNull(chainTxs.err),
            ),
          );
      const envs = [
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'bet.state',
          payload: statePayload(moved!, bet.state, reason),
          now: nowMs,
        }),
        await appendBetEvent(tx, {
          bet_id: betId,
          type: 'judge.cue',
          payload: judgeCue(
            'EXPIRED',
            { reason },
            reason === 'quote_expired'
              ? "Say Gemini's quote ran out before both locked in. Nothing moved; ask for a fresh quote."
              : 'Say the lock window closed before both locked in. Nothing moved.',
          ),
          now: nowMs,
        }),
      ];
      return { bet, envs };
    });
    if (!out) return false;
    fanout(this.deps, out.bet, out.envs);
    return true;
  }
}

async function partyNames(tx: Pick<Tx, 'select'>, bet: Pick<BetRow, 'party_a_id' | 'party_b_id'>) {
  const rows = await tx
    .select({ id: users.id, name: users.display_name })
    .from(users)
    .where(inArray(users.id, [bet.party_a_id, bet.party_b_id]));
  const by = new Map(rows.map((r) => [r.id, r.name]));
  return { A: by.get(bet.party_a_id) ?? 'A', B: by.get(bet.party_b_id) ?? 'B' } as Record<
    Party,
    string
  >;
}

/**
 * Upserts nonce_pool rows for pool accounts k = 0..NONCE_POOL_SIZE-1 that exist on chain with the
 * fee payer as authority (scripts/nonce-pool.ts creates them). Free rows get the current value.
 */
export async function syncNoncePool(
  deps: Pick<LifecycleDeps, 'db' | 'now'>,
  rt: ChainRuntime,
): Promise<number> {
  let n = 0;
  const now = new Date(deps.now());
  for (let k = 0; k < NONCE_POOL_SIZE; k++) {
    const account = await poolAddress(rt.keys.feePayer.address, k);
    const st = await readNonce(rt.client, account);
    if (!st || st.authority !== rt.keys.feePayer.address) continue;
    await deps.db
      .insert(noncePool)
      .values({
        seed_index: k,
        nonce_account: account,
        authority: st.authority,
        status: 'free',
        nonce_value: st.value,
        value_read_at: now,
      })
      .onConflictDoUpdate({
        target: noncePool.seed_index,
        set: { nonce_value: st.value, value_read_at: now },
        setWhere: sql`${noncePool.status} = 'free' AND ${noncePool.nonce_account} = ${account}`,
      });
    n++;
  }
  return n;
}

/**
 * chain_txs-based lock-signature lookup (DATA-MODEL §8.2 step 2) for chain/projector.ts: the
 * signature of the bet's confirmed or sent atomic_lock. Swap it in for betsColumnLockSignatures
 * once a full projector clears onchain_pending.
 */
export async function lockSignaturesFromChainTxs(
  tx: Pick<Tx, 'select'>,
  betIds: readonly string[],
): Promise<Map<string, string>> {
  if (!betIds.length) return new Map();
  const rows = await tx
    .select({ bet_id: chainTxs.bet_id, signature: chainTxs.signature })
    .from(chainTxs)
    .where(
      and(
        inArray(chainTxs.bet_id, [...betIds]),
        eq(chainTxs.kind, 'atomic_lock'),
        inArray(chainTxs.status, ['sent', 'confirmed']),
      ),
    );
  return new Map(rows.filter((r) => r.signature).map((r) => [r.bet_id, r.signature!]));
}
