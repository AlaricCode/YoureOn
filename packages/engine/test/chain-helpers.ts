/**
 * Shared fixtures for the chain-model tests: deterministic keys, fake
 * decoders/interpreter, and a driver that walks a Bet through its lifecycle.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { expect } from 'vitest';
import { createChainModel, type ChainHooks, type ChainModelOptions } from '../src/chain/index.js';
import { sha256, toHex, utf8, ZERO_HASH } from '../src/chain/bytes.js';
import { termsHashOf } from '../src/chain/hashes.js';
import type {
  BetAccount,
  ChainApplyResult,
  ChainContext,
  ChainInstruction,
  DecodedProgram,
  EvalResult,
  InstructionAccountsMap,
  InstructionArgsMap,
  InstructionName,
  Pubkey,
  TrackBufferAccount,
} from '../src/types.js';

export interface Key {
  sk: Uint8Array;
  pk: Pubkey;
}

export function key(n: number): Key {
  const sk = new Uint8Array(32).fill(n);
  return { sk, pk: bs58.encode(ed25519.getPublicKey(sk)) };
}

export const PROGRAM_ID = key(200).pk;
export const BET = key(201).pk;
export const VAULT = key(202).pk;
export const TRACKS = key(203).pk;
export const MINT = key(204).pk;
export const ORACLE = key(100);
export const JUDGES = [key(110), key(111), key(112)] as const;
export const ALICE = key(1);
export const BOB = key(2);
export const CAROL = key(3);
export const STRANGER = key(50);
export const WITNESS = [key(60), key(61)] as const;

/** Token account name for a wallet in tests. */
export const ata = (wallet: Pubkey): Pubkey => bs58.encode(sha256(utf8('ata:' + wallet)));

/** Fake program "binary": JSON of a DecodedProgram prefixed by a tag. */
export function fakeProgramBin(dp: Partial<DecodedProgram>): Uint8Array {
  return utf8('PROG' + JSON.stringify(dp));
}

export function fakeDecodedProgram(over: Partial<DecodedProgram> = {}): DecodedProgram {
  return {
    kind: 0,
    P: 2,
    json_hash: ZERO_HASH,
    time_limit_s: 60,
    participants: [ALICE.pk, BOB.pk],
    stakes: [1_000_000, 1_000_000],
    side_b_mask: 2,
    entities: [],
    legs: [
      {
        id: 1,
        flags: 0,
        rule_kind: 0,
        rule_cmp: 0,
        rule_k: 0,
        rule_n: 0,
        attempt_window: 50,
        va: new Uint8Array(),
        succ: new Uint8Array([1]),
      },
    ],
    if_true: 0,
    else_side: 1,
    cond: new Uint8Array(),
    tracked_entities: [],
    ...over,
  };
}

export class FakeEngine {
  result: EvalResult = okResult(1);
  lastVerified: { participant: number; frame: number }[] = [];
  hooks(): ChainHooks {
    const dec = new TextDecoder();
    return {
      decodeProgram: (bin) => {
        const s = dec.decode(bin);
        if (!s.startsWith('PROG')) throw Object.assign(new Error('bad program'), { code: 'MalformedProgram' });
        return JSON.parse(s.slice(4)) as DecodedProgram;
      },
      decodeCalibration: (bin) => {
        if (dec.decode(bin.subarray(0, 4)) !== 'VCAL') throw new Error('bad calibration');
        return { scene_hash: ZERO_HASH, regions: [] };
      },
      decodeTrackBin: (bin) => {
        if (dec.decode(bin.subarray(0, 4)) !== 'VTRK') throw new Error('bad tracks');
        return { flags: 2, model_hash: ZERO_HASH, tracks: [], segments: [] };
      },
      decodeMarketBin: (bin) => {
        if (dec.decode(bin.subarray(0, 4)) !== 'VMKT') throw new Error('bad market');
        return [];
      },
      evaluate: (_p, _c, _t, verified) => {
        this.lastVerified = verified;
        return this.result;
      },
    };
  }
}

export function okResult(winnerMask: number, legs: (0 | 1 | 2)[] = [1]): EvalResult {
  return {
    status: 'ok',
    reason: 0,
    preruling: 1,
    winner_mask: winnerMask,
    leg_results: legs,
    leg_causes: legs.map(() => []),
    decisive_frames: legs.map(() => []),
    attempts: [],
    checkpoints: [],
    n_checkpoints: 0,
    cost: 0,
  };
}

export function panelResult(reason: 10 | 11 | 12 | 13): EvalResult {
  return { ...okResult(0, [2]), status: 'needs_panel', reason, preruling: 3 };
}

export const T0 = 1_700_000_000n;

