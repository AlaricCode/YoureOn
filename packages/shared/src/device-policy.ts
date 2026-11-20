// Device signing policy (ESCROW §5.0.2, API-CONTRACT §6.3; tests A13, DP1-DP16 in
// test/device-policy.test.ts). The phone runs it on the exact message bytes it is about to sign,
// at terms-card (or GG / appeal) mount and again inside wallet.authorize(); the hold button stays
// disabled until it passes. It signs nothing that is not exactly one of the server-built kinds.
//
// The message shape checks (header sanity, the signer among the signing keys) are G3/G5 below;
// everything follows OUR spec.
//
// Hermes: pure and synchronous. Kit is used for codecs only (message, base58, base64, borsh-style
// args). PDAs / ATAs need an Ed25519 on-curve check, so they are INJECTED (`derive`): apps/mobile
// passes its noble helper (src/wallet/pda.ts), because Kit's getProgramDerivedAddress throws on
// Hermes. createWithSeed (the nonce pool) is plain sha256 and runs here.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  fixDecoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getBytesDecoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getI64Decoder,
  getStructDecoder,
  getU32Decoder,
  getU64Decoder,
  type Address,
} from '@solana/kit';
import { SignRequest } from './api';
import { AuthorizeRequest, type LockMode, type TxKind } from './authorization';
import {
  ESCROW_ID,
  FEE_PAYER_PUBKEY,
  NONCE_SEED_PREFIX,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  USDC_MINT_DEVNET,
} from './chain/constants';
import { LOCK_SIGNATURE_MAX_SECS, MAX_STAKE, NONCE_SEED_MAX, QUOTE_TTL_SECS } from './constants';
import { type Party } from './primitives';
import { TermsEnvelope, type Terms } from './terms';

// ---------------------------------------------------------------------------------------
// Program and sysvar addresses the policy recognises (all others are rejected)
// ---------------------------------------------------------------------------------------

export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const RECENT_BLOCKHASHES_SYSVAR_ID = 'SysvarRecentB1ockHashes11111111111111111111';

/** G7: the CU limit a device will ever sign for (API-CONTRACT §6.3). */
export const MAX_COMPUTE_UNIT_LIMIT = 400_000;

// ---------------------------------------------------------------------------------------
// Rules, pins, inputs, verdict
// ---------------------------------------------------------------------------------------

/** Row IDs of API-CONTRACT §6.3, plus KIND (ESCROW §5.0.2 "Kind" row). Reported to policy-rejections. */
export const DEVICE_POLICY_RULES = [
  'KIND',
  'G1',
  'G2',
  'G3',
  'G4',
  'G5',
  'G6',
  'G7',
  'L1',
  'L2',
  'L3',
  'L4',
  'L5',
  'T1',
  'T2',
  'T3',
] as const;
export type DevicePolicyRule = (typeof DEVICE_POLICY_RULES)[number];

/** The kinds a device ever signs (lock under either LOCK_MODE, GG, appeal). */
export type DeviceSignKind = Extract<
  TxKind,
  'atomic_lock' | 'create_bet' | 'accept_bet' | 'concede' | 'appeal'
>;

/** Where the phone's own UI is. The expected kind comes from here, never from the server's label. */
export type DevicePolicyScreen = 'terms_card' | 'gg' | 'appeal';

/** Values compiled into the app (G1). Production callers omit `pins` and get DEVICE_POLICY_PINS. */
export type DevicePolicyPins = {
  /** null = not pinned yet (TASKS D1): every message is rejected. */
  feePayer: string | null;
  programId: string;
  mint: string;
  tokenProgram: string;
  cluster: 'devnet' | 'localnet';
};

export const DEVICE_POLICY_PINS: DevicePolicyPins = Object.freeze({
  feePayer: FEE_PAYER_PUBKEY,
  programId: ESCROW_ID,
  mint: USDC_MINT_DEVNET,
  tokenProgram: TOKEN_PROGRAM_ID,
  cluster: 'devnet',
});

/**
 * Address derivations that need an Ed25519 on-curve check, injected so this module stays
 * Hermes-safe. Every result is base58. apps/mobile builds this from noble (src/wallet).
 */
export type DevicePolicyDerivations = {
  /** PDA("bet", bet_id), PDA("vault", bet_id), PDA("config") under the pinned program. */
  betPdas(betId: string): { bet: string; vault: string; config: string };
  /** PDA("__event_authority") under the pinned program. */
  eventAuthority(): string;
  /** The associated token account of (owner, mint) under the pinned token program. */
  associatedTokenAddress(owner: string, mint: string): string;
};

