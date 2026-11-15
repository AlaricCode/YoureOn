// RPC harness for the local-validator suite (ESCROW §9.1): talks to the solana-test-validator that
// scripts/test-validator.sh started (VALIDATOR_RPC, default http://127.0.0.1:18899) with the escrow
// program loaded upgradeable under a throwaway authority (VALIDATOR_ADMIN_KEYPAIR). Same parties as
// the LiteSVM harness: S (fee payer, rent payer, nonce authority) is the only funded key besides
// the admin; A, B, judge and appeal hold 0 lamports. Airdrops use that validator's own faucet.
import { readFileSync } from 'node:fs';

import {
  decodeNonce,
  getCreateAccountInstruction,
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getNonceSize,
} from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  createAddressWithSeed,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  fetchEncodedAccount,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getI64Decoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  isSolanaError,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit';

import {
  decodeBet,
  ESCROW_PROGRAM_ADDRESS,
  findConfigPda,
  getInitializeConfigInstructionAsync,
  identifyEscrowEvent,
  type EscrowEvent,
} from '@youre-on/shared/escrow-client';
import { nonceSeed, SYSTEM_PROGRAM_ID } from '../../src/chain/constants';

export const RPC_URL = process.env['VALIDATOR_RPC'] ?? 'http://127.0.0.1:18899';
const ADMIN_KEYPAIR = process.env['VALIDATOR_ADMIN_KEYPAIR'];
/** Set only by scripts/test-validator.sh; without it the suite is skipped. */
export const HAVE_VALIDATOR = ADMIN_KEYPAIR !== undefined;

export const USDC = 1_000_000n;
export const SIG_FEE = 5_000n;
export const TOKEN_ACCOUNT_SIZE = 165n;

const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR_CLOCK = address('SysvarC1ock11111111111111111111111111111111');
const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export const rpc = createSolanaRpc(RPC_URL);
export type Rpc = typeof rpc;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function balance(who: Address): Promise<bigint> {
  return (await rpc.getBalance(who, { commitment: 'confirmed' }).send()).value;
}

export async function tokenAmount(account: Address): Promise<bigint> {
  const r = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send();
  return BigInt(r.value.amount);
}

export async function exists(addr: Address): Promise<boolean> {
  return (await fetchEncodedAccount(rpc, addr, { commitment: 'confirmed' })).exists;
}

export async function readNonce(account: Address): Promise<string> {
  const acc = await fetchEncodedAccount(rpc, account, { commitment: 'confirmed' });
  if (!acc.exists) throw new Error('nonce account missing');
  return decodeNonce(acc).data.blockhash;
}

export async function readBet(addr: Address) {
  const acc = await fetchEncodedAccount(rpc, addr, { commitment: 'confirmed' });
  if (!acc.exists) throw new Error(`bet ${addr} missing`);
  return { data: decodeBet(acc).data, len: BigInt(acc.data.length) };
}

/** Cluster `Clock.unix_timestamp` (slot u64 | epoch_start i64 | epoch u64 | lse u64 | unix i64). */
export async function clockNow(): Promise<bigint> {
  const acc = await fetchEncodedAccount(rpc, SYSVAR_CLOCK, { commitment: 'processed' });
  if (!acc.exists) throw new Error('clock sysvar missing');
  return getI64Decoder().decode(acc.data, 32);
}

export async function rentExempt(space: bigint): Promise<bigint> {
  return rpc.getMinimumBalanceForRentExemption(space).send();
}

export type Landed = {
  signature: Signature;
  /** ms from send() to the first `processed` / `confirmed` status. */
  processedMs: number;
  confirmedMs: number;
  err: unknown;
};

/** Poll getSignatureStatuses every 20 ms until `confirmed` (or `timeoutMs`). */
async function waitConfirmed(sig: Signature, t0: number, timeoutMs = 30_000): Promise<Landed> {
  let processedMs = -1;
  for (;;) {
    const [st] = (await rpc.getSignatureStatuses([sig]).send()).value;
    const elapsed = performance.now() - t0;
    if (st) {
      if (processedMs < 0) processedMs = elapsed;
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
        return { signature: sig, processedMs, confirmedMs: elapsed, err: st.err };
      }
    }
    if (elapsed > timeoutMs) throw new Error(`tx ${sig} not confirmed after ${timeoutMs} ms`);
    await sleep(20);
  }
}

