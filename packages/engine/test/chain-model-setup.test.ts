import { describe, expect, it } from 'vitest';
import { FUND_WINDOW_S, MAX_STAKE_UNITS } from '../src/constants.js';
import { ZERO_HASH, ZERO_KEY } from '../src/chain/bytes.js';
import { BN254_R } from '../src/constants.js';
import { ALICE, ata, BET, BOB, CAROL, JUDGES, ORACLE, STRANGER, VAULT, World } from './chain-helpers.js';

describe('chain model: init_profile', () => {
  const face = '0'.repeat(63) + '5';
  it('creates and overwrites a profile', () => {
    const w = new World();
    const r = w.ok('init_profile', { face_commit: face, voice_commit: ZERO_HASH, display_name: 'Alice' }, [ALICE.pk], {
      wallet: ALICE.pk,
    });
    expect(r.profile).toMatchObject({ wallet: ALICE.pk, flags: 1, name_len: 5, created_at: w.now, updated_at: w.now });
    expect(r.events).toEqual([{ name: 'ProfileUpdated', data: { wallet: ALICE.pk, flags: 1 } }]);
    w.profile = r.profile!;
    w.now += 10n;
    const r2 = w.ok('init_profile', { face_commit: ZERO_HASH, voice_commit: ZERO_HASH, display_name: '' }, [ALICE.pk], {
      wallet: ALICE.pk,
    });
    expect(r2.profile).toMatchObject({ flags: 0, created_at: w.now - 10n, updated_at: w.now });
  });
  it('rejects commitments >= r, long names and missing signatures', () => {
    const w = new World();
    const r = BN254_R.toString(16).padStart(64, '0');
    const rMinus1 = (BN254_R - 1n).toString(16).padStart(64, '0');
    w.err('BadCommitment', 'init_profile', { face_commit: r, voice_commit: ZERO_HASH, display_name: '' }, [ALICE.pk], {
      wallet: ALICE.pk,
    });
    w.ok('init_profile', { face_commit: rMinus1, voice_commit: ZERO_HASH, display_name: 'x'.repeat(32) }, [ALICE.pk], {
      wallet: ALICE.pk,
    });
    w.err('BadReason', 'init_profile', { face_commit: face, voice_commit: ZERO_HASH, display_name: 'x'.repeat(33) }, [ALICE.pk], {
      wallet: ALICE.pk,
    });
    w.err('Unauthorized', 'init_profile', { face_commit: face, voice_commit: ZERO_HASH, display_name: '' }, [], {
      wallet: ALICE.pk,
    });
  });
});

