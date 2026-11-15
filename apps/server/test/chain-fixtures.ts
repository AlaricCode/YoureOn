// Test fixtures for the QuickNode Streams receiver: an IDL-driven Borsh ENCODER (the inverse of
// src/chain/decoder.ts, written independently so a round trip is a real check), sample payloads
// for every escrow event, and getBlock-shaped blocks carrying emit_cpi! inner instructions.
import { randomBytes, randomUUID } from 'node:crypto';
import { getAddressDecoder, getAddressEncoder, getBase58Decoder, type Address } from '@solana/kit';
import { betIdToBytes } from '@youre-on/shared';
import { ESCROW_ID } from '@youre-on/shared/chain/constants';
import idlJson from '@youre-on/shared/idl/escrow.json' with { type: 'json' };

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
      logMessages: [],
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
