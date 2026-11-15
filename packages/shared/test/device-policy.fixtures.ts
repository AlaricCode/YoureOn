// Message builders for test/device-policy.test.ts. Everything is offline: keys come from Node's
// WebCrypto (Kit generateKeyPair), PDAs / ATAs from Kit's async getProgramDerivedAddress, and the
// messages are compiled and encoded with Kit, the same codecs the server's builder uses.
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransactionMessage,
  createTransactionMessage,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase64Decoder,
  getCompiledTransactionMessageEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getU32Encoder,
  getU64Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from '@solana/kit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import {
  ESCROW_ID,
  NONCE_SEED_PREFIX,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT_DEVNET,
} from '../src/chain/constants';
import { LOCK_SUBMIT_MARGIN_SECS } from '../src/constants';
import {
  anchorDiscriminator,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  createWithSeedAddress,
  RECENT_BLOCKHASHES_SYSVAR_ID,
  type DevicePolicyDerivations,
  type DevicePolicyPins,
} from '../src/device-policy';
import { computeTermsHash } from '../src/terms';
import { realWorldTerms, skillTerms } from './fixtures';

const a = (s: string): Address => address(s);
const u32 = getU32Encoder();
const u64 = getU64Encoder();
const i64 = getI64Encoder();
const addrEnc = getAddressEncoder();
const b64 = getBase64Decoder();
const cat = (...parts: ArrayLike<number>[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export const SKILL_BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
export const GEMINI_BET = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
export const OTHER_BET = '3d6f1b2a-8c4e-4a9b-b1d2-e3f4a5b6c7d8';

type Key = { kp: Awaited<ReturnType<typeof generateKeyPair>>; address: string };
const newKey = async (): Promise<Key> => {
  const kp = await generateKeyPair();
  return { kp, address: await getAddressFromPublicKey(kp.publicKey) };
};

const pda = async (seeds: (string | ArrayLike<number>)[], program = ESCROW_ID) =>
  (
    await getProgramDerivedAddress({
      programAddress: a(program),
      seeds: seeds.map((x) => (typeof x === 'string' ? x : Uint8Array.from(x))),
    })
  )[0] as string;
const betBytes = (id: string) => hexToBytes(id.replaceAll('-', ''));

export type World = Awaited<ReturnType<typeof createWorld>>;

/**
 * `partyA` lets apps/mobile put its own wallet key in A's seat (that key's `kp` is then a fresh
 * stand-in and must not be used to sign).
 */
export async function createWorld(opts: { partyA?: string } = {}) {
  const [genA, B, fee, other] = await Promise.all([newKey(), newKey(), newKey(), newKey()]);
  const A: Key = opts.partyA ? { kp: genA.kp, address: opts.partyA } : genA;
  const pins: DevicePolicyPins = {
    feePayer: fee.address,
    programId: ESCROW_ID,
    mint: USDC_MINT_DEVNET,
    tokenProgram: TOKEN_PROGRAM_ID,
    cluster: 'devnet',
  };
  const bets: Record<string, { bet: string; vault: string; config: string }> = {};
  const config = await pda(['config']);
  for (const id of [SKILL_BET, GEMINI_BET, OTHER_BET]) {
    bets[id] = {
      bet: await pda(['bet', betBytes(id)]),
      vault: await pda(['vault', betBytes(id)]),
      config,
    };
  }
  const eventAuthority = await pda(['__event_authority']);
  const atas: Record<string, string> = {};
  for (const k of [A, B, fee, other]) {
    atas[k.address] = await pda(
      [
        addrEnc.encode(a(k.address)),
        addrEnc.encode(a(TOKEN_PROGRAM_ID)),
        addrEnc.encode(a(USDC_MINT_DEVNET)),
      ],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
  }
  const derive: DevicePolicyDerivations = {
    betPdas: (id) => {
      const p = bets[id];
      if (!p) throw new Error(`no PDAs precomputed for ${id}`);
      return p;
    },
    eventAuthority: () => eventAuthority,
    associatedTokenAddress: (owner, mint) => {
      const ata = atas[owner];
      if (!ata || mint !== USDC_MINT_DEVNET) throw new Error('no ATA precomputed');
      return ata;
    },
  };
  // Nonce pool computed with Kit (async), to cross-check the module's own createWithSeed.
  const pool: string[] = [];
  for (let k = 0; k < 17; k++)
    pool.push(createWithSeedAddress(fee.address, `${NONCE_SEED_PREFIX}${k}`, SYSTEM_PROGRAM_ID));

  const parties = (t: Record<string, unknown>) => ({
    ...t,
    escrow: { cluster: 'devnet', program_id: ESCROW_ID, mint: USDC_MINT_DEVNET },
    party_a: { pubkey: A.address, display_name: 'Logan' },
    party_b: { pubkey: B.address, display_name: 'Jake' },
  });
  const envelopeOf = (t: unknown) => {
    const { terms, terms_hash } = computeTermsHash(t);
    return {
      terms,
      terms_hash,
      presentation: {
        title: 'Bottle flip',
        readback: 'Jake lands a bottle flip',
        stakes_display: '$5 each',
        odds_display: null,
        party_a_avatar_url: null,
        party_b_avatar_url: null,
      },
    };
  };
  const skill = envelopeOf(parties(skillTerms()));
  const gemini = envelopeOf(parties(realWorldTerms()));

  /** Device clock: 60 s after the skill Terms were created. */
  const NOW = Math.floor(Date.parse(skill.terms.created_at) / 1000) + 60;
  const GEMINI_NOW = Math.floor(Date.parse(gemini.terms.market!.quotedAt) / 1000) + 10;

  return {
    A,
    B,
    fee,
    other,
    pins,
    derive,
    bets,
    eventAuthority,
    atas,
    pool,
    skill,
    gemini,
    envelopeOf,
    parties,
    NOW,
    GEMINI_NOW,
  };
}

// ---------------------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------------------

const ro = (s: string) => ({ address: a(s), role: AccountRole.READONLY });
const w = (s: string) => ({ address: a(s), role: AccountRole.WRITABLE });
const ros = (s: string) => ({ address: a(s), role: AccountRole.READONLY_SIGNER });
const ws = (s: string) => ({ address: a(s), role: AccountRole.WRITABLE_SIGNER });

export const advanceNonce = (nonce: string, authority: string): Instruction => ({
  programAddress: a(SYSTEM_PROGRAM_ID),
  accounts: [w(nonce), ro(RECENT_BLOCKHASHES_SYSVAR_ID), ros(authority)],
  data: Uint8Array.from(u32.encode(4)),
});
export const cuLimit = (n: number): Instruction => ({
  programAddress: a(COMPUTE_BUDGET_PROGRAM_ID),
  data: cat([2], u32.encode(n)),
});
export const cuPrice = (n: number): Instruction => ({
  programAddress: a(COMPUTE_BUDGET_PROGRAM_ID),
  data: cat([3], u64.encode(n)),
});
export const heapFrame = (): Instruction => ({
  programAddress: a(COMPUTE_BUDGET_PROGRAM_ID),
  data: cat([1], u32.encode(64 * 1024)),
});
/** SPL Token instructions on the party's ATA (tags: Transfer 3, Approve 4, SetAuthority 6, CloseAccount 9). */
export const splIx = (tag: number, src: string, dst: string, owner: string): Instruction => ({
  programAddress: a(TOKEN_PROGRAM_ID),
  accounts: [w(src), w(dst), ros(owner)],
  data: cat([tag], u64.encode(1_000_000)),
});
export const otherProgramIx = (program: string, account?: string): Instruction => ({
  programAddress: a(program),
  accounts: account ? [ro(account)] : [],
  data: Uint8Array.from([1, 2, 3]),
});
export const ataCreate = (funder: string, ata: string, wallet: string): Instruction => ({
  programAddress: a(ASSOCIATED_TOKEN_PROGRAM_ID),
  accounts: [
    ws(funder),
    w(ata),
    ro(wallet),
    ro(USDC_MINT_DEVNET),
    ro(SYSTEM_PROGRAM_ID),
    ro(TOKEN_PROGRAM_ID),
  ],
  data: Uint8Array.from([1]),
});

export type CreateAccts = {
  payer: string;
  party_a: string;
  config: string;
  mint: string;
  bet: string;
  vault: string;
  party_a_token: string;
  token_program: string;
  system_program: string;
  event_authority: string;
  program: string;
};
export type CreateArgs = {
  bet_id: string;
  party_b: string;
  stake_a: bigint;
  stake_b: bigint;
  terms_hash: string;
  accept_deadline: number;
};
export const createBetIx = (x: CreateAccts, g: CreateArgs, extraSigner?: string): Instruction => ({
  programAddress: a(ESCROW_ID),
  accounts: [
    ws(x.payer),
    ros(x.party_a),
    ro(x.config),
    ro(x.mint),
    w(x.bet),
    w(x.vault),
    extraSigner === 'party_a_token' ? ws(x.party_a_token) : w(x.party_a_token),
    ro(x.token_program),
    ro(x.system_program),
    ro(x.event_authority),
    ro(x.program),
  ],
  data: cat(
    anchorDiscriminator('create_bet'),
    betBytes(g.bet_id),
    addrEnc.encode(a(g.party_b)),
    u64.encode(g.stake_a),
    u64.encode(g.stake_b),
    hexToBytes(g.terms_hash),
    i64.encode(g.accept_deadline),
  ),
});

export type AcceptAccts = {
  payer: string;
  party_b: string;
  config: string;
  bet: string;
  vault: string;
  mint: string;
  party_b_token: string;
  token_program: string;
  event_authority: string;
  program: string;
};
export type AcceptArgs = {
  expected_terms_hash: string;
  expected_stake_a: bigint;
  expected_stake_b: bigint;
  expected_party_a: string;
};
export const acceptBetIx = (x: AcceptAccts, g: AcceptArgs, signerToken = false): Instruction => ({
  programAddress: a(ESCROW_ID),
  accounts: [
    ws(x.payer),
    ros(x.party_b),
    ro(x.config),
    w(x.bet),
    w(x.vault),
    ro(x.mint),
    signerToken ? ws(x.party_b_token) : w(x.party_b_token),
    ro(x.token_program),
    ro(x.event_authority),
    ro(x.program),
  ],
  data: cat(
    anchorDiscriminator('accept_bet'),
    hexToBytes(g.expected_terms_hash),
    u64.encode(g.expected_stake_a),
    u64.encode(g.expected_stake_b),
    addrEnc.encode(a(g.expected_party_a)),
  ),
});

export type ConcedeAccts = {
  payer: string;
  party: string;
  bet: string;
  vault: string;
  mint: string;
  party_a_token: string;
  party_b_token: string;
  token_program: string;
  event_authority: string;
  program: string;
};
export const concedeIx = (x: ConcedeAccts): Instruction => ({
  programAddress: a(ESCROW_ID),
  accounts: [
    ws(x.payer),
    ros(x.party),
    w(x.bet),
    w(x.vault),
    ro(x.mint),
    x.party_a_token === ESCROW_ID ? ro(x.party_a_token) : w(x.party_a_token),
    x.party_b_token === ESCROW_ID ? ro(x.party_b_token) : w(x.party_b_token),
    ro(x.token_program),
    ro(x.event_authority),
    ro(x.program),
  ],
  data: anchorDiscriminator('concede'),
});
export const appealIx = (x: {
  payer: string;
  appellant: string;
  bet: string;
  event_authority: string;
  program: string;
}): Instruction => ({
  programAddress: a(ESCROW_ID),
  accounts: [ws(x.payer), ros(x.appellant), w(x.bet), ro(x.event_authority), ro(x.program)],
  data: anchorDiscriminator('appeal'),
});
export type CloseAccts = {
  payer: string;
  bet: string;
  vault: string;
  mint: string;
  party_a_token: string;
  rent_payer: string;
  token_program: string;
  event_authority: string;
  program: string;
};
export const closeBetIx = (x: CloseAccts): Instruction => ({
  programAddress: a(ESCROW_ID),
  accounts: [
    ws(x.payer),
    w(x.bet),
    w(x.vault),
    ro(x.mint),
    x.party_a_token === ESCROW_ID ? ro(x.party_a_token) : w(x.party_a_token),
    w(x.rent_payer),
    ro(x.token_program),
    ro(x.event_authority),
    ro(x.program),
  ],
  data: anchorDiscriminator('close_bet'),
});
/** A third escrow instruction the policy does not know (cancel_open_bet). */
export const cancelOpenBetIx = (payer: string, bet: string): Instruction => ({
  programAddress: a(ESCROW_ID),
  accounts: [ws(payer), w(bet)],
  data: anchorDiscriminator('cancel_open_bet'),
});

// ---------------------------------------------------------------------------------------
// Messages and requests
// ---------------------------------------------------------------------------------------

/** Any 32 bytes stand in for the nonce value / recent blockhash. */
export const LIFETIME = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';

export function compile(
  ixs: Instruction[],
  feePayer: string,
  opts: { version?: 'legacy' | 0; lookups?: boolean } = {},
): Uint8Array {
  const msg = pipe(
    createTransactionMessage({ version: opts.version ?? 'legacy' }),
    (m) => setTransactionMessageFeePayer(a(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(LIFETIME), lastValidBlockHeight: 1_000n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const compiled = compileTransactionMessage(msg);
  type Encodable = Parameters<ReturnType<typeof getCompiledTransactionMessageEncoder>['encode']>[0];
  const withLookups: Encodable = opts.lookups
    ? ({
        ...compiled,
        version: 0 as const,
        addressTableLookups: [
          { lookupTableAddress: a(SYSTEM_PROGRAM_ID), writableIndexes: [0], readonlyIndexes: [] },
        ],
      } as unknown as Encodable)
    : compiled;
  return Uint8Array.from(getCompiledTransactionMessageEncoder().encode(withLookups));
}

export const b64Of = (m: Uint8Array) => b64.decode(m);
export const shaOf = (m: Uint8Array) => bytesToHex(sha256(m));

export const iso = (unix: number) => new Date(unix * 1000).toISOString();

/** The clean lock parts for an envelope; `o` overrides any account or arg. */
export function lockParts(
  W: World,
  env = W.skill,
  o: {
    create?: Partial<CreateAccts>;
    createArgs?: Partial<CreateArgs>;
    accept?: Partial<AcceptAccts>;
    acceptArgs?: Partial<AcceptArgs>;
    nonce?: string;
    nonceAuthority?: string;
    deadline?: number;
  } = {},
) {
  const t = env.terms;
  const p = W.bets[t.bet_id]!;
  const deadline =
    o.deadline ?? (t.market ? Math.floor(Date.parse(t.market.quotedAt) / 1000) + 60 : W.NOW + 300);
  const create: CreateAccts = {
    payer: W.fee.address,
    party_a: W.A.address,
    config: p.config,
    mint: USDC_MINT_DEVNET,
    bet: p.bet,
    vault: p.vault,
    party_a_token: W.atas[W.A.address]!,
    token_program: TOKEN_PROGRAM_ID,
    system_program: SYSTEM_PROGRAM_ID,
    event_authority: W.eventAuthority,
    program: ESCROW_ID,
    ...o.create,
  };
  const createArgs: CreateArgs = {
    bet_id: t.bet_id,
    party_b: W.B.address,
    stake_a: BigInt(t.stakes.a),
    stake_b: BigInt(t.stakes.b),
    terms_hash: env.terms_hash,
    accept_deadline: deadline,
    ...o.createArgs,
  };
  const accept: AcceptAccts = {
    payer: W.fee.address,
    party_b: W.B.address,
    config: p.config,
    bet: p.bet,
    vault: p.vault,
    mint: USDC_MINT_DEVNET,
    party_b_token: W.atas[W.B.address]!,
    token_program: TOKEN_PROGRAM_ID,
    event_authority: W.eventAuthority,
    program: ESCROW_ID,
    ...o.accept,
  };
  const acceptArgs: AcceptArgs = {
    expected_terms_hash: env.terms_hash,
    expected_stake_a: BigInt(t.stakes.a),
    expected_stake_b: BigInt(t.stakes.b),
    expected_party_a: W.A.address,
    ...o.acceptArgs,
  };
  return {
    deadline: createArgs.accept_deadline,
    createAccts: create,
    createArgs,
    acceptAccts: accept,
    acceptArgs,
    nonce: advanceNonce(o.nonce ?? W.pool[2]!, o.nonceAuthority ?? W.fee.address),
    limit: cuLimit(120_000),
    price: cuPrice(5_000),
    create: createBetIx(create, createArgs),
    accept: acceptBetIx(accept, acceptArgs),
  };
}

export const standardLock = (p: ReturnType<typeof lockParts>) => [
  p.nonce,
  p.limit,
  p.price,
  p.create,
  p.accept,
];

export function authorizeRequest(
  env: World['skill'],
  message: Uint8Array,
  deadline: number,
  o: Record<string, unknown> = {},
) {
  return {
    bet_id: env.terms.bet_id,
    lock_request_id: '5a0d8c1e-2b3f-4c5d-8e9f-0a1b2c3d4e5f',
    kind: 'atomic_lock',
    envelope: env,
    message_b64: b64Of(message),
    message_sha256: shaOf(message),
    nonce_index: 2,
    accept_deadline: deadline,
    expires_at: iso(deadline - LOCK_SUBMIT_MARGIN_SECS),
    ...o,
  };
}

export const RULING_HASH = 'ab'.repeat(32);

export const card = (W: World) => ({
  title: 'GG',
  prompt_message: 'Pay Logan',
  hold_label: 'Hold to pay',
  stakes_line: '$5',
  pot_line: '$10',
  odds_display: null,
  terms_code: W.skill.terms_hash.slice(0, 8),
  countdown_ends_at: iso(W.NOW + 10),
});

export function signRequest(
  W: World,
  kind: 'concede' | 'appeal',
  message: Uint8Array,
  o: Record<string, unknown> = {},
) {
  return {
    bet_id: W.skill.terms.bet_id,
    kind,
    for_parties: ['B'],
    message_b64: b64Of(message),
    message_sha256: shaOf(message),
    fee_payer: W.fee.address,
    signers: [W.fee.address, W.B.address],
    lifetime: {
      type: 'blockhash',
      blockhash: LIFETIME,
      last_valid_block_height: 1_000,
      valid_until: iso(W.NOW + 30),
    },
    envelope: W.skill,
    card: card(W),
    ruling_ref: { ruling_hash: RULING_HASH, outcome: 'A_WINS' },
    issued_at: iso(W.NOW),
    ...o,
  };
}

/** The clean concede (B lost an A_WINS ruling): [CB, ATA create for A, concede, close_bet]. */
export function concedeParts(
  W: World,
  o: { concede?: Partial<ConcedeAccts>; close?: Partial<CloseAccts>; ataWallet?: string } = {},
) {
  const p = W.bets[SKILL_BET]!;
  const ataWallet = o.ataWallet ?? W.A.address;
  return {
    limit: cuLimit(80_000),
    ata: ataCreate(W.fee.address, W.atas[ataWallet]!, ataWallet),
    concede: concedeIx({
      payer: W.fee.address,
      party: W.B.address,
      bet: p.bet,
      vault: p.vault,
      mint: USDC_MINT_DEVNET,
      party_a_token: W.atas[W.A.address]!,
      party_b_token: ESCROW_ID,
      token_program: TOKEN_PROGRAM_ID,
      event_authority: W.eventAuthority,
      program: ESCROW_ID,
      ...o.concede,
    }),
    close: closeBetIx({
      payer: W.fee.address,
      bet: p.bet,
      vault: p.vault,
      mint: USDC_MINT_DEVNET,
      party_a_token: W.atas[W.A.address]!,
      rent_payer: W.fee.address,
      token_program: TOKEN_PROGRAM_ID,
      event_authority: W.eventAuthority,
      program: ESCROW_ID,
      ...o.close,
    }),
  };
}

export const appealParts = (W: World, appellant = W.B.address) => ({
  limit: cuLimit(20_000),
  appeal: appealIx({
    payer: W.fee.address,
    appellant,
    bet: W.bets[SKILL_BET]!.bet,
    event_authority: W.eventAuthority,
    program: ESCROW_ID,
  }),
});