type CommonInput = {
  /** The key that will sign: the wallet's stored public key, never a value from the server. */
  devicePubkey: string;
  /** Device clock, unix seconds. */
  nowSecs: number;
  derive: DevicePolicyDerivations;
  /** Tests only. Production uses DEVICE_POLICY_PINS. */
  pins?: DevicePolicyPins;
};

export type LockPolicyInput = CommonInput & {
  screen: 'terms_card';
  lockMode: LockMode;
  /** SCHEMAS §9 AuthorizeRequest as received (unparsed). */
  request: unknown;
};

export type SignPolicyInput = CommonInput & {
  screen: 'gg' | 'appeal';
  /** API-CONTRACT SignRequest as received (unparsed). */
  request: unknown;
  /** G2: the card as the phone itself renders it from the verified ruling and Terms. */
  renderedCard: SignRequest['card'];
  /** T2: ruling_hash of the last ruling.issued this phone verified. */
  verifiedRulingHash: string;
  /**
   * T2: outcome of that same verified ruling.issued. The loser check uses this value; the server's
   * ruling_ref.outcome must equal it (a hash alone does not bind the outcome the server pairs it with).
   */
  verifiedRulingOutcome: string;
};

export type DevicePolicyInput = LockPolicyInput | SignPolicyInput;

export type DevicePolicyPass = {
  ok: true;
  kind: DeviceSignKind;
  party: Party;
  bet_id: string;
  /** Recomputed on the device from the displayed Terms (PartyAuthorization.terms_hash). */
  terms_hash: string;
  message_sha256: string;
};
export type DevicePolicyReject = {
  ok: false;
  rule: DevicePolicyRule;
  reason: string;
  /** For the `{bet_id, kind, rule}` report (API-CONTRACT §6.3); null when the request didn't parse. */
  bet_id: string | null;
  kind: DeviceSignKind | null;
};
export type DevicePolicyVerdict = DevicePolicyPass | DevicePolicyReject;

export class DevicePolicyError extends Error {
  readonly rule: DevicePolicyRule;
  readonly verdict: DevicePolicyReject;
  constructor(verdict: DevicePolicyReject) {
    super(`device policy ${verdict.rule}: ${verdict.reason}`);
    this.name = 'DevicePolicyError';
    this.rule = verdict.rule;
    this.verdict = verdict;
  }
}

// ---------------------------------------------------------------------------------------
// Escrow instruction layouts (Anchor), each checked against idl/escrow.json by a test: payer, the
// party signer, then the payout set / close accounts, then #[event_cpi] (ESCROW §5.2).
// ---------------------------------------------------------------------------------------

export type EscrowIxName = 'create_bet' | 'accept_bet' | 'concede' | 'appeal' | 'close_bet';

export const ESCROW_IX_ACCOUNTS: Readonly<Record<EscrowIxName, readonly string[]>> = {
  create_bet: [
    'payer',
    'party_a',
    'config',
    'mint',
    'bet',
    'vault',
    'party_a_token',
    'token_program',
    'system_program',
    'event_authority',
    'program',
  ],
  accept_bet: [
    'payer',
    'party_b',
    'config',
    'bet',
    'vault',
    'mint',
    'party_b_token',
    'token_program',
    'event_authority',
    'program',
  ],
  concede: [
    'payer',
    'party',
    'bet',
    'vault',
    'mint',
    'party_a_token',
    'party_b_token',
    'token_program',
    'event_authority',
    'program',
  ],
  appeal: ['payer', 'appellant', 'bet', 'event_authority', 'program'],
  close_bet: [
    'payer',
    'bet',
    'vault',
    'mint',
    'party_a_token',
    'rent_payer',
    'token_program',
    'event_authority',
    'program',
  ],
};

/** The device's own party-signer slot per escrow instruction (G5). */
const PARTY_SLOT: Partial<Record<EscrowIxName, string>> = {
  create_bet: 'party_a',
  accept_bet: 'party_b',
  concede: 'party',
  appeal: 'appellant',
};

/** Anchor: sha256("global:<name>")[0..8]. */
export const anchorDiscriminator = (name: string): Uint8Array =>
  sha256(utf8ToBytes(`global:${name}`)).slice(0, 8);

const DISCRIMINATORS: ReadonlyArray<readonly [EscrowIxName, string]> = (
  Object.keys(ESCROW_IX_ACCOUNTS) as EscrowIxName[]
).map((n) => [n, bytesToHex(anchorDiscriminator(n))] as const);

const DATA_LEN: Record<EscrowIxName, number> = {
  create_bet: 8 + 16 + 32 + 8 + 8 + 32 + 8,
  accept_bet: 8 + 32 + 8 + 8 + 32,
  concede: 8,
  appeal: 8,
  close_bet: 8,
};

