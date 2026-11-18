// Test fixtures for the QuickNode Streams receiver: an IDL-driven Borsh ENCODER (the inverse of
// src/chain/decoder.ts, written independently so a round trip is a real check), sample payloads
// for every escrow event, and getBlock-shaped blocks carrying emit_cpi! inner instructions.
import { randomBytes, randomUUID } from 'node:crypto';
import { getAddressDecoder, getAddressEncoder, getBase58Decoder, type Address } from '@solana/kit';
import { betIdToBytes } from '@youre-on/shared';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import idlJson from '@youre-on/shared/idl/escrow.json' with { type: 'json' };
import { quickNodeSignature } from '../src/chain/quicknode';

type T = string | { array: [T, number] } | { vec: T } | { defined: { name: string } };
interface Idl {
  events: { name: string; discriminator: number[] }[];
  types: {
    name: string;
    type:
      | { kind: 'struct'; fields: { name: string; type: T }[] }
      | { kind: 'enum'; variants: { name: string }[] };
  }[];
}
const IDL = idlJson as unknown as Idl;
const TYPES = new Map(IDL.types.map((t) => [t.name, t.type]));
const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();
const b58 = getBase58Decoder();

/** Anchor EVENT_IX_TAG little-endian (independently: sha256("anchor:event")[0..8] reversed). */
export const TAG = [0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d];

export const randomPubkey = (): string => addrDec.decode(new Uint8Array(randomBytes(32)));
export const randomSig = (): string => b58.decode(new Uint8Array(randomBytes(64)));
export const hex32 = (): string => randomBytes(32).toString('hex');

function enc(t: T, v: unknown, out: number[], field: string): void {
  const le = (x: bigint, n: number) => {
    for (let i = 0; i < n; i++) out.push(Number((x >> BigInt(8 * i)) & 0xffn));
  };
  if (typeof t === 'string') {
    switch (t) {
      case 'u8':
        return void out.push(v as number);
      case 'u32':
        return le(BigInt(v as number), 4);
      case 'u64':
        return le(BigInt(v as string), 8);
      case 'i64':
        return le(BigInt.asUintN(64, BigInt(v as number)), 8);
      case 'bool':
        return void out.push(v ? 1 : 0);
      case 'pubkey':
        return void out.push(...addrEnc.encode(v as Address));
    }
    throw new Error(`enc: ${t}`);
  }
  if ('array' in t) {
    const bytes = t.array[1] === 16 ? betIdToBytes(v as string) : Buffer.from(v as string, 'hex');
    return void out.push(...bytes);
  }
  if ('vec' in t) {
    const a = v as unknown[];
    le(BigInt(a.length), 4);
    for (const x of a) enc(t.vec, x, out, field);
    return;
  }
  const def = TYPES.get(t.defined.name)!;
  if (def.kind === 'enum') {
    const i = def.variants.findIndex((x) => x.name === v);
    if (i < 0) throw new Error(`enc: ${field} variant ${String(v)}`);
    return void out.push(i);
  }
  for (const f of def.fields) enc(f.type, (v as Record<string, unknown>)[f.name], out, f.name);
}

/** disc(8) ‖ borsh for `name` with the DATA-MODEL §5.9 payload encoding as input. */
export function encodeEvent(name: string, payload: Record<string, unknown>): Uint8Array {
  const ev = IDL.events.find((e) => e.name === name);
  if (!ev) throw new Error(`no event ${name}`);
  const out = [...ev.discriminator];
  enc({ defined: { name } }, payload, out, name);
  return Uint8Array.from(out);
}

