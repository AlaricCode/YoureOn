import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { ED25519_PROGRAM_ID, INSTRUCTION_NAMES } from '../src/constants.js';
import {
  BET_DISCRIMINATOR,
  decodeBetAccount,
  decodeEvent,
  decodeEventTyped,
  decodeInstruction,
  decodeProfile,
  decodeTrackBufferHeader,
  ed25519PanelIxData,
  encodeBetAccount,
  encodeEvent,
  encodeInstruction,
  encodeProfile,
  encodeTrackBufferHeader,
  eventLogLine,
  findProgramAddress,
  betPda,
  createProgramAddress,
  parseEd25519PanelIxData,
  parseEventLogLine,
  PROFILE_DISCRIMINATOR,
  zeroBet,
} from '../src/chain/index.js';
import { ascii, BorshReader, BorshWriter, fromBase64, toBase64, ZERO_HASH } from '../src/chain/bytes.js';
import type { InstructionArgsMap, InstructionName, ProfileAccount, VerdictEvent } from '../src/types.js';
import { ALICE, BET, BOB, JUDGES, key, PROGRAM_ID, World } from './chain-helpers.js';

const disc = (s: string) => sha256(ascii(s)).slice(0, 8);

describe('Bet account layout (§9.3)', () => {
  it('is 8 + 1580 bytes with the account:Bet discriminator', () => {
    const b = encodeBetAccount(zeroBet());
    expect(b.length).toBe(1588);
    expect(BET_DISCRIMINATOR).toEqual(disc('account:Bet'));
    expect(b.subarray(0, 8)).toEqual(disc('account:Bet'));
  });

  it('places fields at the documented offsets', () => {
    const w = new World().toPreRuled(1);
    const bytes = encodeBetAccount(w.bet);
    const body = bytes.subarray(8);
    expect(body[0]).toBe(1); // version
    expect(body[1]).toBe(254); // bump
    expect(body[3]).toBe(4); // state PreRuled
    // creator at 5..37
    expect(new BorshReader(body.subarray(5, 37)).pubkey()).toBe(ALICE.pk);
    // n_participants at 5+32+8+32+32+96 = 205
    expect(body[205]).toBe(2);
    // stakes at 206 + 256 = 462
    expect(new BorshReader(body.subarray(462, 470)).u64()).toBe(1_000_000n);
    // the last 64 bytes are reserved and zero; refund_reason just before
    expect(body.subarray(1516).every((x) => x === 0)).toBe(true);
    expect(body.length - 64 - 1).toBe(1515);
  });

  it('round-trips a populated Bet', () => {
    const w = new World().toPreRuled(1);
    const b = { ...w.bet, n_bio: 2, bio: [{ participant: 1, modality: 1 as const, frame: 99 }, { participant: 0, modality: 0 as const, frame: 7 }, ...w.bet.bio.slice(2)] };
    b.started_at = -5n; // i64 sign handling
    expect(decodeBetAccount(encodeBetAccount(b))).toEqual(b);
  });

  it('rejects malformed account data', () => {
    const good = encodeBetAccount(new World().create().bet);
    expect(() => decodeBetAccount(good.subarray(0, 1587))).toThrow();
    const badDisc = good.slice();
    badDisc[0] ^= 1;
    expect(() => decodeBetAccount(badDisc)).toThrow(/discriminator/);
    const reserved = good.slice();
    reserved[1587] = 1;
    expect(() => decodeBetAccount(reserved)).toThrow(/reserved/);
    const state = good.slice();
    state[8 + 3] = 8;
    expect(() => decodeBetAccount(state)).toThrow(/state/);
  });
});