describe('chain model: create_bet', () => {
  it('initialises the Bet and emits BetCreated', () => {
    const w = new World();
    const r = w.ok('create_bet', w.createArgs(), [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
    const b = r.bet;
    expect(b).toMatchObject({
      version: 1,
      bump: 254,
      vault_bump: 253,
      state: 0,
      creator: ALICE.pk,
      oracle: ORACLE.pk,
      n_participants: 2,
      side_b_mask: 2,
      stake_each: 1_000_000n,
      created_at: w.now,
      fund_deadline: w.now + BigInt(FUND_WINDOW_S),
      disputer: ZERO_KEY,
    });
    expect(b.participants.slice(2).every((k) => k === ZERO_KEY)).toBe(true);
    expect(b.witness_kinds).toEqual(Array(8).fill(0xff));
    expect(b.witness_heads).toEqual(Array(8).fill(0xffffffff));
    expect(b.leg_results).toEqual(Array(8).fill(0xff));
    expect(r.events[0]!.name).toBe('BetCreated');
    expect(r.events[0]!.data).toMatchObject({ bet: BET, nonce: 7n, fund_deadline: w.now + 900n });
  });

  const cases: [string, string, (w: World) => Parameters<World['createArgs']>[0], string[]?][] = [
    ['one participant', 'BadParticipants', () => ({ participants: [ALICE.pk], stakes: [1_000_000n] })],
    ['nine participants', 'BadParticipants', () => ({
      participants: Array.from({ length: 9 }, (_, i) => (i === 0 ? ALICE.pk : `${'1'.repeat(31)}${'23456789A'[i]}`)),
      stakes: Array(9).fill(1_000_000n),
    })],
    ['duplicate participants', 'BadParticipants', () => ({ participants: [ALICE.pk, ALICE.pk] })],
    ['creator not first', 'BadParticipants', () => ({ participants: [BOB.pk, ALICE.pk] })],
    ['oracle is participant', 'BadParticipants', () => ({ participants: [ALICE.pk, ORACLE.pk] })],
    ['side bit0 set', 'BadSides', () => ({ side_b_mask: 3 })],
    ['side mask zero', 'BadSides', () => ({ side_b_mask: 0 })],
    ['side bit beyond P', 'BadSides', () => ({ side_b_mask: 4 })],
    ['stake below min', 'BadStake', () => ({ stakes: [9_999n, 9_999n], stake_each: 9_999n })],
    ['stake above max', 'BadStake', () => ({
      stakes: [BigInt(MAX_STAKE_UNITS) + 1n, BigInt(MAX_STAKE_UNITS) + 1n],
      stake_each: BigInt(MAX_STAKE_UNITS) + 1n,
    })],
    ['unequal rules stakes', 'BadStake', () => ({ stakes: [1_000_000n, 2_000_000n] })],
    ['stakes length mismatch', 'BadStake', () => ({ stakes: [1_000_000n] })],
    ['time limit 0', 'BadTimeLimit', () => ({ time_limit_s: 0 })],
    ['time limit 3601', 'BadTimeLimit', () => ({ time_limit_s: 3601 })],
    ['unknown flag bit', 'BadFlags', () => ({ flags: 8 })],
    ['ai+market', 'BadFlags', () => ({ flags: 6 })],
    ['ai+actor bound', 'BadFlags', () => ({ flags: 3 })],
    ['duplicate judges', 'BadJudges', () => ({ judges: [JUDGES[0].pk, JUDGES[0].pk, JUDGES[2].pk] })],
    ['judge is participant', 'BadJudges', () => ({ judges: [JUDGES[0].pk, BOB.pk, JUDGES[2].pk] })],
    ['judge is oracle', 'BadJudges', () => ({ judges: [JUDGES[0].pk, ORACLE.pk, JUDGES[2].pk] })],
    ['zero program hash', 'ProgramHashMismatch', () => ({ program_hash: ZERO_HASH })],
  ];
  for (const [label, code, over] of cases) {
    it(`rejects ${label} with ${code}`, () => {
      const w = new World();
      w.err(code, 'create_bet', w.createArgs(over(w)), [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
    });
  }

  it('accepts the boundary time limit 3600 and stake 10_000', () => {
    const w = new World();
    w.ok('create_bet', w.createArgs({ time_limit_s: 3600, stakes: [10_000n, 10_000n], stake_each: 10_000n }), [
      ALICE.pk,
      ORACLE.pk,
    ], { creator: ALICE.pk });
  });

  it('requires creator and oracle signatures', () => {
    const w = new World();
    w.err('Unauthorized', 'create_bet', w.createArgs(), [ALICE.pk], { creator: ALICE.pk });
    w.err('Unauthorized', 'create_bet', w.createArgs(), [ORACLE.pk], { creator: ALICE.pk });
  });

  it('cannot re-create an initialised bet', () => {
    const w = new World().create();
    w.err('InvalidState', 'create_bet', w.createArgs(), [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
  });

  it('market bets: unequal stakes, stake_each 0, 30-day limit', () => {
    const w = new World({ flags: 4, stakes: [700_000n, 300_000n], timeLimit: 2_592_000 });
    w.ok('create_bet', w.createArgs(), [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
    const w2 = new World({ flags: 4, stakes: [700_000n, 300_000n], timeLimit: 2_592_001 });
    w2.err('BadTimeLimit', 'create_bet', w2.createArgs(), [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
    const w3 = new World({ flags: 4, stakes: [700_000n, 300_000n] });
    w3.err('BadStake', 'create_bet', w3.createArgs({ stake_each: 1n }), [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
    const w4 = new World({ flags: 4, stakes: [700_000n, 9_999n] });
    w4.err('BadStake', 'create_bet', w4.createArgs(), [ALICE.pk, ORACLE.pk], { creator: ALICE.pk });
  });
});

describe('chain model: fund', () => {
  it('funds each participant, sets calibration on first fund, then Funded', () => {
    const w = new World().create();
    const r = w.ok('fund', w.fundArgs(), [BOB.pk], { participant: BOB.pk, participant_token: ata(BOB.pk) });
    expect(r.transfers).toEqual([{ from: ata(BOB.pk), to: VAULT, amount: 1_000_000n }]);
    expect(r.bet.calibration_hash).toBe(w.calibrationHash);
    expect(r.bet.funded_mask).toBe(2);
    expect(r.bet.state).toBe(0);
    expect(r.events[0]!.data).toMatchObject({ participant_idx: 1, all_funded: false, funded_mask: 2 });
    w.err('AlreadyFunded', 'fund', w.fundArgs(), [BOB.pk], { participant: BOB.pk, participant_token: ata(BOB.pk) });
    const r2 = w.ok('fund', w.fundArgs(), [ALICE.pk], { participant: ALICE.pk, participant_token: ata(ALICE.pk) });
    expect(r2.bet.state).toBe(1);
    expect(r2.bet.funded_at).toBe(w.now);
    expect(r2.events[0]!.data).toMatchObject({ all_funded: true, funded_mask: 3 });
  });

  it('deadline boundary: now == fund_deadline ok, +1 DeadlinePassed', () => {
    const w = new World().create();
    w.now = w.bet.fund_deadline;
    w.fund(ALICE);
    w.now += 1n;
    w.err('DeadlinePassed', 'fund', w.fundArgs(), [BOB.pk], { participant: BOB.pk, participant_token: ata(BOB.pk) });
  });

  it('rejects mismatches', () => {
    const w = new World().create();
    const acc = { participant: BOB.pk, participant_token: ata(BOB.pk) };
    w.err('NotParticipant', 'fund', w.fundArgs(), [CAROL.pk], { participant: CAROL.pk, participant_token: ata(CAROL.pk) });
    w.err('Unauthorized', 'fund', w.fundArgs(), [ALICE.pk], acc);
    w.err('ConsentMismatch', 'fund', { ...w.fundArgs(), program_hash: 'ff'.repeat(32) }, [BOB.pk], acc);
    w.err('ConsentMismatch', 'fund', { ...w.fundArgs(), terms_hash: 'ff'.repeat(32) }, [BOB.pk], acc);
    w.err('BadTokenAccount', 'fund', w.fundArgs(), [BOB.pk], { participant: BOB.pk, participant_token: ata(ALICE.pk) });
    w.fund(BOB);
    w.err('CalibrationMismatch', 'fund', { ...w.fundArgs(), calibration_hash: 'ee'.repeat(32) }, [ALICE.pk], {
      participant: ALICE.pk,
      participant_token: ata(ALICE.pk),
    });
  });

  it('ai_judged / market require a zero calibration hash', () => {
    const w = new World({ flags: 2 }).create();
    w.err('CalibrationMismatch', 'fund', { ...w.fundArgs(), calibration_hash: 'ee'.repeat(32) }, [ALICE.pk], {
      participant: ALICE.pk,
      participant_token: ata(ALICE.pk),
    });
    w.fund(ALICE);
  });

  it('rejects funding outside Proposed', () => {
    const w = new World().create().fundAll();
    w.err('InvalidState', 'fund', w.fundArgs(), [BOB.pk], { participant: BOB.pk, participant_token: ata(BOB.pk) });
  });
});

describe('chain model: cancel', () => {
  it('refunds funded stakes (reason 7) and closes the vault', () => {
    const w = new World().create().fund(BOB);
    const r = w.ok('cancel', {}, [ALICE.pk], { creator: ALICE.pk });
    expect(r.bet.state).toBe(7);
    expect(r.bet.refund_reason).toBe(7);
    expect(r.bet.settle_path).toBe(4);
    expect(r.transfers).toEqual([{ from: VAULT, to: ata(BOB.pk), amount: 1_000_000n }]);
    expect(r.events.map((e) => e.name)).toEqual(['BetCancelled', 'Refunded']);
    expect(r.events[1]!.data).toMatchObject({ reason: 7, amounts: [0n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n] });
    expect(r.closed).toEqual([{ account: VAULT, rent_to: ORACLE.pk }]);
  });
  it('only the creator, only while Proposed, with valid payout accounts', () => {
    const w = new World().create();
    w.err('Unauthorized', 'cancel', {}, [BOB.pk], { creator: BOB.pk });
    w.err('Unauthorized', 'cancel', {}, [ALICE.pk], { creator: ALICE.pk, oracle: STRANGER.pk });
    w.err('BadTokenAccount', 'cancel', {}, [ALICE.pk], { creator: ALICE.pk }, [ata(ALICE.pk)]);
    w.err('BadTokenAccount', 'cancel', {}, [ALICE.pk], { creator: ALICE.pk }, [ata(BOB.pk), ata(ALICE.pk)]);
    w.fundAll();
    w.err('InvalidState', 'cancel', {}, [ALICE.pk], { creator: ALICE.pk });
  });
});
