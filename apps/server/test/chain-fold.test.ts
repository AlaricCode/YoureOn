// The pure half of the projector (src/chain/fold.ts), no DB: the fold is order-independent and
// duplicate-proof, the diff is monotonic and a no-op on equal values, and the chain-wins state
// rule matches DATA-MODEL §8.1 / bets_guard.
import { describe, expect, it } from 'vitest';
import { ChainEvents, type ChainEventName } from '@youre-on/shared';
import { bets } from '@youre-on/db';
import {
  chainWins,
  diffProjection,
  foldChainEvents,
  impliedState,
  statusOf,
  type FoldEvent,
} from '../src/chain/fold';
import { betFacts, lifecycle, randomSig, type BetFacts } from './chain-fixtures';

type BetRow = typeof bets.$inferSelect;
let nextId = 1n;

function ev(name: ChainEventName, payload: Record<string, unknown>, signature = randomSig()) {
  const data = ChainEvents[name].parse({
    signature,
    slot: null,
    block_height: 1,
    outer_ix: 0,
    inner_ix: 0,
    block_time: null,
    observed_via: 'quicknode_stream',
    ...payload,
  });
  return { id: nextId++, name, signature, data } as FoldEvent;
}

/** A full lifecycle: lock (one tx), resolve, finalize + close (one tx). */
function happyPath(f: BetFacts, outcome: 'PartyA' | 'PartyB' | 'Refund' = 'PartyA') {
  const L = lifecycle(f);
  const lock = randomSig();
  const pay = randomSig();
  return [
    ev('BetCreated', L.created(), lock),
    ev('BetAccepted', L.accepted(), lock),
    ev('BetResolved', L.resolved(outcome)),
    ev('BetFinalized', L.finalized(outcome), pay),
    ev('BetClosed', L.closed('Settled'), pay),
  ];
}

/** The bets row the RPC path would hold for `f` before any Stream event. */
function rowFor(f: BetFacts, over: Partial<BetRow> = {}): BetRow {
  return {
    id: f.bet_id,
    state: 'LOCKED',
    end_reason: null,
    refusal_category: null,
    evidence_source: 'camera',
    onchain_status: 'none',
    onchain_pending: null,
    pending_sig: null,
    terms_hash: f.terms_hash,
    stake_a: BigInt(f.stake_a),
    stake_b: BigInt(f.stake_b),
    mint: f.mint,
    party_a_wallet: f.party_a,
    party_b_wallet: f.party_b,
    create_sig: null,
    accept_sig: null,
    resolve_sig: null,
    appeal_sig: null,
    payout_sig: null,
    close_sig: null,
    accept_deadline: null,
    bet_pda: null,
    vault: null,
    locked_at: null,
    resolve_deadline: null,
    resolved_at: null,
    appeal_deadline: null,
    evidence_hash: null,
    ruling_hash: null,
    appealed_at: null,
    appeal_resolve_deadline: null,
    appeal_ruling_hash: null,
    outcome: null,
    payout_a: null,
    payout_b: null,
    payout_via: null,
    settled_at: null,
    closed_at: null,
    ...over,
  } as BetRow;
}

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