/** A valid sample payload (DATA-MODEL §5.9 encoding) for every IDL event. */
export function samplePayload(
  name: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const pk = randomPubkey;
  const terminal = (final_status: string, outcome: string) => ({
    bet_id: randomUUID(),
    final_status,
    outcome,
    mint: pk(),
    party_a: pk(),
    party_b: pk(),
    party_a_token: pk(),
    party_b_token: '11111111111111111111111111111111',
    to_a: '10000000',
    to_b: '0',
    ts: 1_795_284_425,
  });
  const config = {
    admin: pk(),
    judge_authority: pk(),
    appeal_authority: pk(),
    max_stake: '20000000',
    appeal_window_secs: 10,
    accept_deadline_secs: 120,
    resolve_deadline_secs: 3600,
    appeal_resolve_secs: 600,
    allowed_mints: [pk(), pk()],
    paused: false,
    ts: 1_795_284_000,
  };
  const base: Record<string, Record<string, unknown>> = {
    BetCreated: {
      bet_id: randomUUID(),
      bet: pk(),
      vault: pk(),
      party_a: pk(),
      party_b: pk(),
      mint: pk(),
      stake_a: '5000000',
      stake_b: '5000000',
      terms_hash: hex32(),
      judge_authority: pk(),
      appeal_authority: pk(),
      accept_deadline: 1_795_284_500,
      rent_payer: pk(),
      ts: 1_795_284_400,
    },
    BetAccepted: {
      bet_id: randomUUID(),
      party_a: pk(),
      party_b: pk(),
      terms_hash: hex32(),
      stake_a: '5000000',
      stake_b: '5000000',
      vault_amount: '10000000',
      resolve_deadline: 1_795_288_000,
      ts: 1_795_284_400,
    },
    BetResolved: {
      bet_id: randomUUID(),
      judge: pk(),
      outcome: 'PartyB',
      evidence_hash: hex32(),
      ruling_hash: hex32(),
      appeal_deadline: 1_795_284_435,
      ts: 1_795_284_425,
    },
    BetAppealed: {
      bet_id: randomUUID(),
      appellant: pk(),
      original_outcome: 'PartyA',
      appeal_resolve_deadline: 1_795_285_000,
      ts: 1_795_284_430,
    },
    BetConceded: { ...terminal('Settled', 'PartyA'), conceded_by: pk() },
    BetFinalized: { ...terminal('Settled', 'PartyB'), caller: pk() },
    AppealResolved: {
      ...terminal('Settled', 'PartyA'),
      original_outcome: 'PartyB',
      appeal_ruling_hash: hex32(),
      overturned: true,
    },
    BetRefunded: { ...terminal('Refunded', 'Refund'), from_status: 'Locked', caller: pk() },
    BetCancelled: { ...terminal('Cancelled', 'Refund'), cancelled_by: pk() },
    BetClosed: {
      bet_id: randomUUID(),
      final_status: 'Settled',
      rent_payer: pk(),
      rent_returned: '3062880',
      residual_to_a: '0',
      ts: 1_795_284_426,
    },
    ConfigInitialized: config,
    ConfigUpdated: { ...config, paused: true },
  };
  const p = base[name];
  if (!p) throw new Error(`no sample for ${name}`);
  return { ...p, ...over };
}

export const ALL_EVENT_NAMES = IDL.events.map((e) => e.name);

export interface CpiEvent {
  /** Top-level instruction index this self-CPI hangs off. */
  outer: number;
  bytes: Uint8Array;
  /** Override the program / first account / tag to build negative cases. */
  program?: string;
  firstAccount?: string;
  noTag?: boolean;
}

/**
 * One getBlock (encoding json) transaction: static keys [feePayer, ESCROW_ID, eventAuthority,
 * …extra], inner instructions grouped by `outer`, optionally with keys behind a lookup table.
 */
export function jsonTx(o: {
  signature?: string;
  eventAuthority: string;
  events: CpiEvent[];
  err?: unknown;
  /** Put ESCROW_ID + event authority behind meta.loadedAddresses (v0 tx). */
  viaLookupTable?: boolean;
  /** Also put an event as a TOP-level instruction (must be ignored). */
  topLevel?: Uint8Array;
}) {
  const feePayer = randomPubkey();
  const other = randomPubkey();
  const extra = new Set<string>();
  for (const e of o.events) {
    if (e.program && e.program !== ESCROW_ID) extra.add(e.program);
    if (e.firstAccount && e.firstAccount !== o.eventAuthority) extra.add(e.firstAccount);
  }
  const ours = [ESCROW_ID, o.eventAuthority];
  const staticKeys = o.viaLookupTable
    ? [feePayer, other, ...extra]
    : [feePayer, ...ours, other, ...extra];
  const loaded = o.viaLookupTable
    ? { writable: [] as string[], readonly: ours }
    : { writable: [], readonly: [] };
  const keys = [...staticKeys, ...loaded.writable, ...loaded.readonly];
  const idx = (k: string) => keys.indexOf(k);
  const groups = new Map<
    number,
    { programIdIndex: number; accounts: number[]; data: string; stackHeight: number }[]
  >();
  for (const e of o.events) {
    const data = Uint8Array.from([...(e.noTag ? [0, 0, 0, 0, 0, 0, 0, 0] : TAG), ...e.bytes]);
    const ix = {
      programIdIndex: idx(e.program ?? ESCROW_ID),
      accounts: [idx(e.firstAccount ?? o.eventAuthority)],
      data: b58.decode(data),
      stackHeight: 2,
    };
    groups.set(e.outer, [...(groups.get(e.outer) ?? []), ix]);
  }
  const maxOuter = Math.max(0, ...o.events.map((e) => e.outer));
  const instructions = Array.from({ length: maxOuter + 1 }, () => ({
    programIdIndex: idx(ESCROW_ID),
    accounts: [0],
    data: b58.decode(Uint8Array.from([1, 2, 3])),
    stackHeight: 1,
  }));
  if (o.topLevel)
    instructions.push({
      programIdIndex: idx(ESCROW_ID),
      accounts: [idx(o.eventAuthority)],
      data: b58.decode(Uint8Array.from([...TAG, ...o.topLevel])),
      stackHeight: 1,
    });
  return {
    meta: {
      err: o.err ?? null,
      innerInstructions: [...groups.entries()].map(([index, ixs]) => ({
        index,
        instructions: ixs,
      })),
      loadedAddresses: loaded,
      logMessages: [] as string[],
    },
    transaction: {
      message: { accountKeys: staticKeys, instructions },
      signatures: [o.signature ?? randomSig()],
    },
    version: o.viaLookupTable ? 0 : 'legacy',
  };
}