// Kit codecs (no crypto): message, base58/base64 and the borsh args.
const messageDecoder = getCompiledTransactionMessageDecoder();
const messageEncoder = getCompiledTransactionMessageEncoder();
const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();
const base64 = getBase64Encoder();
const u32 = getU32Decoder();
const u64 = getU64Decoder();
const bytes = (n: number) => fixDecoderSize(getBytesDecoder(), n);
const createBetArgs = getStructDecoder([
  ['discriminator', bytes(8)],
  ['bet_id', bytes(16)],
  ['party_b', addressDecoder],
  ['stake_a', u64],
  ['stake_b', u64],
  ['terms_hash', bytes(32)],
  ['accept_deadline', getI64Decoder()],
]);
const acceptBetArgs = getStructDecoder([
  ['discriminator', bytes(8)],
  ['expected_terms_hash', bytes(32)],
  ['expected_stake_a', u64],
  ['expected_stake_b', u64],
  ['expected_party_a', addressDecoder],
]);

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

class Reject extends Error {
  constructor(
    readonly rule: DevicePolicyRule,
    reason: string,
  ) {
    super(reason);
  }
}
const fail = (rule: DevicePolicyRule, reason: string): never => {
  throw new Reject(rule, reason);
};
const need = (cond: boolean, rule: DevicePolicyRule, reason: string): void => {
  if (!cond) fail(rule, reason);
};

const eqBytes = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
};

/** System `create_with_seed`: sha256(base || seed || owner). Owner is System (never a PDA marker). */
export function createWithSeedAddress(base: string, seed: string, owner: string): string {
  const b = addressEncoder.encode(base as Address);
  const s = utf8ToBytes(seed);
  const o = addressEncoder.encode(owner as Address);
  const buf = new Uint8Array(b.length + s.length + o.length);
  buf.set(b, 0);
  buf.set(s, b.length);
  buf.set(o, b.length + s.length);
  return addressDecoder.decode(sha256(buf));
}

/** The full nonce pool a phone accepts: createWithSeed(fee payer, "yo-nonce-<k>", System), k < 16. */
export const noncePoolAddresses = (feePayer: string): string[] =>
  Array.from({ length: NONCE_SEED_MAX }, (_, k) =>
    createWithSeedAddress(feePayer, `${NONCE_SEED_PREFIX}${k}`, SYSTEM_PROGRAM_ID),
  );

type Ix = {
  index: number;
  program: string;
  accounts: string[];
  data: Uint8Array;
};
type Decoded = {
  numSigners: number;
  signers: string[];
  keys: string[];
  writable: (i: number) => boolean;
  lifetimeToken: string;
  ixs: Ix[];
};

/** G3: Kit-decode, strict. Legacy or v0 only, no lookups, canonical bytes, valid indices. */
function decodeMessage(message: Uint8Array): Decoded {
  let m: ReturnType<typeof messageDecoder.decode>;
  let read: number;
  try {
    [m, read] = messageDecoder.read(message, 0);
  } catch {
    return fail('G3', 'message does not decode');
  }
  if (m.version !== 'legacy' && m.version !== 0) return fail('G3', 'message must be legacy or v0');
  need(
    m.version === 'legacy' || (m.addressTableLookups ?? []).length === 0,
    'G3',
    'address lookup tables are not allowed',
  );
  // Canonical: no trailing bytes, and Kit re-encodes to the same bytes (catches odd length prefixes).
  need(read === message.length, 'G3', 'trailing bytes after the message');
  let again: ArrayLike<number>;
  try {
    again = messageEncoder.encode(m);
  } catch {
    return fail('G3', 'message does not re-encode');
  }
  need(eqBytes(again, message), 'G3', 'message is not canonically encoded');

  const { numSignerAccounts: ns, numReadonlySignerAccounts: nrs } = m.header;
  const nru = m.header.numReadonlyNonSignerAccounts;
  const keys = m.staticAccounts.map(String);
  // Header sanity: signers fit, fee payer writable, counts consistent.
  need(ns >= 1 && ns <= keys.length, 'G3', 'bad signer count');
  need(nrs < ns, 'G3', 'fee payer must be a writable signer');
  need(nru <= keys.length - ns, 'G3', 'bad readonly count');
  need(new Set(keys).size === keys.length, 'G3', 'duplicate account keys');

  const ixs: Ix[] = m.instructions.map((ix, index) => {
    const idx = ix.accountIndices ?? [];
    need(ix.programAddressIndex < keys.length, 'G3', 'program index out of range');
    for (const i of idx) need(i < keys.length, 'G3', 'account index out of range');
    return {
      index,
      program: keys[ix.programAddressIndex] as string,
      accounts: idx.map((i) => keys[i] as string),
      data: Uint8Array.from(ix.data ?? []),
    };
  });
  const writable = (i: number) => (i < ns ? i < ns - nrs : i < keys.length - nru);
  return {
    numSigners: ns,
    signers: keys.slice(0, ns),
    keys,
    writable,
    lifetimeToken: String(m.lifetimeToken),
    ixs,
  };
}

