import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import { ED25519_PROGRAM_ID, LIVE_GRACE_S, PANEL_TIMEOUT_S, PERCEPTION_TIMEOUT_S, START_WINDOW_S } from '../src/constants.js';
import { panelMessage } from '../src/booth/panel.js';
import { ed25519PanelIxData } from '../src/chain/ed25519.js';
import { disputeBond } from '../src/chain/model/resolve.js';
import {
  ALICE,
  ata,
  BET,
  BOB,
  CAROL,
  JUDGES,
  type Key,
  okResult,
  ORACLE,
  panelResult,
  PROGRAM_ID,
  STRANGER,
  TRACKS,
  VAULT,
  World,
} from './chain-helpers.js';

const consentArgs = (w: World) => ({ winner_mask: w.bet.winner_mask, evidence_root: w.bet.evidence_root });

describe('chain model: consent', () => {
  it('all participants consenting settles with path CONSENT', () => {
    const w = new World().toPreRuled(1);
    const r1 = w.ok('consent', consentArgs(w), [BOB.pk], { authority: BOB.pk });
    expect(r1.bet.consent_mask).toBe(2);
    expect(r1.bet.state).toBe(4);
    expect(r1.events).toEqual([{ name: 'Consented', data: { bet: BET, participant: BOB.pk, consent_mask: 2 } }]);
    expect(r1.transfers).toEqual([]);
    w.err('AlreadyConsented', 'consent', consentArgs(w), [BOB.pk], { authority: BOB.pk });
    const r2 = w.ok('consent', consentArgs(w), [ALICE.pk], { authority: ALICE.pk });
    expect(r2.bet).toMatchObject({ state: 6, settle_path: 1, final_winner_mask: 1, consent_mask: 3, settled_at: w.now });
    expect(r2.events.map((e) => e.name)).toEqual(['Consented', 'Settled']);
    expect(r2.events[1]!.data).toEqual({
      bet: BET,
      path: 1,
      winner_mask: 1,
      pot: 2_000_000n,
      payouts: [2_000_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
    });
    expect(r2.transfers).toEqual([{ from: VAULT, to: ata(ALICE.pk), amount: 2_000_000n }]);
    expect(r2.closed).toEqual([
      { account: TRACKS, rent_to: ORACLE.pk },
      { account: VAULT, rent_to: ORACLE.pk },
    ]);
    expect(r2.track_buffer).toBeNull();
  });

  it('silence = consent after the deadline (any signer); not before', () => {
    const w = new World().toPreRuled(2);
    w.err('DeadlineNotReached', 'consent', consentArgs(w), [STRANGER.pk], { authority: STRANGER.pk });
    w.now = w.bet.consent_deadline;
    w.err('DeadlineNotReached', 'consent', consentArgs(w), [ORACLE.pk], { authority: ORACLE.pk });
    w.now += 1n;
    const r = w.ok('consent', consentArgs(w), [STRANGER.pk], { authority: STRANGER.pk });
    expect(r.events.map((e) => e.name)).toEqual(['Settled']);
    expect(r.transfers).toEqual([{ from: VAULT, to: ata(BOB.pk), amount: 2_000_000n }]);
  });

  it('argument and account checks', () => {
    const w = new World().toPreRuled(1);
    w.err('ConsentMismatch', 'consent', { ...consentArgs(w), winner_mask: 2 }, [BOB.pk], { authority: BOB.pk });
    w.err('ConsentMismatch', 'consent', { ...consentArgs(w), evidence_root: 'ab'.repeat(32) }, [BOB.pk], { authority: BOB.pk });
    w.err('Unauthorized', 'consent', consentArgs(w), [], { authority: BOB.pk });
    w.now = w.bet.consent_deadline + 1n;
    w.err('BadTokenAccount', 'consent', consentArgs(w), [BOB.pk], { authority: BOB.pk }, [ata(BOB.pk), ata(ALICE.pk)]);
    w.err('Unauthorized', 'consent', consentArgs(w), [BOB.pk], { authority: BOB.pk, oracle: STRANGER.pk });
  });

  it('dust in the vault goes to the lowest-index winner', () => {
    const w = new World({ participants: [ALICE, BOB, CAROL], sideB: 0b100 }).toPreRuled(0b011);
    w.vaultExtra = 7n;
    w.now = w.bet.consent_deadline + 1n;
    const r = w.ok('consent', consentArgs(w), [ORACLE.pk], { authority: ORACLE.pk });
    expect(r.events[0]!.data).toMatchObject({ pot: 3_000_000n, payouts: [1_500_007n, 1_500_000n, 0n, 0n, 0n, 0n, 0n, 0n] });
  });

  it('an underfunded vault cannot settle', () => {
    const w = new World().toPreRuled(1);
    w.vaultExtra = -1n;
    w.now = w.bet.consent_deadline + 1n;
    w.err('MathOverflow', 'consent', consentArgs(w), [ORACLE.pk], { authority: ORACLE.pk });
  });
});

function disputeArgs(w: World, reason = 1) {
  return { reason, evidence_root: w.bet.evidence_root };
}

describe('chain model: dispute', () => {
  it('moves the bond into the vault and enters Disputed', () => {
    const w = new World().toPreRuled(1);
    const r = w.ok('dispute', disputeArgs(w), [BOB.pk], { disputer: BOB.pk, disputer_token: ata(BOB.pk) });
    expect(r.bet).toMatchObject({ state: 5, disputer: BOB.pk, dispute_bond: 200_000n, dispute_reason: 1, disputed_at: w.now });
    expect(r.transfers).toEqual([{ from: ata(BOB.pk), to: VAULT, amount: 200_000n }]);
    expect(r.events).toEqual([{ name: 'Disputed', data: { bet: BET, disputer: BOB.pk, reason: 1, bond: 200_000n } }]);
  });

  it('bond = max(min stake / 5, 100_000)', () => {
    expect(disputeBond({ n_participants: 2, stakes: [10_000n, 10_000n] })).toBe(100_000n);
    expect(disputeBond({ n_participants: 2, stakes: [500_000n, 499_999n] })).toBe(100_000n);
    expect(disputeBond({ n_participants: 2, stakes: [500_005n, 9_000_000n] })).toBe(100_001n);
    expect(disputeBond({ n_participants: 3, stakes: [3_000_000n, 1_000_000n, 2_000_000n, 1n] })).toBe(200_000n);
  });

  it('checks reason, deadline, participant, consent and token owner', () => {
    const w = new World().toPreRuled(1);
    const acc = { disputer: BOB.pk, disputer_token: ata(BOB.pk) };
    w.err('BadReason', 'dispute', disputeArgs(w, 0), [BOB.pk], acc);
    w.err('BadReason', 'dispute', disputeArgs(w, 5), [BOB.pk], acc);
    w.err('BadReason', 'dispute', disputeArgs(w, 10), [BOB.pk], acc);
    w.err('NotParticipant', 'dispute', disputeArgs(w), [STRANGER.pk], { disputer: STRANGER.pk, disputer_token: ata(STRANGER.pk) });
    w.err('BadTokenAccount', 'dispute', disputeArgs(w), [BOB.pk], { disputer: BOB.pk, disputer_token: ata(ALICE.pk) });
    w.err('ConsentMismatch', 'dispute', { reason: 1, evidence_root: '00'.repeat(32) }, [BOB.pk], acc);
    w.ok('consent', consentArgs(w), [ALICE.pk], { authority: ALICE.pk });
    w.err('AlreadyConsented', 'dispute', disputeArgs(w), [ALICE.pk], { disputer: ALICE.pk, disputer_token: ata(ALICE.pk) });
    w.now = w.bet.consent_deadline;
    w.ok('dispute', disputeArgs(w, 4), [BOB.pk], acc);
    const w2 = new World().toPreRuled(1);
    w2.now = w2.bet.consent_deadline + 1n;
    w2.err('DeadlinePassed', 'dispute', disputeArgs(w2), [BOB.pk], acc);
    // dispute.rs order: DeadlinePassed precedes BadReason / ConsentMismatch / NotParticipant.
    w2.err('DeadlinePassed', 'dispute', disputeArgs(w2, 0), [BOB.pk], acc);
    w2.err('DeadlinePassed', 'dispute', { reason: 0, evidence_root: '00'.repeat(32) }, [BOB.pk], acc);
    w2.err('DeadlinePassed', 'dispute', disputeArgs(w2, 0), [STRANGER.pk], {
      disputer: STRANGER.pk,
      disputer_token: ata(STRANGER.pk),
    });
    // Before the deadline: BadReason precedes ConsentMismatch and NotParticipant.
    const w3 = new World().toPreRuled(1);
    w3.err('BadReason', 'dispute', { reason: 0, evidence_root: '00'.repeat(32) }, [BOB.pk], acc);
    w3.err('BadReason', 'dispute', disputeArgs(w3, 0), [STRANGER.pk], { disputer: STRANGER.pk, disputer_token: ata(STRANGER.pk) });
    w3.err('ConsentMismatch', 'dispute', { reason: 1, evidence_root: '00'.repeat(32) }, [STRANGER.pk], {
      disputer: STRANGER.pk,
      disputer_token: ata(STRANGER.pk),
    });
  });
});

function signPanel(w: World, outcome: number, signers: Key[]): void {
  const M = panelMessage(PROGRAM_ID, BET, outcome, w.bet.evidence_root, w.bet.program_hash);
  const [a, b] = signers;
  w.prevInstruction = {
    program_id: ED25519_PROGRAM_ID,
    data: ed25519PanelIxData(a!.pk, ed25519.sign(M, a!.sk), b!.pk, ed25519.sign(M, b!.sk), M),
  };
}

function disputed(winner = 1): World {
  const w = new World().toPreRuled(winner);
  w.ok('dispute', disputeArgs(w), [BOB.pk], { disputer: BOB.pk, disputer_token: ata(BOB.pk) });
  return w;
}

describe('chain model: settle_panel', () => {
  it('bond upheld when the panel agrees with the pre-ruling', () => {
    const w = disputed(1);
    signPanel(w, 1, [JUDGES[0], JUDGES[2]]);
    const r = w.ok('settle_panel', { outcome: 1 }, []);
    expect(r.bet).toMatchObject({ state: 6, settle_path: 3, final_winner_mask: 1 });
    expect(r.events).toEqual([
      { name: 'Settled', data: { bet: BET, path: 3, winner_mask: 1, pot: 2_200_000n, payouts: [2_200_000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] } },
    ]);
  });

  it('bond returned when the panel overturns', () => {
    const w = disputed(1);
    signPanel(w, 2, [JUDGES[1], JUDGES[2]]);
    const r = w.ok('settle_panel', { outcome: 2 }, []);
    expect(r.events[0]!.data).toMatchObject({ winner_mask: 2, pot: 2_000_000n, payouts: [0n, 2_200_000n, 0n, 0n, 0n, 0n, 0n, 0n] });
    expect(r.transfers).toEqual([{ from: VAULT, to: ata(BOB.pk), amount: 2_200_000n }]);
  });

  it('no contest refunds everyone and the bond (reason 2)', () => {
    const w = disputed(1);
    signPanel(w, 0, [JUDGES[0], JUDGES[1]]);
    const r = w.ok('settle_panel', { outcome: 0 }, []);
    expect(r.bet).toMatchObject({ state: 7, refund_reason: 2 });
    expect(r.events).toEqual([
      { name: 'Refunded', data: { bet: BET, reason: 2, amounts: [1_000_000n, 1_200_000n, 0n, 0n, 0n, 0n, 0n, 0n] } },
    ]);
  });

  it('automatic NEEDS_PANEL disputes settle without a bond', () => {
    const w = new World().create().fundAll().start().end().postTracks();
    w.engine.result = panelResult(10);
    w.runRules();
    signPanel(w, 2, [JUDGES[0], JUDGES[1]]);
    const r = w.ok('settle_panel', { outcome: 2 }, []);
    expect(r.events[0]!.data).toMatchObject({ pot: 2_000_000n, payouts: [0n, 2_000_000n, 0n, 0n, 0n, 0n, 0n, 0n] });
  });

  it('rejects bad Ed25519 instructions and quorums', () => {
    const w = disputed(1);
    w.err('BadEd25519Instruction', 'settle_panel', { outcome: 1 }, []);
    signPanel(w, 1, [JUDGES[0], JUDGES[1]]);
    w.err('BadEd25519Instruction', 'settle_panel', { outcome: 2 }, []); // message for another outcome
    w.err('BadOutcome', 'settle_panel', { outcome: 3 as never }, []);
    const good = w.prevInstruction!;
    w.prevInstruction = { ...good, program_id: STRANGER.pk };
    w.err('BadEd25519Instruction', 'settle_panel', { outcome: 1 }, []);
    const bad = good.data.slice();
    bad[4] = 0; // signature_instruction_index ≠ 0xFFFF
    w.prevInstruction = { ...good, data: bad };
    w.err('BadEd25519Instruction', 'settle_panel', { outcome: 1 }, []);
    const forged = good.data.slice();
    forged[70] ^= 1; // corrupt sig0
    w.prevInstruction = { ...good, data: forged };
    w.err('BadEd25519Instruction', 'settle_panel', { outcome: 1 }, []);
    w.prevInstruction = { ...good, data: good.data.slice(0, 366) };
    w.err('BadEd25519Instruction', 'settle_panel', { outcome: 1 }, []);
    signPanel(w, 1, [JUDGES[0], JUDGES[0]]);
    w.err('InsufficientQuorum', 'settle_panel', { outcome: 1 }, []);
    signPanel(w, 1, [JUDGES[0], STRANGER]);
    w.err('InsufficientQuorum', 'settle_panel', { outcome: 1 }, []);
    signPanel(w, 1, [JUDGES[2], JUDGES[1]]);
    w.err('Unauthorized', 'settle_panel', { outcome: 1 }, [], { oracle: STRANGER.pk });
    w.ok('settle_panel', { outcome: 1 }, []);
  });

  it('only from Disputed', () => {
    const w = new World().toPreRuled(1);
    signPanel(w, 1, [JUDGES[0], JUDGES[1]]);
    w.err('InvalidState', 'settle_panel', { outcome: 1 }, []);
  });

  it('DeadlinePassed after disputed_at + PANEL_TIMEOUT_S; refund (6) applies instead', () => {
    const w = disputed(1);
    signPanel(w, 1, [JUDGES[0], JUDGES[1]]);
    w.now = w.bet.disputed_at + BigInt(PANEL_TIMEOUT_S) + 1n;
    w.err('DeadlinePassed', 'settle_panel', { outcome: 1 }, []);
    w.err('BadOutcome', 'settle_panel', { outcome: 3 as never }, []); // BadOutcome is checked first
    const r = w.ok('refund', {}, []);
    expect(r.bet).toMatchObject({ state: 7, refund_reason: 6 });
  });

  it('settles at exactly disputed_at + PANEL_TIMEOUT_S (inclusive)', () => {
    const w = disputed(1);
    signPanel(w, 2, [JUDGES[0], JUDGES[1]]);
    w.now = w.bet.disputed_at + BigInt(PANEL_TIMEOUT_S);
    w.err('NotRefundable', 'refund', {}, []);
    const r = w.ok('settle_panel', { outcome: 2 }, []);
    expect(r.bet).toMatchObject({ state: 6, settle_path: 3, final_winner_mask: 2 });
  });
});

describe('chain model: refund timeouts (boundaries)', () => {
  function expectBoundary(w: World, deadline: bigint, reason: number): void {
    w.now = deadline;
    w.err('NotRefundable', 'refund', {}, []);
    w.now = deadline + 1n;
    const r = w.ok('refund', {}, []);
    expect(r.bet).toMatchObject({ state: 7, refund_reason: reason, settle_path: 4 });
    expect(r.events.at(-1)!.name).toBe('Refunded');
  }
  it('Proposed after fund_deadline (1)', () => {
    const w = new World().create().fund(ALICE);
    expectBoundary(w, w.bet.fund_deadline, 1);
    expect(w.last && !('error' in w.last) && w.last.transfers).toEqual([{ from: VAULT, to: ata(ALICE.pk), amount: 1_000_000n }]);
  });
  it('Funded after funded_at + START_WINDOW_S (3)', () => {
    const w = new World().create().fundAll();
    expectBoundary(w, w.bet.funded_at + BigInt(START_WINDOW_S), 3);
  });
  it('Live after started_at + time_limit + LIVE_GRACE_S (4)', () => {
    const w = new World().create().fundAll().start();
    expectBoundary(w, w.bet.started_at + 60n + BigInt(LIVE_GRACE_S), 4);
  });
  it('Perceiving after ended_at + PERCEPTION_TIMEOUT_S (5)', () => {
    const w = new World().create().fundAll().start().end();
    expectBoundary(w, w.bet.ended_at + BigInt(PERCEPTION_TIMEOUT_S), 5);
  });
  it('Disputed after disputed_at + PANEL_TIMEOUT_S (6), bond returned', () => {
    const w = disputed(1);
    expectBoundary(w, w.bet.disputed_at + BigInt(PANEL_TIMEOUT_S), 6);
    expect(w.last && !('error' in w.last) && w.last.events.at(-1)!.data).toMatchObject({
      amounts: [1_000_000n, 1_200_000n, 0n, 0n, 0n, 0n, 0n, 0n],
    });
  });
  it('PreRuled stuck escape after consent_deadline + PANEL_TIMEOUT_S (8)', () => {
    const w = new World().toPreRuled(1);
    expectBoundary(w, w.bet.consent_deadline + BigInt(PANEL_TIMEOUT_S), 8);
  });
  it('terminal states are not refundable', () => {
    const w = new World().toPreRuled(1);
    w.now = w.bet.consent_deadline + 1n;
    w.ok('consent', consentArgs(w), [ORACLE.pk], { authority: ORACLE.pk });
    w.now += 100_000n;
    w.err('NotRefundable', 'refund', {}, []);
  });
});

describe('chain model: market flow', () => {
  it('create → fund → start → end → post market_bin → run_rules → consent', () => {
    const w = new World({ flags: 4, stakes: [700_000n, 300_000n], timeLimit: 86_400 });
    w.create().fundAll().start().end().postTracks();
    w.engine.result = okResult(2);
    w.runRules();
    w.now = w.bet.consent_deadline + 1n;
    const r = w.ok('consent', consentArgs(w), [ORACLE.pk], { authority: ORACLE.pk });
    expect(r.events[0]!.data).toMatchObject({ pot: 1_000_000n, payouts: [0n, 1_000_000n, 0n, 0n, 0n, 0n, 0n, 0n] });
  });
});

describe('chain model: atomicity', () => {
  it('a failing instruction leaves the input bet untouched', () => {
    const w = new World().create();
    const snapshot = structuredClone(w.bet);
    w.model.apply(
      w.bet,
      { name: 'fund', args: { ...w.fundArgs(), terms_hash: '00'.repeat(32) }, signers: [BOB.pk], accounts: { participant: BOB.pk, bet: BET, vault: VAULT, participant_token: ata(BOB.pk) } },
      w.ctx(),
    );
    w.model.apply(
      w.bet,
      { name: 'fund', args: w.fundArgs(), signers: [BOB.pk], accounts: { participant: BOB.pk, bet: BET, vault: VAULT, participant_token: ata(BOB.pk) } },
      w.ctx(),
    );
    expect(w.bet).toEqual(snapshot);
  });
});