export type SendOpts = { skipPreflight?: boolean };

/** sendTransaction (preflight ON by default, `processed`, as LockService) and wait for confirmed. */
export async function sendAndConfirm(tx: Transaction, opts: SendOpts = {}): Promise<Landed> {
  const wire = getBase64EncodedWireTransaction(tx);
  const t0 = performance.now();
  const sig = await rpc
    .sendTransaction(wire, {
      encoding: 'base64',
      skipPreflight: opts.skipPreflight ?? false,
      preflightCommitment: 'processed',
    })
    .send();
  if (sig !== getSignatureFromTransaction(tx)) throw new Error('rpc returned another signature');
  return waitConfirmed(sig, t0);
}

export type PreflightRejection = { logs: readonly string[]; detail: string };

/** Send with preflight on and expect the RPC to refuse it (-32002). */
export async function expectPreflightReject(tx: Transaction): Promise<PreflightRejection> {
  try {
    await sendAndConfirm(tx);
  } catch (e) {
    if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)) {
      const parts: string[] = [];
      for (let c: unknown = e; c instanceof Error; c = c.cause) {
        parts.push(
          `${c.message} ${JSON.stringify((c as { context?: unknown }).context ?? {}, big)}`,
        );
      }
      return { logs: e.context.logs ?? [], detail: parts.join(' <- ') };
    }
    throw e;
  }
  throw new Error('expected a -32002 preflight rejection; the tx was accepted');
}

function big(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

export async function simulateCu(tx: Transaction): Promise<{ units: bigint; err: unknown }> {
  const r = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(tx), {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: 'processed',
    })
    .send();
  return { units: r.value.unitsConsumed ?? 0n, err: r.value.err };
}

export async function buildTx(
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
): Promise<Transaction> {
  const { value: bh } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return signTransactionMessageWithSigners(msg);
}

/** Build, send (preflight on), confirm; throw if it failed. */
export async function send(
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
): Promise<Landed> {
  const landed = await sendAndConfirm(await buildTx(feePayer, ixs));
  if (landed.err)
    throw new Error(`tx ${landed.signature} failed: ${JSON.stringify(landed.err, big)}`);
  return landed;
}

export async function airdrop(to: Address, amount: bigint): Promise<void> {
  const sig = await rpc.requestAirdrop(to, lamports(amount), { commitment: 'confirmed' }).send();
  await waitConfirmed(sig, performance.now());
}

export type TxInfo = {
  fee: bigint;
  cu: bigint;
  err: unknown;
  logs: readonly string[];
  events: { outer: number; kind: EscrowEvent }[];
};

/** getTransaction(confirmed): fee, CU, error and every emit_cpi! event by outer ix. */
export async function txInfo(sig: Signature): Promise<TxInfo> {
  for (let i = 0; i < 100; i++) {
    const tx = await rpc
      .getTransaction(sig, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (tx?.meta) {
      const keys = tx.transaction.message.accountKeys;
      const b58 = getBase58Encoder();
      const events: TxInfo['events'] = [];
      for (const group of tx.meta.innerInstructions ?? []) {
        for (const ix of group.instructions) {
          if (keys[ix.programIdIndex] !== ESCROW_PROGRAM_ADDRESS) continue;
          const data = b58.encode(ix.data);
          if (!EVENT_IX_TAG.every((b, j) => data[j] === b)) continue;
          events.push({
            outer: group.index,
            kind: identifyEscrowEvent(data.slice(EVENT_IX_TAG.length)),
          });
        }
      }
      return {
        fee: BigInt(tx.meta.fee),
        cu: BigInt(tx.meta.computeUnitsConsumed ?? 0n),
        err: tx.meta.err,
        logs: tx.meta.logMessages ?? [],
        events,
      };
    }
    await sleep(50);
  }
  throw new Error(`getTransaction(${sig}) returned nothing`);
}

export type VEnv = {
  admin: KeyPairSigner;
  s: KeyPairSigner;
  judge: KeyPairSigner;
  appeal: KeyPairSigner;
  a: KeyPairSigner;
  b: KeyPairSigner;
  m: KeyPairSigner;
  mint: Address;
  mintAuthority: KeyPairSigner;
  aToken: Address;
  bToken: Address;
  mToken: Address;
  config: Address;
};

export async function programDataAddress(): Promise<Address> {
  const [pd] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(ESCROW_PROGRAM_ADDRESS)],
  });
  return pd;
}