describe('foldChainEvents', () => {
  it('maps every event to the status it proves (BetClosed proves nothing new)', () => {
    const f = betFacts();
    const L = lifecycle(f);
    expect(
      [
        ev('BetCreated', L.created()),
        ev('BetAccepted', L.accepted()),
        ev('BetResolved', L.resolved('PartyA')),
        ev('BetAppealed', L.appealed('PartyA')),
        ev('BetConceded', L.conceded('PartyA')),
        ev('AppealResolved', L.appealResolved('PartyB', 'PartyA')),
        ev('BetRefunded', L.refunded('Locked')),
        ev('BetClosed', L.closed('Settled')),
      ].map(statusOf),
    ).toEqual(['open', 'locked', 'resolved', 'appealed', 'settled', 'settled', 'refunded', 'none']);
  });

  it('projects the whole lifecycle; any arrival order (and duplicates) folds to the same result', () => {
    const f = betFacts();
    const events = happyPath(f, 'PartyB');
    const ordered = foldChainEvents(events);
    expect(ordered.status).toBe('settled');
    expect(ordered.columns).toMatchObject({
      create_sig: events[0]!.signature,
      accept_sig: events[0]!.signature,
      resolve_sig: events[2]!.signature,
      payout_sig: events[3]!.signature,
      close_sig: events[3]!.signature,
      outcome: 'party_b',
      payout_a: 0n,
      payout_b: 10_000_000n,
      payout_via: 'finalize',
      bet_pda: f.bet,
      vault: f.vault,
      accept_deadline: new Date((f.t0 + 300) * 1000),
      appeal_deadline: new Date((f.t0 + 70) * 1000),
    });
    expect(ordered.terminal).toMatchObject({ name: 'BetFinalized', status: 'settled' });
    for (let seed = 1; seed <= 25; seed++) {
      const mixed = shuffle([...events, ...events.slice(0, 3)], seed);
      // the fold reads events in the order given; the projector hands them in chain order, but
      // the RESULT must not depend on it
      const r = foldChainEvents(mixed);
      expect(r.status).toBe(ordered.status);
      expect(r.columns).toEqual(ordered.columns);
      expect(r.binding).toEqual(ordered.binding);
    }
  });

  it('outcome is the terminal event’s, else BetResolved’s', () => {
    const f = betFacts();
    const L = lifecycle(f);
    expect(foldChainEvents([ev('BetResolved', L.resolved('PartyA'))]).columns.outcome).toBe(
      'party_a',
    );
    const appealed = foldChainEvents([
      ev('BetResolved', L.resolved('PartyA')),
      ev('AppealResolved', L.appealResolved('PartyB', 'PartyA')),
    ]);
    expect(appealed.columns).toMatchObject({
      outcome: 'party_b',
      payout_via: 'resolve_appeal',
      appeal_ruling_hash: 'ef'.repeat(32),
    });
  });
});

describe('diffProjection', () => {
  it('is empty when the row already holds the chain values (the RPC path wrote them)', () => {
    const f = betFacts();
    const fold = foldChainEvents(happyPath(f).slice(0, 2));
    const row = rowFor(f, { onchain_status: 'locked', ...fold.columns });
    const d = diffProjection(row, fold);
    expect(d.patch).toEqual({});
    expect(d.mismatches).toEqual([]);
    expect(d.advanced).toBe(false);
  });

  it('never regresses onchain_status; clears pending only once the chain reached it', () => {
    const f = betFacts();
    const L = lifecycle(f);
    const created = foldChainEvents([ev('BetCreated', L.created())]);
    // pending 'locked' (the RPC lock confirm) is not cleared by a lone BetCreated ('open')
    const p = diffProjection(
      rowFor(f, { onchain_pending: 'locked', pending_sig: randomSig() }),
      created,
    );
    expect(p.patch.onchain_status).toBe('open');
    expect(p.patch).not.toHaveProperty('onchain_pending');
    const lock = foldChainEvents(happyPath(f).slice(0, 2));
    const q = diffProjection(
      rowFor(f, { onchain_pending: 'locked', pending_sig: randomSig() }),
      lock,
    );
    expect(q.patch).toMatchObject({
      onchain_status: 'locked',
      onchain_pending: null,
      pending_sig: null,
    });
    // a row the chain already moved further keeps its status
    const r = diffProjection(rowFor(f, { onchain_status: 'resolved' }), lock);
    expect(r.patch).not.toHaveProperty('onchain_status');
    expect(r.status).toBe('resolved');
  });

  it('a terminal row keeps its status and money; disagreements are reported, not written', () => {
    const f = betFacts();
    const L = lifecycle(f);
    const paid = rowFor(f, {
      onchain_status: 'settled',
      outcome: 'party_a',
      payout_a: 10_000_000n,
      payout_b: 0n,
      payout_via: 'finalize',
      payout_sig: randomSig(),
    });
    const refund = foldChainEvents([ev('BetRefunded', L.refunded('Locked'))]);
    const d = diffProjection(paid, refund);
    expect(d.patch).not.toHaveProperty('onchain_status');
    expect(d.patch).not.toHaveProperty('payout_a');
    expect(d.patch).not.toHaveProperty('payout_sig');
    expect(d.mismatches.map((m) => m.field)).toEqual(
      expect.arrayContaining([
        'onchain_status',
        'payout_a',
        'payout_b',
        'payout_sig',
        'payout_via',
      ]),
    );
  });

  it('binding fields are checked, never written', () => {
    const f = betFacts();
    const L = lifecycle(f);
    const other = 'ff'.repeat(32);
    const fold = foldChainEvents([ev('BetCreated', { ...L.created(), terms_hash: other })]);
    const d = diffProjection(rowFor(f), fold);
    expect(d.patch).not.toHaveProperty('terms_hash');
    expect(d.mismatches).toEqual([
      { field: 'terms_hash', chain: other, db: f.terms_hash, event_id: expect.any(BigInt) },
    ]);
  });

  it('a hash the RPC path wrote differently is overwritten (chain wins) and reported', () => {
    const f = betFacts();
    const L = lifecycle(f);
    const fold = foldChainEvents([ev('BetResolved', L.resolved('PartyA'))]);
    const d = diffProjection(
      rowFor(f, { onchain_status: 'locked', ruling_hash: '00'.repeat(32) }),
      fold,
    );
    expect(d.patch.ruling_hash).toBe('ab'.repeat(32));
    expect(d.mismatches.map((m) => m.field)).toEqual(['ruling_hash']);
  });
});

