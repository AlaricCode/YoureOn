// POST /v1/demo/rebalance (DEMO_MODE + admin key): move USDC between the custodial demo wallets
// demo-a and demo-b so each holds the same amount, so rehearsals where B always wins do not drain
// A. One transaction [ATA create (if missing), TransferChecked richer -> poorer] paid by the fee
// payer (the demo wallets hold 0 SOL) and signed by the richer wallet's custodial key.
//
// Retry safety: a rebalance computed from balances read while an earlier one may still land would
// overshoot (A=10 B=0 -> move 5 -> confirm times out -> a retry reads A=10 B=0 again -> 5 more).
// So the last rebalance (in memory, and in audit_log 'demo.rebalance_sent' across a restart) must
// be known landed or known dead before a new one is built; otherwise 409 rebalance_in_flight.
// It also refuses while a bet of the demo pair is about to lock (the lock would lose its funds).
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { getBase58Decoder, type Address, type KeyPairSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintDecoder,
  getTokenDecoder,
  getTransferCheckedInstruction,
} from '@solana-program/token';
import { auditLog, bets } from '@youre-on/db';
import { formatUsd } from '@youre-on/shared/money';
import type { AppDeps } from '../context';
import { HttpError } from '../errors';
import {
  buildBlockhashTx,
  confirmSent,
  PreflightError,
  TxFailedError,
  txFate,
  wireOf,
  type ChainRuntime,
  type SendOptions,
} from '../chain/tx';

/** Below this difference the wallets count as balanced (no tx). */
export const REBALANCE_TOLERANCE_MICRO = 10_000n; // $0.01
/** An audit row older than this (DB clock) cannot describe a tx that may still land (~60-90 s). */
const REBALANCE_LOOKBACK_MS = 5 * 60_000;

export interface RebalanceResult {
  status: 'balanced' | 'moved';
  before: { a: string; b: string };
  after: { a: string; b: string };
  moved: string;
  moved_display: string;
  from: 'demo-a' | 'demo-b' | null;
  signature: string | null;
}

type Deps = Pick<AppDeps, 'db' | 'log' | 'now'>;

const b58 = getBase58Decoder();
type LastTx = { signature: string; lvbh: bigint | null };
/** The last rebalance sent through each chain client (one per server process in practice). */
const lastSent = new WeakMap<object, LastTx>();

/** Test hook: forget the in-memory last rebalance (as a restart would). */
export function forgetLastRebalance(rt: ChainRuntime): void {
  lastSent.delete(rt.client);
}

async function ataOf(owner: Address, mint: Address, tokenProgram: Address) {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
}

/** The last rebalance must be landed or dead before another is built (see the header). */
async function assertNoneInFlight(deps: Deps, rt: ChainRuntime) {
  let prev = lastSent.get(rt.client) ?? null;
  if (!prev) {
    const [row] = await deps.db
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'demo.rebalance_sent'),
          sql`${auditLog.details}->>'fee_payer' = ${rt.keys.feePayer.address}`,
          gt(auditLog.at, sql`now() - make_interval(secs => ${REBALANCE_LOOKBACK_MS / 1000})`),
        ),
      )
      .orderBy(desc(auditLog.at))
      .limit(1);
    const d = row?.details as { signature?: string; lvbh?: string | null } | undefined;
    if (d?.signature) prev = { signature: d.signature, lvbh: d.lvbh ? BigInt(d.lvbh) : null };
  }
  if (!prev) return;
  // Without an lvbh (never for ours) a 5-min-old audit row is past any blockhash lifetime.
  const { fate } = await txFate(rt.client, prev.signature, prev.lvbh, {
    sentAtMs: deps.now() - REBALANCE_LOOKBACK_MS - 1,
  });
  if (fate !== 'pending') {
    lastSent.delete(rt.client); // landed, failed or known dead: a new one is safe
    return;
  }
  throw new HttpError(
    'INVALID_STATE',
    'The last rebalance is still in flight. Try again shortly.',
    {
      reason: 'rebalance_in_flight',
      signature: prev.signature,
    },
  );
}

/** Moves USDC between demo-a and demo-b until they hold the same amount (± 1 micro-unit). */
/** Rebalances of one chain client run one at a time (the check above is check-then-set). */
const queues = new WeakMap<object, Promise<unknown>>();

export function rebalanceDemoWallets(
  deps: Deps,
  rt: ChainRuntime,
  o: { send?: SendOptions; requestId?: string } = {},
): Promise<RebalanceResult> {
  const prev = queues.get(rt.client) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => rebalanceOnce(deps, rt, o));
  queues.set(
    rt.client,
    run.catch(() => {}),
  );
  return run;
}