describe('Profile account (§9.3)', () => {
  const p: ProfileAccount = {
    wallet: ALICE.pk,
    face_commit: '01'.repeat(32),
    voice_commit: ZERO_HASH,
    display_name: 'Zoë',
    name_len: 4,
    flags: 1,
    bump: 255,
    created_at: 10n,
    updated_at: 20n,
    reserved: ZERO_HASH,
  };
  it('is 8 + 179 bytes and round-trips', () => {
    const b = encodeProfile(p);
    expect(b.length).toBe(187);
    expect(PROFILE_DISCRIMINATOR).toEqual(disc('account:Profile'));
    expect(decodeProfile(b)).toEqual(p);
  });
  it('rejects non-zero padding / reserved and bad lengths', () => {
    const b = encodeProfile(p);
    const pad = b.slice();
    pad[8 + 32 + 64 + 10] = 1;
    expect(() => decodeProfile(pad)).toThrow(/padding/);
    const res = b.slice();
    res[186] = 1;
    expect(() => decodeProfile(res)).toThrow(/reserved/);
    const nl = b.slice();
    nl[8 + 32 + 64 + 32] = 33;
    expect(() => decodeProfile(nl)).toThrow();
    expect(() => encodeProfile({ ...p, display_name: 'x'.repeat(33), name_len: 33 })).toThrow();
  });
});

describe('TrackBuffer header', () => {
  it('is 48 bytes and round-trips', () => {
    const h = { bet: BET, payload_len: 9999, program_len: 300, calibration_len: 120, written: 700, finalized: 0, bump: 251 };
    const b = encodeTrackBufferHeader(h);
    expect(b.length).toBe(48);
    expect(decodeTrackBufferHeader(b)).toEqual(h);
  });
});

const sampleArgs: { [N in InstructionName]: InstructionArgsMap[N] } = {
  init_profile: { face_commit: '11'.repeat(32), voice_commit: ZERO_HASH, display_name: 'Al' },
  create_bet: {
    nonce: 42n,
    participants: [ALICE.pk, BOB.pk],
    stakes: [1_000_000n, 1_000_000n],
    side_b_mask: 2,
    stake_each: 1_000_000n,
    time_limit_s: 120,
    flags: 1,
    program_hash: '22'.repeat(32),
    acceptance_audio_hash: '33'.repeat(32),
    judges: [JUDGES[0].pk, JUDGES[1].pk, JUDGES[2].pk],
  },
  fund: { calibration_hash: '44'.repeat(32), program_hash: '22'.repeat(32), terms_hash: '55'.repeat(32) },
  cancel: {},
  start: { beacon_slot: 123456789n, witnesses: [{ key: key(9).pk, kind: 1 }] },
  commit_evidence: { seq: 3, heads: [{ index: 0xffffffff, hash: '66'.repeat(32) }] },
  end: { seq: 0, heads: [] },
  post_tracks: {
    payload_len: 1000,
    program_len: 200,
    calibration_len: 100,
    offset: 700,
    data: new Uint8Array([1, 2, 3]),
    finalize: true,
    perception_root: '77'.repeat(32),
  },
  run_rules: {},
  consent: { winner_mask: 1, evidence_root: '88'.repeat(32) },
  dispute: { reason: 2, evidence_root: '88'.repeat(32) },
  settle_panel: { outcome: 2 },
  verify_biometric_proof: {
    participant: 1,
    modality: 0,
    frame: 41,
    tau_bps: 5500,
    proof_a: new Uint8Array(64).fill(1),
    proof_b: new Uint8Array(128).fill(2),
    proof_c: new Uint8Array(64).fill(3),
  },
  verify_sp1_run: { public_values: new Uint8Array(171).fill(9), proof: new Uint8Array([7, 7]) },
  refund: {},
};

