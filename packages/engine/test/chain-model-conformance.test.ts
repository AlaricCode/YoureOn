/**
 * Shared reject cases (testvectors/chain/rejects.json): the TS chain model must return the
 * same §9.6 error as the Anchor program (programs/verdict/tests/conformance.rs drives the
 * same table in LiteSVM). Errata chainmodel: unspecified §9.6 error choices + check order.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ED25519_PROGRAM_ID, PANEL_TIMEOUT_S, PERCEPTION_TIMEOUT_S } from '../src/constants.js';
import { ERROR_CODES } from '../src/constants.js';
import { panelMessage } from '../src/booth/panel.js';
import { ZERO_HASH } from '../src/chain/bytes.js';
import { ed25519PanelIxData } from '../src/chain/ed25519.js';
import type { ChainApplyResult, InstructionArgsMap, ModalityCode, ProfileAccount } from '../src/types.js';
import { ALICE, ata, BET, BOB, JUDGES, ORACLE, PROGRAM_ID, STRANGER, WITNESS, World } from './chain-helpers.js';

interface RejectCase {
  id: string;
  instruction: string;
  case: string;
  error: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const TABLE = JSON.parse(readFileSync(resolve(here, '../../../testvectors/chain/rejects.json'), 'utf8')) as { cases: RejectCase[] };

const perceiving = (): World => new World().create().fundAll().start().end();

function profileFor(wallet: string, at: bigint): ProfileAccount {
  return {
    wallet,
    face_commit: '00'.repeat(31) + '07',
    voice_commit: ZERO_HASH,
    display_name: '',
    name_len: 0,
    flags: 1,
    bump: 0,
    created_at: at,
    updated_at: at,
    reserved: ZERO_HASH,
  };
}

function bioArgs(over: Partial<InstructionArgsMap['verify_biometric_proof']> = {}): InstructionArgsMap['verify_biometric_proof'] {
  return {
    participant: 1,
    modality: 0,
    frame: 41,
    tau_bps: 5500,
    proof_a: new Uint8Array(64).fill(2),
    proof_b: new Uint8Array(128),
    proof_c: new Uint8Array(64),
    ...over,
  };
}

function postArgs(w: World, over: Partial<InstructionArgsMap['post_tracks']>): InstructionArgsMap['post_tracks'] {
  const p = w.payload();
  return {
    payload_len: p.length,
    program_len: w.programBin.length,
    calibration_len: w.calibrationBin.length,
    offset: 0,
    data: p,
    finalize: false,
    perception_root: ZERO_HASH,
    ...over,
  };
}

const fundAcc = (k = ALICE) => ({ participant: k.pk, participant_token: ata(k.pk) });
const disputeAcc = { disputer: BOB.pk, disputer_token: ata(BOB.pk) };

/** One driver per table id: sets up the state and applies the failing instruction. */
const DRIVERS: Record<string, () => ChainApplyResult> = {
  init_profile_name_33_bytes: () =>
    new World().apply('init_profile', { face_commit: '00'.repeat(31) + '05', voice_commit: ZERO_HASH, display_name: 'x'.repeat(33) }, [ALICE.pk], {
      wallet: ALICE.pk,
      payer: ALICE.pk,
    }),
  create_bet_zero_program_hash: () => {
    const w = new World();
    const a = w.createArgs({ program_hash: ZERO_HASH });
    return w.apply('create_bet', a, [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
  },
  create_bet_oracle_is_participant: () => {
    const w = new World();
    const a = w.createArgs({ participants: [ALICE.pk, ORACLE.pk] });
    return w.apply('create_bet', a, [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
  },
  create_bet_stakes_len_mismatch: () => {
    const w = new World();
    const a = w.createArgs({ stakes: [1_000_000n] });
    return w.apply('create_bet', a, [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
  },
  create_bet_bad_flags_and_sides: () => {
    const w = new World();
    const a = w.createArgs({ flags: 0b1000, side_b_mask: 0b001 });
    return w.apply('create_bet', a, [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
  },
  fund_wrong_program_hash: () => {
    const w = new World().create();
    return w.apply('fund', { ...w.fundArgs(), program_hash: 'ff'.repeat(32) }, [ALICE.pk], fundAcc());
  },
  fund_zero_calibration_rules: () => {
    const w = new World().create();
    return w.apply('fund', { ...w.fundArgs(), calibration_hash: ZERO_HASH }, [ALICE.pk], fundAcc());
  },
  start_duplicate_witness: () => {
    const w = new World().create().fundAll();
    const ws = [{ key: WITNESS[0].pk, kind: 0 as const }, { key: WITNESS[0].pk, kind: 1 as const }];
    return w.apply('start', { beacon_slot: w.slot - 1n, witnesses: ws }, [ORACLE.pk], { authority: ORACLE.pk });
  },
  start_witness_kind_3: () => {
    const w = new World().create().fundAll();
    const ws = [{ key: WITNESS[0].pk, kind: 3 as never }];
    return w.apply('start', { beacon_slot: w.slot - 1n, witnesses: ws }, [ORACLE.pk], { authority: ORACLE.pk });
  },
  start_future_beacon_slot: () => {
    const w = new World().create().fundAll();
    return w.apply('start', { beacon_slot: w.slot + 1n, witnesses: [] }, [ORACLE.pk], { authority: ORACLE.pk });
  },
  post_tracks_offset_not_written: () => {
    const w = perceiving();
    const p = w.payload();
    w.ok('post_tracks', postArgs(w, { data: p.subarray(0, 10) }), [ORACLE.pk]);
    return w.apply('post_tracks', postArgs(w, { offset: 5, data: p.subarray(5, 10) }), [ORACLE.pk]);
  },
  post_tracks_lengths_exceed_payload: () => {
    const w = perceiving();
    return w.apply('post_tracks', postArgs(w, { payload_len: 10, program_len: 8, calibration_len: 8, data: new Uint8Array() }), [ORACLE.pk]);
  },
  post_tracks_write_past_payload: () => {
    const w = perceiving();
    const p = w.payload();
    w.ok('post_tracks', postArgs(w, {}), [ORACLE.pk]);
    return w.apply('post_tracks', postArgs(w, { offset: p.length, data: new Uint8Array([1]) }), [ORACLE.pk]);
  },
  post_tracks_after_finalize: () => {
    const w = perceiving().postTracks();
    const p = w.payload();
    return w.apply('post_tracks', postArgs(w, { offset: p.length, data: new Uint8Array(), finalize: true }), [ORACLE.pk]);
  },
  run_rules_after_perception_timeout: () => {
    const w = perceiving().postTracks();
    w.now = w.bet.ended_at + BigInt(PERCEPTION_TIMEOUT_S) + 1n;
    return w.apply('run_rules', {}, [ORACLE.pk]);
  },
  consent_non_participant_before_deadline: () => {
    const w = new World().toPreRuled(1);
    return w.apply('consent', { winner_mask: w.bet.winner_mask, evidence_root: w.bet.evidence_root }, [STRANGER.pk], { authority: STRANGER.pk });
  },
  dispute_bad_reason: () => {
    const w = new World().toPreRuled(1);
    return w.apply('dispute', { reason: 0, evidence_root: w.bet.evidence_root }, [BOB.pk], disputeAcc);
  },
  dispute_bad_reason_after_deadline: () => {
    const w = new World().toPreRuled(1);
    w.now = w.bet.consent_deadline + 1n;
    return w.apply('dispute', { reason: 0, evidence_root: w.bet.evidence_root }, [BOB.pk], disputeAcc);
  },
  dispute_evidence_root_mismatch: () => {
    const w = new World().toPreRuled(1);
    return w.apply('dispute', { reason: 1, evidence_root: '00'.repeat(32) }, [BOB.pk], disputeAcc);
  },
  verify_biometric_modality_2: () => {
    const w = perceiving();
    w.profile = profileFor(BOB.pk, w.bet.created_at);
    return w.apply('verify_biometric_proof', bioArgs({ modality: 2 as ModalityCode }), [ORACLE.pk]);
  },
  verify_biometric_other_profile: () => {
    const w = perceiving();
    w.profile = profileFor(ALICE.pk, w.bet.created_at);
    return w.apply('verify_biometric_proof', bioArgs(), [ORACLE.pk]);
  },
  settle_panel_after_panel_timeout: () => {
    const w = new World().toPreRuled(1);
    w.ok('dispute', { reason: 2, evidence_root: w.bet.evidence_root }, [BOB.pk], disputeAcc);
    const M = panelMessage(PROGRAM_ID, BET, 2, w.bet.evidence_root, w.bet.program_hash);
    const [a, b] = [JUDGES[0], JUDGES[1]];
    w.prevInstruction = { program_id: ED25519_PROGRAM_ID, data: ed25519PanelIxData(a.pk, ed25519.sign(M, a.sk), b.pk, ed25519.sign(M, b.sk), M) };
    w.now = w.bet.disputed_at + BigInt(PANEL_TIMEOUT_S) + 1n;
    return w.apply('settle_panel', { outcome: 2 }, []);
  },
  refund_wrong_oracle_account: () => {
    const w = new World().create().fund(ALICE);
    w.now = w.bet.fund_deadline + 1n;
    return w.apply('refund', {}, [], { oracle: STRANGER.pk });
  },
};

describe('chain model ↔ program conformance (testvectors/chain/rejects.json)', () => {
  it('every table case has a driver and every driver a case', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(TABLE.cases.map((c) => c.id).sort());
    for (const c of TABLE.cases) expect(ERROR_CODES as readonly string[], c.id).toContain(c.error);
  });

  it.each(TABLE.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(DRIVERS[c.id]!()).toEqual({ error: c.error });
  });
});