const isAdvanceNonce = (ix: Ix) =>
  ix.program === SYSTEM_PROGRAM_ID && ix.data.length >= 4 && u32.decode(ix.data) === 4;

const escrowName = (ix: Ix, programId: string): EscrowIxName | null => {
  if (ix.program !== programId || ix.data.length < 8) return null;
  const hex = bytesToHex(ix.data.subarray(0, 8));
  return DISCRIMINATORS.find(([, d]) => d === hex)?.[0] ?? null;
};

/** Named accounts of an escrow ix; exact account count and exact data length. */
function escrowAccounts(ix: Ix, name: EscrowIxName, rule: DevicePolicyRule) {
  const layout = ESCROW_IX_ACCOUNTS[name];
  need(ix.accounts.length === layout.length, rule, `${name}: expected ${layout.length} accounts`);
  need(ix.data.length === DATA_LEN[name], rule, `${name}: bad data length`);
  const named: Record<string, string> = {};
  layout.forEach((n, i) => (named[n] = ix.accounts[i] as string));
  return named;
}

/** G7: zero accounts, exact data, at most one of each, limit within the cap. */
function checkComputeBudget(cb: Ix[]): void {
  let limits = 0;
  let prices = 0;
  for (const ix of cb) {
    need(ix.accounts.length === 0, 'G7', 'compute budget ix lists accounts');
    const tag = ix.data[0];
    if (tag === 2 && ix.data.length === 5) {
      limits++;
      need(u32.decode(ix.data, 1) <= MAX_COMPUTE_UNIT_LIMIT, 'G7', 'CU limit above 400k');
    } else if (tag === 3 && ix.data.length === 9) {
      prices++;
    } else {
      fail('G7', 'only SetComputeUnitLimit / SetComputeUnitPrice are allowed');
    }
  }
  need(
    limits <= 1 && prices <= 1,
    'G7',
    'more than one SetComputeUnitLimit or SetComputeUnitPrice',
  );
}

/** G5: `key` may appear only in its own party slot of `ownIx`, nowhere else (not even as a program). */
function checkKeyPlacement(
  ixs: Ix[],
  programId: string,
  key: string,
  ownIx: Ix,
  ownSlot: string,
  label: string,
) {
  for (const ix of ixs) {
    need(ix.program !== key, 'G5', `${label} key is invoked as a program`);
    ix.accounts.forEach((a, pos) => {
      if (a !== key) return;
      const name = escrowName(ix, programId);
      const slot = name ? ESCROW_IX_ACCOUNTS[name][pos] : undefined;
      need(
        ix === ownIx && slot === ownSlot,
        'G5',
        `${label} key listed outside its own slot (ix ${ix.index}${slot ? `, ${slot}` : ''})`,
      );
    });
  }
}

/** G1 + G6 + L5 for one escrow instruction against the pins and the device-derived PDAs. */
function checkEscrowCommon(
  named: Record<string, string>,
  name: EscrowIxName,
  pins: DevicePolicyPins & { feePayer: string },
  pdas: { bet: string; vault: string; config: string },
  eventAuthority: string,
  payerRule: DevicePolicyRule,
): void {
  need(named.payer === pins.feePayer, payerRule, `${name}: payer is not the pinned fee payer`);
  if ('mint' in named) need(named.mint === pins.mint, 'G1', `${name}: mint is not the pinned USDC`);
  if ('token_program' in named)
    need(named.token_program === pins.tokenProgram, 'G1', `${name}: token program not pinned`);
  if ('system_program' in named)
    need(named.system_program === SYSTEM_PROGRAM_ID, 'G1', `${name}: system program`);
  need(named.program === pins.programId, 'G1', `${name}: program account is not the escrow`);
  if ('bet' in named) need(named.bet === pdas.bet, 'G6', `${name}: Bet != PDA(bet_id)`);
  if ('vault' in named) need(named.vault === pdas.vault, 'G6', `${name}: vault != PDA(bet_id)`);
  if ('config' in named) need(named.config === pdas.config, 'G6', `${name}: Config != PDA`);
  need(named.event_authority === eventAuthority, 'G6', `${name}: event authority != PDA`);
}

const toUnix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const hexOf = (b: ArrayLike<number>) => bytesToHex(Uint8Array.from(b));