export function demoConfigArgs(env: Pick<VEnv, 'judge' | 'appeal' | 'mint'>) {
  return {
    judgeAuthority: env.judge.address,
    appealAuthority: env.appeal.address,
    maxStake: 50n * USDC,
    appealWindowSecs: 10,
    acceptDeadlineSecs: 600,
    resolveDeadlineSecs: 3600,
    appealResolveSecs: 300,
    allowedMints: [env.mint],
  };
}

/** Fund S/admin/Mallory from the local faucet, create the 6-dp mint + ATAs, initialize Config. */
export async function setupValidatorEnv(funded: bigint): Promise<VEnv> {
  if (!ADMIN_KEYPAIR) throw new Error('VALIDATOR_ADMIN_KEYPAIR unset (run via test:validator)');
  const admin = await createKeyPairSignerFromBytes(
    Uint8Array.from(JSON.parse(readFileSync(ADMIN_KEYPAIR, 'utf8')) as number[]),
  );
  const [s, judge, appeal, a, b, m, mintKp] = await Promise.all(
    Array.from({ length: 7 }, () => generateKeyPairSigner()),
  );
  if (!s || !judge || !appeal || !a || !b || !m || !mintKp) throw new Error('keygen');
  await Promise.all([
    airdrop(admin.address, 10_000_000_000n),
    airdrop(s.address, 100_000_000_000n),
    airdrop(m.address, 1_000_000_000n),
  ]);

  const mintSpace = BigInt(getMintSize());
  const ata = async (owner: Address) =>
    (
      await findAssociatedTokenPda({
        owner,
        mint: mintKp.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      })
    )[0];
  const [aToken, bToken, mToken] = await Promise.all([
    ata(a.address),
    ata(b.address),
    ata(m.address),
  ]);
  await send(s, [
    getCreateAccountInstruction({
      payer: s,
      newAccount: mintKp,
      lamports: await rentExempt(mintSpace),
      space: mintSpace,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mintKp.address,
      decimals: 6,
      mintAuthority: s.address,
      freezeAuthority: s.address,
    }),
    ...(await Promise.all(
      [a, b, m].map((o) =>
        getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: s,
          owner: o.address,
          mint: mintKp.address,
        }),
      ),
    )),
    ...[aToken, bToken, mToken].map((token) =>
      getMintToCheckedInstruction({
        mint: mintKp.address,
        token,
        mintAuthority: s,
        amount: funded,
        decimals: 6,
      }),
    ),
  ]);

  const [config] = await findConfigPda();
  const env: VEnv = {
    admin,
    s,
    judge,
    appeal,
    a,
    b,
    m,
    mint: mintKp.address,
    mintAuthority: s,
    aToken,
    bToken,
    mToken,
    config,
  };
  await send(admin, [
    await getInitializeConfigInstructionAsync({
      admin,
      programData: await programDataAddress(),
      ...demoConfigArgs(env),
    }),
  ]);
  return env;
}

/** Nonce-pool entry k: createWithSeed(S, "yo-nonce-k", System), authority S (DATA-MODEL §5.20). */
export async function createPoolNonce(
  env: VEnv,
  k: number,
): Promise<{ account: Address; value: string }> {
  const seed = nonceSeed(k);
  const account = await createAddressWithSeed({
    baseAddress: env.s.address,
    seed,
    programAddress: address(SYSTEM_PROGRAM_ID),
  });
  const space = BigInt(getNonceSize());
  await send(env.s, [
    getCreateAccountWithSeedInstruction({
      payer: env.s,
      newAccount: account,
      baseAccount: env.s,
      base: env.s.address,
      seed,
      amount: await rentExempt(space),
      space,
      programAddress: address(SYSTEM_PROGRAM_ID),
    }),
    getInitializeNonceAccountInstruction({ nonceAccount: account, nonceAuthority: env.s.address }),
  ]);
  return { account, value: await readNonce(account) };
}

export function betId(n: number): Uint8Array {
  const id = new Uint8Array(16);
  crypto.getRandomValues(id);
  id[6] = (id[6]! & 0x0f) | 0x40;
  id[8] = (id[8]! & 0x3f) | 0x80;
  id[15] = n & 0xff;
  return id;
}

export function hash32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export function sleepMs(ms: number): Promise<void> {
  return sleep(ms);
}