/** Mutable world around one Bet: account state, clock, track buffer, balances. */
export class World {
  readonly engine = new FakeEngine();
  model;
  bet: BetAccount;
  now = T0;
  slot = 1000n;
  trackBuffer: TrackBufferAccount | null = null;
  vaultExtra = 0n;
  balances = new Map<Pubkey, bigint>();
  programBin: Uint8Array;
  calibrationBin = utf8('VCAL-test-calibration');
  trackBin = utf8('VTRK-test-tracks');
  prevInstruction: ChainContext['prev_instruction'] = null;
  profile: ChainContext['profile'] = null;
  last: ChainApplyResult | null = null;

  constructor(
    readonly opts: { flags?: number; participants?: Key[]; stakes?: bigint[]; sideB?: number; timeLimit?: number } = {},
    modelOpts: ChainModelOptions = {},
  ) {
    this.model = createChainModel({ ...modelOpts, hooks: this.engine.hooks() });
    this.bet = this.model.initialBet({ bump: 254, vault_bump: 253 });
    const parts = (opts.participants ?? [ALICE, BOB]).map((k) => k.pk);
    const flags = opts.flags ?? 0;
    const market = (flags & 4) !== 0;
    const stakes = opts.stakes ?? parts.map(() => 1_000_000n);
    this.programBin = fakeProgramBin(
      fakeDecodedProgram({
        kind: market ? 2 : (flags & 2) !== 0 ? 1 : 0,
        P: parts.length,
        participants: parts,
        stakes: stakes.map(Number),
        side_b_mask: opts.sideB ?? 2,
        time_limit_s: opts.timeLimit ?? 60,
      }),
    );
    if (market) this.trackBin = utf8('VMKT-test');
    if ((flags & 6) !== 0) this.calibrationBin = new Uint8Array();
  }

  get programHash(): string {
    return toHex(sha256(this.programBin));
  }

  get calibrationHash(): string {
    return this.calibrationBin.length === 0 ? ZERO_HASH : toHex(sha256(this.calibrationBin));
  }

  ctx(): ChainContext {
    const owners: Record<string, string> = {};
    for (const k of [ALICE, BOB, CAROL, STRANGER]) owners[ata(k.pk)] = k.pk;
    const funded = this.bet.version === 0 ? 0n : accountedFor(this.bet);
    return {
      now_s: this.now,
      slot: this.slot,
      slot_hashes: [
        { slot: this.slot, hash: toHex(sha256(utf8('slot' + this.slot))) },
        { slot: this.slot - 1n, hash: toHex(sha256(utf8('slot' + (this.slot - 1n)))) },
        { slot: this.slot - 150n, hash: toHex(sha256(utf8('slot' + (this.slot - 150n)))) },
        { slot: this.slot - 151n, hash: toHex(sha256(utf8('slot' + (this.slot - 151n)))) },
      ],
      program_id: PROGRAM_ID,
      profile: this.profile,
      track_buffer: this.trackBuffer,
      prev_instruction: this.prevInstruction,
      token_owners: owners,
      vault_amount: funded + this.vaultExtra,
    };
  }

  /** Applies an instruction; on success commits the new state. */
  apply<N extends InstructionName>(
    name: N,
    args: InstructionArgsMap[N],
    signers: Pubkey[],
    accounts: Partial<Record<InstructionAccountsMap[N], Pubkey>> = {},
    remaining?: Pubkey[],
  ): ChainApplyResult {
    const defaults: Record<string, Pubkey> = {
      bet: BET,
      vault: VAULT,
      oracle: this.bet.oracle !== '11111111111111111111111111111111' ? this.bet.oracle : ORACLE.pk,
      track_buffer: TRACKS,
      mint: MINT,
    };
    const ix: ChainInstruction = {
      name,
      args,
      signers,
      accounts: { ...defaults, ...accounts } as ChainInstruction['accounts'],
      remaining_accounts:
        remaining ?? this.bet.participants.slice(0, this.bet.n_participants).map((p) => ata(p)),
    };
    const before = this.bet;
    const r = this.model.apply(before, ix, this.ctx());
    this.last = r;
    if (!('error' in r)) {
      this.bet = r.bet;
      if (r.track_buffer !== undefined) this.trackBuffer = r.track_buffer;
      for (const t of r.transfers) {
        this.balances.set(t.to, (this.balances.get(t.to) ?? 0n) + t.amount);
        this.balances.set(t.from, (this.balances.get(t.from) ?? 0n) - t.amount);
      }
    }
    return r;
  }

  ok<N extends InstructionName>(
    name: N,
    args: InstructionArgsMap[N],
    signers: Pubkey[],
    accounts: Partial<Record<InstructionAccountsMap[N], Pubkey>> = {},
    remaining?: Pubkey[],
  ): Exclude<ChainApplyResult, { error: string }> {
    const r = this.apply(name, args, signers, accounts, remaining);
    if ('error' in r) throw new Error(`${name} failed: ${r.error}`);
    return r;
  }