/** L3 (create_bet args vs the displayed Terms) and the deadline bounds. */
function checkCreateArgs(
  ix: Ix,
  terms: Terms,
  termsHash: string,
  nowSecs: number,
  reqDeadline: number,
) {
  const a = createBetArgs.decode(ix.data);
  need(
    hexOf(a.bet_id) === terms.bet_id.replaceAll('-', ''),
    'L3',
    'create_bet.bet_id != displayed',
  );
  need(a.party_b === terms.party_b.pubkey, 'L3', 'create_bet.party_b != displayed B');
  need(a.stake_a === BigInt(terms.stakes.a), 'L3', 'create_bet.stake_a != displayed');
  need(a.stake_b === BigInt(terms.stakes.b), 'L3', 'create_bet.stake_b != displayed');
  need(a.stake_a > 0n && a.stake_a <= MAX_STAKE, 'L3', 'stake_a outside 1..MAX_STAKE');
  need(a.stake_b > 0n && a.stake_b <= MAX_STAKE, 'L3', 'stake_b outside 1..MAX_STAKE');
  need(hexOf(a.terms_hash) === termsHash, 'L3', 'create_bet.terms_hash != sha256(JCS(Terms))');
  const d = a.accept_deadline;
  need(d > BigInt(nowSecs), 'L3', 'accept_deadline <= device now');
  need(d <= BigInt(nowSecs + LOCK_SIGNATURE_MAX_SECS), 'L3', 'accept_deadline > now + 600');
  need(d === BigInt(reqDeadline), 'L3', 'accept_deadline != AuthorizeRequest.accept_deadline');
  if (terms.market !== null)
    need(
      d === BigInt(toUnix(terms.market.quotedAt) + QUOTE_TTL_SECS),
      'L3',
      'gemini accept_deadline != unix(quotedAt) + 60',
    );
  return a;
}

/** L4 (accept_bet args vs the displayed Terms and challenger). */
function checkAcceptArgs(ix: Ix, terms: Terms, termsHash: string) {
  const a = acceptBetArgs.decode(ix.data);
  need(hexOf(a.expected_terms_hash) === termsHash, 'L4', 'expected_terms_hash != displayed');
  need(a.expected_stake_a === BigInt(terms.stakes.a), 'L4', 'expected_stake_a != displayed');
  need(a.expected_stake_b === BigInt(terms.stakes.b), 'L4', 'expected_stake_b != displayed');
  need(a.expected_party_a === terms.party_a.pubkey, 'L4', 'expected_party_a != displayed A');
  return a;
}

// ---------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------

/** Runs every check; never throws. The phone signs only on `ok: true`. */
export function checkDevicePolicy(
  message: Uint8Array,
  input: DevicePolicyInput,
): DevicePolicyVerdict {
  const ctx: { bet_id: string | null; kind: DeviceSignKind | null } = { bet_id: null, kind: null };
  try {
    return run(message, input, ctx);
  } catch (e) {
    if (e instanceof Reject) return { ok: false, rule: e.rule, reason: e.message, ...ctx };
    // A codec or derivation throwing is a rejection too, never a pass.
    return {
      ok: false,
      rule: 'G3',
      reason: e instanceof Error ? e.message : 'device policy error',
      ...ctx,
    };
  }
}

/** Throws DevicePolicyError unless every check passes. */
export function assertDevicePolicy(
  message: Uint8Array,
  input: DevicePolicyInput,
): DevicePolicyPass {
  const v = checkDevicePolicy(message, input);
  if (!v.ok) throw new DevicePolicyError(v);
  return v;
}

/** The kind the phone expects from its own UI (ESCROW §5.0.2 "Kind"). */
export function expectedKind(
  screen: DevicePolicyScreen,
  lockMode: LockMode,
  me: Party,
): DeviceSignKind {
  if (screen === 'gg') return 'concede';
  if (screen === 'appeal') return 'appeal';
  if (lockMode === 'atomic') return 'atomic_lock';
  return me === 'A' ? 'create_bet' : 'accept_bet';
}