/** The same tx in jsonParsed shape (accountKeys objects, inner ixs with programId/accounts strings). */
export function toJsonParsed(tx: ReturnType<typeof jsonTx>) {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...tx.meta.loadedAddresses.writable,
    ...tx.meta.loadedAddresses.readonly,
  ];
  return {
    meta: {
      ...tx.meta,
      innerInstructions: tx.meta.innerInstructions.map((g) => ({
        index: g.index,
        instructions: g.instructions.map((ix) => ({
          programId: keys[ix.programIdIndex],
          accounts: ix.accounts.map((a) => keys[a]),
          data: ix.data,
          stackHeight: ix.stackHeight,
        })),
      })),
    },
    transaction: {
      ...tx.transaction,
      message: {
        ...tx.transaction.message,
        accountKeys: keys.map((pubkey) => ({ pubkey, signer: false, writable: false })),
      },
    },
    version: tx.version,
  };
}

export function block(
  transactions: unknown[],
  o: { blockHeight?: number; parentSlot?: number; blockTime?: number } = {},
) {
  return {
    blockHeight: o.blockHeight ?? 400_118_207,
    blockTime: o.blockTime ?? 1_795_284_425,
    blockhash: '9TmP9DSp8AL7hBi3U6XC3sXq1YJ5LPHZwcgbnS45i4G',
    parentSlot: o.parentSlot ?? 519_807_090,
    previousBlockhash: '9TmP9DSp8AL7hBi3U6XC3sXq1YJ5LPHZwcgbnS45i4G',
    transactions,
  };
}

// ---- one bet's consistent lifecycle (projector tests) ------------------------------------------

/** The binding facts of one bet, shared by its row and every event the chain emits for it. */
export interface BetFacts {
  bet_id: string;
  party_a: string;
  party_b: string;
  mint: string;
  stake_a: string;
  stake_b: string;
  terms_hash: string;
  bet: string;
  vault: string;
  rent_payer: string;
  judge: string;
  /** unix seconds of the lock (other timestamps follow it). */
  t0: number;
}

export function betFacts(over: Partial<BetFacts> = {}): BetFacts {
  return {
    bet_id: randomUUID(),
    party_a: randomPubkey(),
    party_b: randomPubkey(),
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    stake_a: '5000000',
    stake_b: '5000000',
    terms_hash: hex32(),
    bet: randomPubkey(),
    vault: randomPubkey(),
    rent_payer: randomPubkey(),
    judge: randomPubkey(),
    t0: 1_795_284_400,
    ...over,
  };
}

type Outcome = 'PartyA' | 'PartyB' | 'Split' | 'Refund';

/** Payout per ESCROW §6 over V = stake_a + stake_b (B gets the odd unit on Split). */
export function payoutOf(f: BetFacts, outcome: Outcome): { to_a: string; to_b: string } {
  const a = BigInt(f.stake_a);
  const v = a + BigInt(f.stake_b);
  const to_a =
    outcome === 'PartyA' ? v : outcome === 'PartyB' ? 0n : outcome === 'Split' ? v / 2n : a;
  return { to_a: to_a.toString(), to_b: (v - to_a).toString() };
}