describe('instructions (§9.4)', () => {
  for (const name of INSTRUCTION_NAMES) {
    it(`${name}: global discriminator and round-trip`, () => {
      const data = encodeInstruction(name, sampleArgs[name] as never);
      expect(data.subarray(0, 8)).toEqual(disc(`global:${name}`));
      expect(decodeInstruction(data)).toEqual({ name, args: sampleArgs[name] });
    });
  }
  it('Borsh layouts of selected args', () => {
    expect(encodeInstruction('settle_panel', { outcome: 2 }).length).toBe(9);
    expect(encodeInstruction('run_rules', {}).length).toBe(8);
    // post_tracks: 4+2+2+4 + (4+3) + 1 + 32
    expect(encodeInstruction('post_tracks', sampleArgs.post_tracks).length).toBe(8 + 12 + 7 + 1 + 32);
    // create_bet with 8 participants fits the ≈1,050 B tx budget's instruction-data share
    const c = encodeInstruction('create_bet', sampleArgs.create_bet);
    expect(c.length).toBe(8 + 8 + 4 + 64 + 4 + 16 + 1 + 8 + 4 + 1 + 32 + 32 + 96);
    // verify_biometric_proof
    expect(encodeInstruction('verify_biometric_proof', sampleArgs.verify_biometric_proof).length).toBe(8 + 1 + 1 + 4 + 2 + 256);
  });
  it('rejects unknown discriminators and trailing bytes', () => {
    expect(() => decodeInstruction(new Uint8Array(8))).toThrow(/discriminator/);
    const d = encodeInstruction('settle_panel', { outcome: 1 });
    const t = new Uint8Array(d.length + 1);
    t.set(d);
    expect(() => decodeInstruction(t)).toThrow(/trailing/);
    expect(() => encodeInstruction('fund', { ...sampleArgs.fund, terms_hash: 'zz' })).toThrow();
  });
});

const sampleEvents: VerdictEvent[] = [
  { name: 'ProfileUpdated', data: { wallet: ALICE.pk, flags: 3 } },
  {
    name: 'BetCreated',
    data: {
      bet: BET,
      creator: ALICE.pk,
      nonce: 1n,
      participants: [ALICE.pk, BOB.pk],
      stakes: [10_000n, 20_000n],
      side_b_mask: 2,
      flags: 4,
      program_hash: 'aa'.repeat(32),
      time_limit_s: 99,
      fund_deadline: 1_700_000_900n,
    },
  },
  {
    name: 'Funded',
    data: { bet: BET, participant: BOB.pk, participant_idx: 1, amount: 5n, funded_mask: 3, all_funded: true, calibration_hash: ZERO_HASH },
  },
  { name: 'BetCancelled', data: { bet: BET } },
  { name: 'BetStarted', data: { bet: BET, beacon_slot: 77n, beacon_hash: 'bb'.repeat(32), started_at: 5n, n_witnesses: 2 } },
  { name: 'EvidenceCommitted', data: { bet: BET, seq: 4, root: 'cc'.repeat(32), gap_mask: 1, is_final: false } },
  { name: 'BetEnded', data: { bet: BET, evidence_root: 'cc'.repeat(32), ended_at: 9n } },
  { name: 'TracksPosted', data: { bet: BET, perception_root: 'dd'.repeat(32), tracks_hash: 'ee'.repeat(32), payload_len: 2216 } },
  { name: 'BiometricVerified', data: { bet: BET, participant_idx: 1, modality: 1, frame: 41 } },
  {
    name: 'PreRuled',
    data: { bet: BET, preruling: 1, reason: 0, winner_mask: 2, leg_results: [1, 255, 255, 255, 255, 255, 255, 255], consent_deadline: 1700000120n },
  },
  { name: 'Consented', data: { bet: BET, participant: ALICE.pk, consent_mask: 1 } },
  { name: 'Disputed', data: { bet: BET, disputer: BOB.pk, reason: 1, bond: 100_000n } },
  { name: 'Settled', data: { bet: BET, path: 1, winner_mask: 1, pot: 3n, payouts: [3n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] } },
  { name: 'Refunded', data: { bet: BET, reason: 1, amounts: [1n, 2n, 0n, 0n, 0n, 0n, 0n, 0n] } },
];