describe('impliedState + chainWins (DATA-MODEL §8.1, bets_guard)', () => {
  it('maps onchain status (and the refund origin) to the offchain state', () => {
    const t = (
      outcome: 'refund' | 'party_a',
      from: 'open' | 'locked' | 'appealed' | null = null,
    ) => ({
      outcome,
      from_status: from,
    });
    expect(impliedState('none', null, 'camera')).toBeNull();
    expect(impliedState('open', null, 'camera')).toEqual({
      state: 'AWAITING_LOCK',
      end_reason: null,
    });
    expect(impliedState('locked', null, 'camera')?.state).toBe('LOCKED');
    expect(impliedState('resolved', null, 'camera')?.state).toBe('RULED');
    expect(impliedState('appealed', null, 'camera')?.state).toBe('APPEALED');
    expect(impliedState('settled', t('party_a'), 'camera')?.state).toBe('PAID');
    expect(impliedState('settled', t('refund'), 'camera')?.state).toBe('VOIDED');
    expect(impliedState('refunded', t('refund', 'locked'), 'camera')).toEqual({
      state: 'EXPIRED',
      end_reason: 'resolve_timeout',
    });
    expect(impliedState('refunded', t('refund', 'appealed'), 'camera')?.end_reason).toBe(
      'appeal_timeout',
    );
    expect(impliedState('refunded', t('refund', 'open'), 'camera')?.end_reason).toBe(
      'accept_timeout',
    );
    expect(impliedState('refunded', t('refund', 'open'), 'gemini')?.end_reason).toBe(
      'quote_expired',
    );
    expect(impliedState('cancelled', null, 'camera')).toEqual({
      state: 'CANCELLED',
      end_reason: 'cancelled',
    });
  });

  it('moves forward only; terminal states are final except CANCELLED/EXPIRED while locked..settled', () => {
    const row = (state: BetRow['state'], end_reason: BetRow['end_reason'] = null) => ({
      state,
      end_reason,
    });
    const locked = { state: 'LOCKED', end_reason: null } as const;
    const paid = { state: 'PAID', end_reason: null } as const;
    const ruled = { state: 'RULED', end_reason: null } as const;
    expect(chainWins(row('AWAITING_LOCK'), locked, 'locked')).toEqual(locked);
    expect(chainWins(row('LOCKED'), locked, 'locked')).toBeNull(); // same
    expect(chainWins(row('JUDGING'), locked, 'locked')).toBeNull(); // the offchain flow is ahead
    expect(chainWins(row('HEARING'), ruled, 'resolved')).toEqual(ruled);
    expect(chainWins(row('APPEALED'), ruled, 'resolved')).toBeNull();
    expect(chainWins(row('FINALIZED'), paid, 'settled')).toEqual(paid);
    expect(chainWins(row('CONCEDED'), paid, 'settled')).toEqual(paid);
    expect(chainWins(row('EXPIRED', 'accept_timeout'), locked, 'locked')).toEqual(locked);
    expect(chainWins(row('CANCELLED', 'lock_failed'), paid, 'settled')).toEqual(paid);
    // outside the bets_guard window: refunded / cancelled never revive a terminal row
    const expired = { state: 'EXPIRED', end_reason: 'resolve_timeout' } as const;
    expect(chainWins(row('CANCELLED', 'lock_failed'), expired, 'refunded')).toBeNull();
    expect(chainWins(row('PAID'), { state: 'VOIDED', end_reason: null }, 'settled')).toBeNull();
    expect(chainWins(row('PAID'), expired, 'refunded')).toBeNull();
    expect(chainWins(row('ATTEMPT'), expired, 'refunded')).toEqual(expired);
  });
});