/** DATA-MODEL §5.9 payloads for every event of the bet `f`, consistent with each other. */
export function lifecycle(f: BetFacts) {
  const DEFAULT_KEY = '11111111111111111111111111111111';
  const terminal = (final_status: string, outcome: Outcome, ts: number) => {
    const p = payoutOf(f, outcome);
    return {
      bet_id: f.bet_id,
      final_status,
      outcome,
      mint: f.mint,
      party_a: f.party_a,
      party_b: f.party_b,
      party_a_token: p.to_a === '0' ? DEFAULT_KEY : randomPubkey(),
      party_b_token: p.to_b === '0' ? DEFAULT_KEY : randomPubkey(),
      ...p,
      ts,
    };
  };
  return {
    created: () => ({
      bet_id: f.bet_id,
      bet: f.bet,
      vault: f.vault,
      party_a: f.party_a,
      party_b: f.party_b,
      mint: f.mint,
      stake_a: f.stake_a,
      stake_b: f.stake_b,
      terms_hash: f.terms_hash,
      judge_authority: f.judge,
      appeal_authority: randomPubkey(),
      accept_deadline: f.t0 + 300,
      rent_payer: f.rent_payer,
      ts: f.t0,
    }),
    accepted: () => ({
      bet_id: f.bet_id,
      party_a: f.party_a,
      party_b: f.party_b,
      terms_hash: f.terms_hash,
      stake_a: f.stake_a,
      stake_b: f.stake_b,
      vault_amount: (BigInt(f.stake_a) + BigInt(f.stake_b)).toString(),
      resolve_deadline: f.t0 + 3600,
      ts: f.t0,
    }),
    resolved: (outcome: Outcome, o: { ruling_hash?: string; evidence_hash?: string } = {}) => ({
      bet_id: f.bet_id,
      judge: f.judge,
      outcome,
      evidence_hash: o.evidence_hash ?? 'cd'.repeat(32),
      ruling_hash: o.ruling_hash ?? 'ab'.repeat(32),
      appeal_deadline: f.t0 + 70,
      ts: f.t0 + 60,
    }),
    appealed: (original: Outcome) => ({
      bet_id: f.bet_id,
      appellant: original === 'PartyA' ? f.party_b : f.party_a,
      original_outcome: original,
      appeal_resolve_deadline: f.t0 + 700,
      ts: f.t0 + 65,
    }),
    conceded: (outcome: Outcome) => ({
      ...terminal('Settled', outcome, f.t0 + 66),
      conceded_by: outcome === 'PartyA' ? f.party_b : f.party_a,
    }),
    finalized: (outcome: Outcome) => ({
      ...terminal('Settled', outcome, f.t0 + 71),
      caller: f.rent_payer,
    }),
    appealResolved: (outcome: Outcome, original: Outcome) => ({
      ...terminal('Settled', outcome, f.t0 + 90),
      original_outcome: original,
      appeal_ruling_hash: 'ef'.repeat(32),
      overturned: outcome !== original,
    }),
    refunded: (from: 'Open' | 'Locked' | 'Appealed') => ({
      ...terminal('Refunded', from === 'Open' ? 'PartyA' : 'Refund', f.t0 + 3601),
      outcome: 'Refund',
      ...(from === 'Open'
        ? { to_a: f.stake_a, to_b: '0', party_b_token: DEFAULT_KEY }
        : payoutOf(f, 'Refund')),
      from_status: from,
      caller: f.rent_payer,
    }),
    closed: (final_status: string, ts = f.t0 + 72) => ({
      bet_id: f.bet_id,
      final_status,
      rent_payer: f.rent_payer,
      rent_returned: '3062880',
      residual_to_a: '0',
      ts,
    }),
  };
}

// ---- webhook deliveries (the filter.js envelope, API-CONTRACT §5.2) ---------------------------

export type DeliveryEvent = {
  outerIx: number;
  innerIx?: number;
  name: string;
  payload: Record<string, unknown>;
};

/** A filter output envelope with the given txs (events encoded with the IDL). */
export function delivery(
  txs: { signature: string; blockHeight?: number; txIndex?: number; events: DeliveryEvent[] }[],
) {
  return {
    v: 1,
    programId: ESCROW_ID,
    network: 'solana-devnet',
    dataset: 'block',
    batchStart: 519_807_088,
    batchEnd: 519_807_092,
    txs: txs.map((t) => ({
      signature: t.signature,
      blockHeight: t.blockHeight ?? 400_118_207,
      parentSlot: 519_807_090,
      blockTime: 1_795_284_425,
      txIndex: t.txIndex ?? 0,
      events: t.events.map((e) => ({
        outerIx: e.outerIx,
        innerIx: e.innerIx ?? 0,
        name: e.name,
        eventBase64: Buffer.from(encodeEvent(e.name, e.payload)).toString('base64'),
      })),
    })),
  };
}

/** X-QN-* headers QuickNode would send for `body` (hex HMAC-SHA256(token, nonce ‖ ts ‖ body)). */
export function qnSignedHeaders(body: Uint8Array, secret: string, tsMs: number) {
  const nonce = randomBytes(8).toString('hex');
  const ts = String(Math.floor(tsMs / 1000));
  return {
    'content-type': 'application/json',
    'x-qn-nonce': nonce,
    'x-qn-timestamp': ts,
    'x-qn-signature': quickNodeSignature(secret, nonce, ts, body),
    'batch-start-range': '519807088',
    'batch-end-range': '519807092',
    'stream-dataset': 'block',
  };
}