describe('events (§9.5, §12.5)', () => {
  for (const ev of sampleEvents) {
    it(`${ev.name}: event discriminator and round-trip`, () => {
      const b = encodeEvent(ev.name, ev.data as never);
      expect(b.subarray(0, 8)).toEqual(disc(`event:${ev.name}`));
      expect(decodeEventTyped(b)).toEqual(ev);
    });
  }
  it('decodeEvent returns the §12.5 JSON encoding', () => {
    const pre = sampleEvents.find((e) => e.name === 'PreRuled')!;
    const line = eventLogLine(pre);
    expect(line.startsWith('Program data: ')).toBe(true);
    const j = parseEventLogLine(line)!;
    expect(j).toEqual({
      name: 'PreRuled',
      data: { bet: BET, preruling: 1, reason: 0, winner_mask: 2, leg_results: [1, 255, 255, 255, 255, 255, 255, 255], consent_deadline: '1700000120' },
    });
    const created = decodeEvent(toBase64(encodeEvent('BetCreated', sampleEvents[1]!.data as never)));
    expect(created.data).toMatchObject({ nonce: '1', stakes: ['10000', '20000'], fund_deadline: '1700000900' });
    expect(parseEventLogLine('Program log: hi')).toBeNull();
    expect(parseEventLogLine('Program data: AAAAAAAAAAA=')).toBeNull();
  });
  it('base64 helpers match the standard alphabet with padding', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 64]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
      expect(toBase64(b)).toBe(Buffer.from(b).toString('base64'));
      expect(fromBase64(toBase64(b))).toEqual(b);
    }
  });
});

describe('panel Ed25519 instruction data (§9.7)', () => {
  it('has the fixed 367-byte layout', () => {
    const M = new Uint8Array(145).fill(5);
    const s0 = new Uint8Array(64).fill(6);
    const s1 = new Uint8Array(64).fill(7);
    const d = ed25519PanelIxData(JUDGES[0].pk, s0, JUDGES[2].pk, s1, M);
    expect(d.length).toBe(367);
    const r = new BorshReader(d);
    expect([r.u8(), r.u8()]).toEqual([2, 0]);
    expect(Array.from({ length: 7 }, () => r.u16())).toEqual([62, 0xffff, 30, 0xffff, 222, 145, 0xffff]);
    expect(Array.from({ length: 7 }, () => r.u16())).toEqual([158, 0xffff, 126, 0xffff, 222, 145, 0xffff]);
    expect(new BorshReader(d.subarray(30, 62)).pubkey()).toBe(JUDGES[0].pk);
    expect(d.subarray(62, 126)).toEqual(s0);
    expect(new BorshReader(d.subarray(126, 158)).pubkey()).toBe(JUDGES[2].pk);
    expect(d.subarray(158, 222)).toEqual(s1);
    expect(d.subarray(222)).toEqual(M);
    expect(parseEd25519PanelIxData(d)).toEqual({ pk0: JUDGES[0].pk, sig0: s0, pk1: JUDGES[2].pk, sig1: s1, message: M });
    expect(() => ed25519PanelIxData(JUDGES[0].pk, s0, JUDGES[2].pk, s1, M.subarray(1))).toThrow();
    expect(ED25519_PROGRAM_ID).toBe('Ed25519SigVerify111111111111111111111111111');
  });
});

describe('PDAs (§9.1)', () => {
  it('derives off-curve addresses deterministically', () => {
    const a = findProgramAddress([ascii('profile'), new BorshWriter().pubkey(ALICE.pk).toBytes()], PROGRAM_ID);
    expect(a.bump).toBeGreaterThanOrEqual(0);
    expect(a.bump).toBeLessThanOrEqual(255);
    const b = betPda(ALICE.pk, 1n, PROGRAM_ID);
    expect(betPda(ALICE.pk, 1n, PROGRAM_ID)).toEqual(b);
    expect(betPda(ALICE.pk, 2n, PROGRAM_ID).address).not.toBe(b.address);
    // solana-program `test_create_program_address` vectors
    const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
    expect(createProgramAddress([new Uint8Array(), new Uint8Array([1])], loader)).toBe(
      'BwqrghZA2htAcqq8dzP1WDAhTXYTYWj7CHxF5j7TDBAe',
    );
    expect(createProgramAddress([ascii('Talking'), ascii('Squirrels')], loader)).toBe(
      '2fnQrngrQT4SeLcdToJAD96phoEjNL2man2kfRLCASVk',
    );
  });
});