function run(
  message: Uint8Array,
  input: DevicePolicyInput,
  ctx: { bet_id: string | null; kind: DeviceSignKind | null },
): DevicePolicyPass {
  // ---- G1 pins ------------------------------------------------------------------------
  const rawPins = input.pins ?? DEVICE_POLICY_PINS;
  if (rawPins.feePayer === null) return fail('G1', 'fee payer is not pinned in this build');
  const pins = { ...rawPins, feePayer: rawPins.feePayer };
  need(Number.isSafeInteger(input.nowSecs) && input.nowSecs > 0, 'G3', 'bad device clock');

  // ---- request parse, KIND, G2 --------------------------------------------------------
  const isLockScreen = input.screen === 'terms_card';
  const lockReq = AuthorizeRequest.safeParse(input.request);
  const signReq = SignRequest.safeParse(input.request);
  if (isLockScreen && !lockReq.success)
    return fail(signReq.success ? 'KIND' : 'G2', 'terms card expects an AuthorizeRequest');
  if (!isLockScreen && !signReq.success)
    return fail(lockReq.success ? 'KIND' : 'G2', `${input.screen} screen expects a SignRequest`);
  const req = isLockScreen ? lockReq.data! : signReq.data!;
  ctx.bet_id = req.bet_id;

  const env = TermsEnvelope.safeParse(req.envelope);
  if (!env.success) return fail('G2', 'TermsEnvelope does not parse (terms_hash recompute)');
  const terms = env.data.terms;
  const termsHash = env.data.terms_hash;
  need(terms.bet_id === req.bet_id, 'G2', 'envelope bet_id != request bet_id');
  need(
    terms.escrow.program_id === pins.programId &&
      terms.escrow.mint === pins.mint &&
      terms.escrow.cluster === pins.cluster,
    'G1',
    'terms.escrow != the pinned program / mint / cluster',
  );
  const A = terms.party_a.pubkey;
  const B = terms.party_b.pubkey;
  const me: Party | null = input.devicePubkey === A ? 'A' : input.devicePubkey === B ? 'B' : null;
  if (me === null) return fail('G2', 'this wallet is not a party to the displayed Terms');
  need(pins.feePayer !== A && pins.feePayer !== B, 'G5', 'fee payer is a party key');

  const lockMode: LockMode = isLockScreen ? (input as LockPolicyInput).lockMode : 'atomic';
  const kind = expectedKind(input.screen, lockMode, me);
  ctx.kind = kind;
  need(req.kind === kind, 'KIND', `server label ${req.kind} != expected ${kind}`);

  // ---- G3 bytes -----------------------------------------------------------------------
  let b64: Uint8Array;
  try {
    b64 = Uint8Array.from(base64.encode(req.message_b64));
  } catch {
    return fail('G3', 'message_b64 is not base64');
  }
  need(eqBytes(b64, message), 'G3', 'bytes to sign != message_b64');
  const messageSha = bytesToHex(sha256(message));
  need(messageSha === req.message_sha256, 'G3', 'sha256(message) != message_sha256');
  const msg = decodeMessage(message);

  // ---- G4 fee payer -------------------------------------------------------------------
  need(msg.keys[0] === pins.feePayer, 'G4', 'account key 0 is not the pinned fee payer');

  // ---- KIND from the message ----------------------------------------------------------
  const escrowIxs = msg.ixs.filter((ix) => escrowName(ix, pins.programId) !== null);
  const names = new Set(escrowIxs.map((ix) => escrowName(ix, pins.programId)));
  const detected: string =
    names.has('create_bet') && names.has('accept_bet')
      ? 'atomic_lock'
      : ([...names].find((n) => n !== 'close_bet') ?? 'none');
  need(detected === kind, 'KIND', `message is ${detected}, the screen expects ${kind}`);

  // ---- G5 signer set ------------------------------------------------------------------
  const wantSigners =
    kind === 'atomic_lock' ? [pins.feePayer, A, B] : [pins.feePayer, input.devicePubkey];
  need(
    msg.numSigners === wantSigners.length && wantSigners.every((k) => msg.signers.includes(k)),
    'G5',
    `signer set must be exactly {${kind === 'atomic_lock' ? 'fee payer, A, B' : 'fee payer, device'}}`,
  );

  const pdas = input.derive.betPdas(terms.bet_id);
  const eventAuthority = input.derive.eventAuthority();

  if (kind === 'atomic_lock') {
    const lock = req as AuthorizeRequest;
    // ---- L1 instruction list ----------------------------------------------------------
    const ixs = msg.ixs;
    const nonces = ixs.filter(isAdvanceNonce);
    need(nonces.length === 1, 'L1', 'exactly one AdvanceNonceAccount is required');
    need(ixs[0] !== undefined && isAdvanceNonce(ixs[0]), 'L1', 'AdvanceNonceAccount must be ix 0');
    const hasPrice = ixs.length === 5;
    need(
      ixs.length === 4 || hasPrice,
      'L1',
      'lock must be [nonce, CB x1-2, create_bet, accept_bet]',
    );
    const cb = ixs.slice(1, ixs.length - 2);
    need(
      cb.every((ix) => ix.program === COMPUTE_BUDGET_PROGRAM_ID),
      'L1',
      'only ComputeBudget may sit between the nonce and the escrow ixs',
    );
    checkComputeBudget(cb);
    need(cb[0]?.data[0] === 2, 'L1', 'SetComputeUnitLimit must follow the nonce');
    if (hasPrice) need(cb[1]?.data[0] === 3, 'L1', 'then an optional SetComputeUnitPrice');
    const create = ixs[ixs.length - 2] as Ix;
    const accept = ixs[ixs.length - 1] as Ix;
    need(
      escrowName(create, pins.programId) === 'create_bet' &&
        escrowName(accept, pins.programId) === 'accept_bet',
      'L1',
      'escrow ixs must be create_bet then accept_bet',
    );

    // ---- L2 nonce ---------------------------------------------------------------------
    const nonce = ixs[0] as Ix;
    need(
      nonce.data.length === 4 && nonce.accounts.length === 3,
      'L2',
      'malformed AdvanceNonceAccount',
    );
    const [nonceAcct, sysvar, authority] = nonce.accounts as [string, string, string];
    need(sysvar === RECENT_BLOCKHASHES_SYSVAR_ID, 'L2', 'nonce ix sysvar');
    need(authority === pins.feePayer, 'L2', 'nonce authority is not the pinned fee payer');
    const pool = noncePoolAddresses(pins.feePayer);
    need(pool.includes(nonceAcct), 'L2', 'nonce account is not in the fee payer pool (k < 16)');
    need(
      lock.nonce_index !== null && pool[lock.nonce_index] === nonceAcct,
      'L2',
      'nonce account != the AuthorizeRequest nonce_index',
    );
    need(msg.writable(msg.keys.indexOf(nonceAcct)), 'L2', 'nonce account must be writable');

    // ---- L5 / G1 / G6 accounts --------------------------------------------------------
    const c = escrowAccounts(create, 'create_bet', 'L1');
    const a = escrowAccounts(accept, 'accept_bet', 'L1');
    checkEscrowCommon(c, 'create_bet', pins, pdas, eventAuthority, 'L5');
    checkEscrowCommon(a, 'accept_bet', pins, pdas, eventAuthority, 'L5');
    need(c.party_a === A, 'L5', 'create_bet.party_a != displayed A');
    need(a.party_b === B, 'L5', 'accept_bet.party_b != displayed B');

    // ---- G5 placement: both keys, on both phones --------------------------------------
    checkKeyPlacement(ixs, pins.programId, A, create, 'party_a', 'A');
    checkKeyPlacement(ixs, pins.programId, B, accept, 'party_b', 'B');

    // ---- L3 / L4 args, and cross-ix equality ------------------------------------------
    const ca = checkCreateArgs(create, terms, termsHash, input.nowSecs, lock.accept_deadline);
    const aa = checkAcceptArgs(accept, terms, termsHash);
    need(
      eqBytes(aa.expected_terms_hash, ca.terms_hash) &&
        aa.expected_stake_a === ca.stake_a &&
        aa.expected_stake_b === ca.stake_b &&
        aa.expected_party_a === c.party_a,
      'L4',
      'accept_bet args != create_bet args in the same message',
    );
  } else {
    // ---- T1 single-party instruction list ---------------------------------------------
    const ixs = msg.ixs;
    need(!ixs.some(isAdvanceNonce), 'T1', 'durable nonce outside atomic_lock');
    const escrowAt = ixs.findIndex((ix) => {
      const n = escrowName(ix, pins.programId);
      return n !== null && n !== 'close_bet';
    });
    need(escrowAt >= 0, 'T1', 'no escrow instruction');
    const own = ixs[escrowAt] as Ix;
    const ownName = escrowName(own, pins.programId) as EscrowIxName;
    need(ownName === kind, 'T1', `escrow ix is ${ownName}, expected ${kind}`);
    const before = ixs.slice(0, escrowAt);
    const after = ixs.slice(escrowAt + 1);
    const cb = before.filter((ix) => ix.program === COMPUTE_BUDGET_PROGRAM_ID);
    const atas = before.filter((ix) => ix.program === ASSOCIATED_TOKEN_PROGRAM_ID);
    need(
      cb.length + atas.length === before.length,
      'T1',
      'only ComputeBudget / ATA create before the escrow ix',
    );
    need(
      before.every((ix, i) => i < cb.length === (ix.program === COMPUTE_BUDGET_PROGRAM_ID)),
      'T1',
      'ComputeBudget must come first',
    );
    checkComputeBudget(cb);
    need(
      atas.length === 0 || (kind === 'concede' && atas.length === 1),
      'T1',
      'ATA create only on concede, at most one',
    );
    const close = after[0];
    need(
      after.length === 0 || (kind === 'concede' && after.length === 1),
      'T1',
      'only a trailing close_bet (concede)',
    );
    if (close)
      need(
        escrowName(close, pins.programId) === 'close_bet',
        'T1',
        'trailing ix must be close_bet',
      );

    // ---- accounts: G1 / G6, party slot ------------------------------------------------
    const named = escrowAccounts(own, ownName, 'T1');
    checkEscrowCommon(named, ownName, pins, pdas, eventAuthority, 'G1');
    const slot = PARTY_SLOT[ownName] as string;
    need(named[slot] === input.devicePubkey, 'G5', `${ownName}.${slot} != this device`);
    checkKeyPlacement(ixs, pins.programId, input.devicePubkey, own, slot, 'device');

    if (kind === 'create_bet') {
      need(named.party_a === A, 'L5', 'create_bet.party_a != displayed A');
      checkCreateArgs(
        own,
        terms,
        termsHash,
        input.nowSecs,
        (req as AuthorizeRequest).accept_deadline,
      );
    } else if (kind === 'accept_bet') {
      need(named.party_b === B, 'L5', 'accept_bet.party_b != displayed B');
      checkAcceptArgs(own, terms, termsHash);
    } else {
      const sr = req as SignRequest;
      const si = input as SignPolicyInput;
      // G1/G2/G3/G5 cross-checks on the SignRequest wrapper.
      need(sr.fee_payer === pins.feePayer, 'G1', 'SignRequest.fee_payer != pin');
      need(
        sr.signers.length === 2 &&
          new Set<string>(sr.signers).size === 2 &&
          new Set<string>(sr.signers).has(pins.feePayer) &&
          new Set<string>(sr.signers).has(input.devicePubkey),
        'G5',
        'SignRequest.signers != {fee payer, device}',
      );
      need(sr.for_parties[0] === me, 'G2', 'SignRequest is for the other party');
      need(sr.lifetime.blockhash === msg.lifetimeToken, 'G3', 'lifetime blockhash != message');
      need(cardEquals(sr.card, si.renderedCard), 'G2', 'card strings != the phone rendering');

      // ---- T2 ruling --------------------------------------------------------------------
      need(
        sr.ruling_ref.ruling_hash === si.verifiedRulingHash,
        'T2',
        'ruling_hash != the verified ruling',
      );
      need(
        sr.ruling_ref.outcome === si.verifiedRulingOutcome,
        'T2',
        'ruling outcome != the verified ruling',
      );
      const decisive = loserOf(si.verifiedRulingOutcome);
      if (kind === 'concede')
        need(decisive === me, 'T2', 'only the loser may concede a decisive ruling');
      else need(decisive === me || decisive === 'either', 'T2', 'only a loser may appeal');

      // ---- ATA create (concede): funder = fee payer, wallet = the winner -----------------
      for (const ix of atas) {
        need(ix.data.length === 1 && ix.data[0] === 1, 'T1', 'only ATA CreateIdempotent');
        need(ix.accounts.length === 6, 'T1', 'ATA create accounts');
        const [funder, ata, wallet, mint, sys, tok] = ix.accounts as string[];
        need(funder === pins.feePayer, 'T1', 'ATA funder is not the fee payer');
        need(wallet === (me === 'A' ? B : A), 'T1', 'ATA create is not for the winner');
        need(
          mint === pins.mint && tok === pins.tokenProgram && sys === SYSTEM_PROGRAM_ID,
          'T1',
          'ATA create pins',
        );
        need(
          ata === input.derive.associatedTokenAddress(wallet as string, pins.mint),
          'T1',
          'ATA address',
        );
      }

      // ---- T3 close_bet -----------------------------------------------------------------
      if (close) {
        const cl = escrowAccounts(close, 'close_bet', 'T3');
        checkEscrowCommon(cl, 'close_bet', pins, pdas, eventAuthority, 'T3');
        need(cl.rent_payer === pins.feePayer, 'T3', 'close_bet.rent_payer != fee payer');
        // An omitted Option<Account> is passed as the program id (Anchor).
        need(
          cl.party_a_token === pins.programId ||
            cl.party_a_token === input.derive.associatedTokenAddress(A, pins.mint),
          'T3',
          "close_bet.party_a_token is not A's ATA",
        );
      }
    }
  }

  return {
    ok: true,
    kind,
    party: me,
    bet_id: terms.bet_id,
    terms_hash: termsHash,
    message_sha256: messageSha,
  };
}

const CARD_KEYS = [
  'title',
  'prompt_message',
  'hold_label',
  'stakes_line',
  'pot_line',
  'odds_display',
  'terms_code',
  'countdown_ends_at',
] as const;
const cardEquals = (a: SignRequest['card'], b: SignRequest['card']) =>
  CARD_KEYS.every((k) => a[k] === b[k]);

/** ESCROW §4 "Loser": which party may concede / appeal for an outcome (offchain or onchain name). */
function loserOf(outcome: string): Party | 'either' | null {
  if (outcome === 'A_WINS' || outcome === 'PartyA') return 'B';
  if (outcome === 'B_WINS' || outcome === 'PartyB') return 'A';
  if (outcome === 'VOID' || outcome === 'Refund' || outcome === 'Split') return 'either';
  return null;
}
