// LiteSVM harness for the TS client suite (ESCROW §9.1): the built escrow.so under the upgradeable
// loader, the real SPL Token + ATA programs, a 6-dp "USDC" mint, the server fee payer S (the only
// funded key), the judge/appeal keys and two device keys A and B that hold 0 lamports throughout.
// Every escrow instruction here is built with the Codama client (@youre-on/shared/escrow-client).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  getCreateAccountWithSeedInstruction,
  getInitializeNonceAccountInstruction,
  getCreateAccountInstruction,
  decodeNonce,
  getNonceSize,
} from '@solana-program/system';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
  address,
  appendTransactionMessageInstructions,
  createAddressWithSeed,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getU32Encoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingDurableNonce,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit';
import { Clock, FailedTransactionMetadata, LiteSVM, type TransactionMetadata } from 'litesvm';

import {
  ESCROW_PROGRAM_ADDRESS,
  findConfigPda,
  getInitializeConfigInstructionAsync,
  identifyEscrowEvent,
  type EscrowEvent,
} from '@youre-on/shared/escrow-client';
import { ESCROW_ID, nonceSeed, SYSTEM_PROGRAM_ID } from '../../src/chain/constants';

/** The `anchor build` output; ESCROW_SO overrides the path. */
export const ESCROW_SO =
  process.env['ESCROW_SO'] ??
  fileURLToPath(new URL('../../../../programs/escrow/target/deploy/escrow.so', import.meta.url));
export const HAVE_SO = existsSync(ESCROW_SO);
export const SO_REQUIRED = process.env['ESCROW_SO_REQUIRED'] === '1';

/** E3 mimic test program (programs/escrow/test-programs/mimic; declare_id!, no keypair exists). */
export const MIMIC_ID = address('7kSL4sqMG2PDAGaDoeEiV8WS86wYkUYBbRsuZHkSkGgh');
/** Built by packages/shared/scripts/build-mimic.sh; MIMIC_SO overrides the path. */
export const MIMIC_SO =
  process.env['MIMIC_SO'] ??
  fileURLToPath(
    new URL(
      '../../../../programs/escrow/test-programs/mimic/target/deploy/mimic.so',
      import.meta.url,
    ),
  );
export const HAVE_MIMIC = existsSync(MIMIC_SO);

export const NOW = 1_800_000_000n;
export const USDC = 1_000_000n; // 1 USDC in micro-units (6 dp)
export const FUNDED = 100n * USDC;
export const SIG_FEE = 5_000n;
/** Token account size (classic SPL): the vault's rent basis. */
export const TOKEN_ACCOUNT_SIZE = 165n;

const BPF_LOADER_UPGRADEABLE = address('BPFLoaderUpgradeab1e11111111111111111111111');
const COMPUTE_BUDGET = address('ComputeBudget111111111111111111111111111111');
/** Anchor's EVENT_IX_TAG (u64 0x1d9acb512ea545e4, little-endian): prefix of every emit_cpi! self-CPI. */
const EVENT_IX_TAG = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

export type Sent = { tx: Transaction; meta: TransactionMetadata };
export type Failed = { tx: Transaction; failed: FailedTransactionMetadata };

export type Env = {
  svm: LiteSVM;
  admin: KeyPairSigner;
  /** Server fee payer = rent payer = durable-nonce authority. */
  s: KeyPairSigner;
  judge: KeyPairSigner;
  appeal: KeyPairSigner;
  a: KeyPairSigner;
  b: KeyPairSigner;
  mint: Address;
  aToken: Address;
  bToken: Address;
  config: Address;
};

export function lamportsOf(svm: LiteSVM, who: Address): bigint {
  return svm.getBalance(who) ?? 0n;
}

export function tokenAmount(svm: LiteSVM, account: Address): bigint {
  const acc = svm.getAccount(account);
  if (!acc.exists) throw new Error(`token account ${account} does not exist`);
  return getTokenDecoder().decode(acc.data).amount;
}

export function setNow(svm: LiteSVM, unix: bigint): void {
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unix));
}

export function now(svm: LiteSVM): bigint {
  return svm.getClock().unixTimestamp;
}