async function rebalanceOnce(
  deps: Deps,
  rt: ChainRuntime,
  o: { send?: SendOptions; requestId?: string },
): Promise<RebalanceResult> {
  const { demoA, demoB, feePayer } = rt.keys;
  if (!demoA || !demoB)
    throw new HttpError('INVALID_STATE', 'DEMO_A_SECRET_KEY / DEMO_B_SECRET_KEY are not set.', {
      reason: 'demo_keys_missing',
    });
  // A lock in progress between the demo wallets would lose its funds under it.
  const [locking] = await deps.db
    .select({ id: bets.id, state: bets.state })
    .from(bets)
    .where(
      and(
        inArray(bets.state, ['AWAITING_AUTHORIZATIONS', 'AWAITING_LOCK']),
        or(
          inArray(bets.party_a_wallet, [demoA.address, demoB.address]),
          inArray(bets.party_b_wallet, [demoA.address, demoB.address]),
        ),
      ),
    )
    .limit(1);
  if (locking)
    throw new HttpError('INVALID_STATE', 'A demo bet is locking right now. Try after it lands.', {
      reason: 'lock_in_progress',
      bet_id: locking.id,
      state: locking.state,
    });
  await assertNoneInFlight(deps, rt);

  const mintAcc = await rt.client.getAccount(rt.mint);
  if (!mintAcc) throw new HttpError('RPC_UNAVAILABLE', `Mint ${rt.mint} not found.`);
  const tokenProgram = mintAcc.owner;
  const decimals = getMintDecoder().decode(mintAcc.data).decimals;
  const [aTok, bTok] = [
    await ataOf(demoA.address, rt.mint, tokenProgram),
    await ataOf(demoB.address, rt.mint, tokenProgram),
  ];
  const balance = async (tok: Address) => {
    const acc = await rt.client.getAccount(tok);
    if (!acc) return { exists: false, amount: 0n };
    return { exists: true, amount: getTokenDecoder().decode(acc.data).amount };
  };
  const [a, b] = [await balance(aTok), await balance(bTok)];
  const target = (a.amount + b.amount) / 2n;
  const diff = a.amount > b.amount ? a.amount - target : b.amount - target;
  const before = { a: a.amount.toString(), b: b.amount.toString() };
  if (diff <= REBALANCE_TOLERANCE_MICRO)
    return {
      status: 'balanced',
      before,
      after: before,
      moved: '0',
      moved_display: formatUsd('0'),
      from: null,
      signature: null,
    };

  const [fromKey, fromTok, toKey, toTok, toExists]: [
    KeyPairSigner,
    Address,
    KeyPairSigner,
    Address,
    boolean,
  ] =
    a.amount > b.amount
      ? [demoA, aTok, demoB, bTok, b.exists]
      : [demoB, bTok, demoA, aTok, a.exists];
  const ixs = [
    ...(toExists
      ? []
      : [
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: feePayer,
            owner: toKey.address,
            mint: rt.mint,
            tokenProgram,
          }),
        ]),
    getTransferCheckedInstruction(
      {
        source: fromTok,
        mint: rt.mint,
        destination: toTok,
        authority: fromKey,
        amount: diff,
        decimals,
      },
      { programAddress: tokenProgram },
    ),
  ];
  const built = await buildBlockhashTx(rt.client, feePayer.address, ixs, {
    signers: [feePayer, fromKey],
    label: 'demo rebalance',
  });
  const signature = b58.decode(built.tx.signatures[feePayer.address]!);
  const from = fromKey.address === demoA.address ? 'demo-a' : 'demo-b';
  lastSent.set(rt.client, { signature, lvbh: built.lastValidBlockHeight });
  await deps.db.insert(auditLog).values({
    actor_kind: 'system',
    action: 'demo.rebalance_sent',
    request_id: o.requestId ?? null,
    details: {
      signature,
      fee_payer: feePayer.address,
      lvbh: built.lastValidBlockHeight?.toString() ?? null,
      from,
      amount: diff.toString(),
      before,
    },
  });
  try {
    await rt.client.send(wireOf(built.tx), false);
  } catch (err) {
    if (err instanceof PreflightError) {
      lastSent.delete(rt.client); // rejected at preflight: nothing landed
      throw new HttpError('UPSTREAM_ERROR', `Rebalance rejected: ${err.message.slice(0, 120)}`);
    }
    deps.log.warn('demo.rebalance_send_retry', { err }); // confirm re-broadcasts
  }
  try {
    await confirmSent(rt.client, built.tx, {
      ...o.send,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
  } catch (err) {
    if (err instanceof TxFailedError && err.kind !== 'timeout') lastSent.delete(rt.client);
    if (err instanceof TxFailedError && err.kind === 'timeout')
      throw new HttpError('UPSTREAM_TIMEOUT', 'The rebalance is still confirming. Check again.', {
        reason: 'rebalance_in_flight',
        signature,
      });
    throw err;
  }
  lastSent.delete(rt.client);
  const after =
    from === 'demo-a'
      ? { a: (a.amount - diff).toString(), b: (b.amount + diff).toString() }
      : { a: (a.amount + diff).toString(), b: (b.amount - diff).toString() };
  await deps.db.insert(auditLog).values({
    actor_kind: 'system',
    action: 'demo.rebalance_confirmed',
    request_id: o.requestId ?? null,
    details: { signature, from, amount: diff.toString(), after },
  });
  deps.log.info('demo.rebalanced', { from, amount: diff, signature });
  return {
    status: 'moved',
    before,
    after,
    moved: diff.toString(),
    moved_display: formatUsd(diff.toString()),
    from,
    signature,
  };
}