  err<N extends InstructionName>(
    expected: string,
    name: N,
    args: InstructionArgsMap[N],
    signers: Pubkey[],
    accounts: Partial<Record<InstructionAccountsMap[N], Pubkey>> = {},
    remaining?: Pubkey[],
  ): void {
    const before = this.bet;
    const r = this.apply(name, args, signers, accounts, remaining);
    expect(r).toEqual({ error: expected });
    expect(this.bet).toBe(before);
  }

  // ---- lifecycle steps ---------------------------------------------------

  createArgs(over: Partial<InstructionArgsMap['create_bet']> = {}): InstructionArgsMap['create_bet'] {
    const parts = (this.opts.participants ?? [ALICE, BOB]).map((k) => k.pk);
    const flags = this.opts.flags ?? 0;
    const market = (flags & 4) !== 0;
    const stakes = this.opts.stakes ?? parts.map(() => 1_000_000n);
    return {
      nonce: 7n,
      participants: parts,
      stakes,
      side_b_mask: this.opts.sideB ?? 2,
      stake_each: market ? 0n : stakes[0]!,
      time_limit_s: this.opts.timeLimit ?? 60,
      flags,
      program_hash: this.programHash,
      acceptance_audio_hash: ZERO_HASH,
      judges: [JUDGES[0].pk, JUDGES[1].pk, JUDGES[2].pk],
      ...over,
    };
  }

  create(over: Partial<InstructionArgsMap['create_bet']> = {}): this {
    const a = this.createArgs(over);
    this.ok('create_bet', a, [a.participants[0]!, ORACLE.pk], { creator: a.participants[0]! });
    return this;
  }

  fundArgs(): InstructionArgsMap['fund'] {
    return {
      calibration_hash: this.calibrationHash,
      program_hash: this.bet.program_hash,
      terms_hash: toHex(termsHashOf(this.bet.oracle, this.bet.judges, this.bet.acceptance_audio_hash)),
    };
  }

  fund(k: Key): this {
    this.ok('fund', this.fundArgs(), [k.pk], { participant: k.pk, participant_token: ata(k.pk) });
    return this;
  }

  fundAll(): this {
    for (let i = 0; i < this.bet.n_participants; i++) {
      const pk = this.bet.participants[i]!;
      this.ok('fund', this.fundArgs(), [pk], { participant: pk, participant_token: ata(pk) });
    }
    return this;
  }

  start(witnesses = [{ key: WITNESS[0].pk, kind: 0 as const }, { key: WITNESS[1].pk, kind: 1 as const }]): this {
    const market = (this.bet.flags & 4) !== 0;
    this.ok('start', { beacon_slot: market ? 0n : this.slot - 1n, witnesses: market ? [] : witnesses }, [ORACLE.pk], {
      authority: ORACLE.pk,
    });
    return this;
  }

  end(): this {
    this.ok('end', { seq: 0, heads: [] }, [ORACLE.pk], { authority: ORACLE.pk });
    return this;
  }

  payload(): Uint8Array {
    const p = new Uint8Array(this.programBin.length + this.calibrationBin.length + this.trackBin.length);
    p.set(this.programBin, 0);
    p.set(this.calibrationBin, this.programBin.length);
    p.set(this.trackBin, this.programBin.length + this.calibrationBin.length);
    return p;
  }

  postTracks(payload = this.payload(), chunk = 700, perceptionRoot = 'ab'.repeat(32)): this {
    for (let off = 0; off < payload.length || off === 0; off += chunk) {
      const data = payload.subarray(off, Math.min(payload.length, off + chunk));
      const last = off + chunk >= payload.length;
      this.ok(
        'post_tracks',
        {
          payload_len: payload.length,
          program_len: this.programBin.length,
          calibration_len: this.calibrationBin.length,
          offset: off,
          data,
          finalize: last,
          perception_root: last ? perceptionRoot : ZERO_HASH,
        },
        [ORACLE.pk],
      );
      if (last) break;
    }
    return this;
  }

  runRules(): Exclude<ChainApplyResult, { error: string }> {
    return this.ok('run_rules', {}, [ORACLE.pk]);
  }

  /** Create → fund → start → end → post → run_rules (WINNER for `winnerMask`). */
  toPreRuled(winnerMask = 1): this {
    this.create().fundAll().start().end().postTracks();
    this.engine.result = okResult(winnerMask);
    this.runRules();
    return this;
  }
}

function accountedFor(bet: BetAccount): bigint {
  let a = 0n;
  for (let i = 0; i < bet.n_participants; i++) if ((bet.funded_mask >> i) & 1) a += bet.stakes[i]!;
  if (bet.dispute_bond > 0n) a += bet.dispute_bond;
  return a;
}