/** `SetComputeUnitLimit` (ComputeBudget ix 2, u32 LE). */
export function setComputeUnitLimit(units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET,
    data: new Uint8Array([2, ...getU32Encoder().encode(units)]),
  };
}

/** Fee payer `feePayer`, a recent blockhash, v0 with no lookup tables (ESCROW §5.0). */
export async function buildTx(
  svm: LiteSVM,
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
): Promise<Transaction> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return signTransactionMessageWithSigners(msg);
}

/** The same, on a durable nonce: kit prepends `AdvanceNonceAccount` as ix 0 (ESCROW §5.0.1). */
export async function buildNonceTx(
  feePayer: TransactionSigner,
  nonce: { account: Address; value: string },
  ixs: readonly Instruction[],
): Promise<Transaction> {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingDurableNonce(
        {
          nonce: nonce.value as Parameters<
            typeof setTransactionMessageLifetimeUsingDurableNonce
          >[0]['nonce'],
          nonceAccountAddress: nonce.account,
          nonceAuthorityAddress: feePayer.address,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return signTransactionMessageWithSigners(msg);
}

export function submit(svm: LiteSVM, tx: Transaction): Sent | Failed {
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  return res instanceof FailedTransactionMetadata ? { tx, failed: res } : { tx, meta: res };
}

export function expectOk(r: Sent | Failed): Sent {
  if ('failed' in r) {
    throw new Error(`tx failed: ${r.failed.toString()}\n${r.failed.meta().prettyLogs()}`);
  }
  return r;
}

export async function send(
  svm: LiteSVM,
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
): Promise<Sent> {
  return expectOk(submit(svm, await buildTx(svm, feePayer, ixs)));
}

/** `Custom(code)` at outer instruction `index`, or null. */
export function customError(f: FailedTransactionMetadata): { index: number; code: number } | null {
  const err = f.err() as unknown as { index?: number; err?: () => unknown };
  if (typeof err.index !== 'number' || typeof err.err !== 'function') return null;
  const inner = err.err() as { code?: unknown };
  return typeof inner.code === 'number' ? { index: err.index, code: inner.code } : null;
}

export type DecodedEvent = { outer: number; kind: EscrowEvent; data: Uint8Array };

/**
 * Every `emit_cpi!` event in a landed tx, in order: inner instructions invoking the escrow program
 * whose data starts with EVENT_IX_TAG; `data` is the rest (event discriminator + borsh payload).
 */
export function escrowEvents(sent: Sent): DecodedEvent[] {
  const compiled = getCompiledTransactionMessageDecoder().decode(sent.tx.messageBytes);
  const out: DecodedEvent[] = [];
  sent.meta.innerInstructions().forEach((inners, outer) => {
    for (const inner of inners) {
      const ix = inner.instruction();
      if (compiled.staticAccounts[ix.programIdIndex()] !== ESCROW_PROGRAM_ADDRESS) continue;
      const data = ix.data();
      if (!EVENT_IX_TAG.every((b, i) => data[i] === b)) continue;
      const payload = data.slice(EVENT_IX_TAG.length);
      out.push({ outer, kind: identifyEscrowEvent(payload), data: payload });
    }
  });
  return out;
}

/** ESCROW §9.1 gotcha: give the program an upgradeable ProgramData whose authority is `admin`. */
async function setUpgradeAuthority(svm: LiteSVM, admin: Address): Promise<void> {
  const [programData] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(ESCROW_PROGRAM_ADDRESS)],
  });
  const acc = svm.getAccount(programData);
  if (!acc.exists) throw new Error('litesvm did not create an upgradeable ProgramData account');
  const data = new Uint8Array(acc.data);
  // UpgradeableLoaderState::ProgramData = tag u32 (3) | slot u64 | Option<Pubkey> (1 + 32) | ELF
  if (data[0] !== 3) throw new Error(`unexpected ProgramData tag ${data[0]}`);
  data[12] = 1;
  data.set(getAddressEncoder().encode(admin), 13);
  svm.setAccount({ ...acc, data });
}

/** Demo Config values (ESCROW §3.1), allowlist = [mint]. */
export function demoConfigArgs(env: Pick<Env, 'judge' | 'appeal' | 'mint'>) {
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

/** A fresh SVM with the program, the mint, both parties' funded ATAs and (optionally) Config. */
export async function newEnv(opts: { initConfig?: boolean } = {}): Promise<Env & { init?: Sent }> {
  if (address(ESCROW_ID) !== ESCROW_PROGRAM_ADDRESS) {
    throw new Error('generated client address != ESCROW_ID');
  }
  const svm = new LiteSVM();
  svm.addProgramFromFile(ESCROW_PROGRAM_ADDRESS, ESCROW_SO);
  setNow(svm, NOW);

  const [admin, s, judge, appeal, a, b, mintKp] = await Promise.all(
    Array.from({ length: 7 }, () => generateKeyPairSigner()),
  );
  if (!admin || !s || !judge || !appeal || !a || !b || !mintKp) throw new Error('keygen');
  await setUpgradeAuthority(svm, admin.address);
  svm.airdrop(admin.address, lamports(10_000_000_000n));
  svm.airdrop(s.address, lamports(10_000_000_000n));

  // S funds and creates everything (mint, both ATAs) and mints 100 USDC to each party.
  const mintSpace = BigInt(getMintSize());
  const [aToken] = await findAssociatedTokenPda({
    owner: a.address,
    mint: mintKp.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [bToken] = await findAssociatedTokenPda({
    owner: b.address,
    mint: mintKp.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  await send(svm, s, [
    getCreateAccountInstruction({
      payer: s,
      newAccount: mintKp,
      lamports: svm.minimumBalanceForRentExemption(mintSpace),
      space: mintSpace,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint: mintKp.address,
      decimals: 6,
      mintAuthority: s.address,
      freezeAuthority: s.address, // devnet USDC has a freeze authority set (ESCROW §2)
    }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: s,
      owner: a.address,
      mint: mintKp.address,
    }),
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: s,
      owner: b.address,
      mint: mintKp.address,
    }),
    getMintToCheckedInstruction({
      mint: mintKp.address,
      token: aToken,
      mintAuthority: s,
      amount: FUNDED,
      decimals: 6,
    }),
    getMintToCheckedInstruction({
      mint: mintKp.address,
      token: bToken,
      mintAuthority: s,
      amount: FUNDED,
      decimals: 6,
    }),
  ]);

  const [config] = await findConfigPda();
  const env: Env & { init?: Sent } = {
    svm,
    admin,
    s,
    judge,
    appeal,
    a,
    b,
    mint: mintKp.address,
    aToken,
    bToken,
    config,
  };
  if (opts.initConfig ?? true) {
    env.init = await send(svm, admin, [
      await getInitializeConfigInstructionAsync({
        admin,
        programData: await programDataAddress(),
        ...demoConfigArgs(env),
      }),
    ]);
  }
  return env;
}

export async function programDataAddress(): Promise<Address> {
  const [pd] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE,
    seeds: [getAddressEncoder().encode(ESCROW_PROGRAM_ADDRESS)],
  });
  return pd;
}

/**
 * Nonce-pool entry k (ESCROW §5.0.1, DATA-MODEL §5.20): createWithSeed(S, "yo-nonce-k", System),
 * authority S. Returns its address and current value.
 */
export async function createPoolNonce(
  env: Env,
  k: number,
): Promise<{ account: Address; value: string }> {
  const seed = nonceSeed(k);
  const account = await createAddressWithSeed({
    baseAddress: env.s.address,
    seed,
    programAddress: address(SYSTEM_PROGRAM_ID),
  });
  const space = BigInt(getNonceSize());
  await send(env.svm, env.s, [
    getCreateAccountWithSeedInstruction({
      payer: env.s,
      newAccount: account,
      baseAccount: env.s,
      base: env.s.address,
      seed,
      amount: env.svm.minimumBalanceForRentExemption(space),
      space,
      programAddress: address(SYSTEM_PROGRAM_ID),
    }),
    getInitializeNonceAccountInstruction({ nonceAccount: account, nonceAuthority: env.s.address }),
  ]);
  return { account, value: readNonce(env.svm, account) };
}

export function readNonce(svm: LiteSVM, account: Address): string {
  const acc = svm.getAccount(account);
  if (!acc.exists) throw new Error('nonce account missing');
  return decodeNonce(acc).data.blockhash;
}

/** A v4-shaped 16-byte bet id (RFC 4122 byte order) with a distinguishing last byte. */
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
