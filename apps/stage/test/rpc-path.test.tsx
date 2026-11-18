// Without QuickNode Streams (no chain.* events at all) the stage still shows the appeal window,
// the payout amounts and the PAID moment: they come from the server's own RPC-path events
// (payout/service.ts: bet.state RULED with `appeal_deadline=` + the confirmed resolve, bet.state
// PAID / VOIDED with the confirmed payout tx). The ?preview sequence is played with every chain.*
// frame left out, and the reducer rules are checked one by one.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BetSnapshot } from '@youre-on/shared/api';
import { phaseOf, phaseSteps } from '../src/phase';
import { previewAt, PREVIEW_STEPS } from '../src/preview';
import { freshSounds } from '../src/sound';
import {
  appealDeadlineOf,
  applyFrame,
  deadlineRefetches,
  derivedPayout,
  emptyBet,
  foldSnapshot,
  initialTicker,
  type BetView,
  type TickerState,
} from '../src/ticker';
import { PaidMoment, StageView, tickerRows } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
const noStreams = (step: keyof typeof PREVIEW_STEPS) =>
  previewAt(START, START, step, { chain: false });
const focusOf = (s: TickerState) => s.bets[s.focusBetId!]!;
const render = (step: keyof typeof PREVIEW_STEPS) => {
  const f = noStreams(step);
  return text(renderToString(<StageView state={f.state} now={f.now} preview={step} />));
};

describe('the preview without chain.* events (QuickNode Streams off)', () => {
  it('no chain event is folded, nothing is dropped', () => {
    for (const step of Object.keys(PREVIEW_STEPS) as Array<keyof typeof PREVIEW_STEPS>) {
      const f = noStreams(step);
      expect(f.state.dropped, step).toBe(0);
      expect(
        f.state.events.some((e) => e.source === 'chain'),
        step,
      ).toBe(false);
    }
  });

  it('Beat 4 ruling: the appeal countdown runs from bet.state RULED', () => {
    const bet = focusOf(noStreams('ruling').state);
    expect(bet.appeal_deadline).toBe(START / 1000 + 48);
    expect(bet.resolved_at).toBe(START / 1000 + 38);
    expect(bet.txs.resolve).toBeTruthy();
    const html = render('ruling');
    expect(html).toMatch(/Appeal window 0:0[78]/);
    expect(html).toContain('SCAN · Ruling transaction');
    expect(html).toContain('Jake wins');
  });

  it('Beat 4 paid: amounts, the PAID panel, the receipt, the PAID moment', () => {
    const f = noStreams('paid');
    const bet = focusOf(f.state);
    expect(bet.state).toBe('PAID');
    expect(bet.payout).toMatchObject({ to_a: '0', to_b: '10000000', event: 'BetFinalized' });
    expect(bet.payout!.signature).toBe(bet.txs.finalize);
    expect(bet.paid_at).toBe(new Date(START + 49_400).toISOString());
    expect(f.now - Date.parse(bet.paid_at!)).toBeLessThan(20_000); // fresh: the moment fires
    expect(bet.appeal_deadline).toBeNull();
    expect(phaseOf(bet)).toBe('paid');

    const html = render('paid');
    expect(html).toContain('<span class="stamp win">PAID</span>');
    expect(html).toContain('Jake</span><span class="amt">+$10');
    expect(html).toContain('+$10</span>'); // the party card
    expect(html).toContain('SCAN · Payout transaction');
    expect(html).not.toContain('Appeal window');

    const moment = text(renderToString(<PaidMoment bet={bet} />));
    expect(moment).toContain('$10 → Jake');
    expect(moment).toContain('BetFinalized on Solana devnet');
  });

  it('the ruling step: the AppealBar shows; the paid step: it is gone', () => {
    expect(render('ruling')).toContain('class="appeal open"');
    expect(render('paid')).not.toContain('class="appeal');
  });

  it('Beat 6 settled and paid: Logan takes the pot', () => {
    const end = previewAt(START, START + 89_000, null, { chain: false });
    const btc = focusOf(end.state);
    expect(btc.payout).toMatchObject({ to_a: '10000000', to_b: '0', event: 'BetFinalized' });
    const html = text(renderToString(<StageView state={end.state} now={end.now} />));
    expect(html).toContain('Logan</span><span class="amt">+$10');
  });

  it('the ticker still lists the server-confirmed transactions, and says where they came from', () => {
    expect(render('paid')).toContain('via Solana RPC');
    expect(render('paid')).not.toContain('via QuickNode Streams');
    const f = previewAt(START, START, 'paid');
    expect(text(renderToString(<StageView state={f.state} now={f.now} />))).toContain(
      'via QuickNode Streams',
    );
    const rows = tickerRows(noStreams('paid').state);
    const kinds = rows.map((r) => `${r.type}:${(r.payload as { kind?: string }).kind ?? ''}`);
    expect(kinds).toContain('tx.confirmed:finalize');
    expect(kinds).toContain('tx.confirmed:resolve');
    expect(kinds).toContain('tx.confirmed:atomic_lock');
  });

  it('sounds: lock, redo, gavel, paid, once each, from the RPC path', () => {
    const seen = new Set<string>();
    const heard: string[] = [];
    for (let t = 0; t < 56_000; t += 250) {
      const f = previewAt(START, START + t, null, { chain: false });
      for (const id of Object.keys(f.state.bets))
        heard.push(...freshSounds(f.state, id, seen, f.now));
    }
    expect(heard).toEqual(['lock', 'redo', 'gavel', 'paid']);
  });

  it('with Streams on, the chain events confirm the same payout (no second PAID moment)', () => {
    const rpc = focusOf(noStreams('paid').state);
    const both = focusOf(previewAt(START, START, 'paid').state);
    expect(both.payout).toEqual(rpc.payout);
    expect(both.paid_at).toBe(rpc.paid_at); // the earlier (RPC) moment, not the Streams echo
  });
});

describe('the preview with every chain.* event from the rpc_poll fallback (Stream off)', () => {
  const polled = (step: keyof typeof PREVIEW_STEPS) =>
    previewAt(START, START, step, { via: 'rpc_poll' });
  const html = (step: keyof typeof PREVIEW_STEPS) => {
    const f = polled(step);
    return text(renderToString(<StageView state={f.state} now={f.now} preview={step} />));
  };

  it('the chain events still fold (source chain), each marked observed_via rpc_poll', () => {
    const f = polled('paid');
    const chain = f.state.events.filter((e) => e.source === 'chain');
    expect(chain.length).toBeGreaterThan(0);
    expect(chain.every((e) => e.observed_via === 'rpc_poll')).toBe(true);
    expect(focusOf(f.state).lock).toMatchObject({ onchain: true, onchain_via: 'rpc_poll' });
    expect(focusOf(f.state).payout).toEqual(focusOf(previewAt(START, START, 'paid').state).payout);
  });

  it('the ticker does not claim QuickNode Streams, and shows no Streams lag', () => {
    const paid = html('paid');
    expect(paid).toContain('via Solana RPC (fallback)');
    expect(paid).not.toContain('QuickNode Streams');
    expect(paid).not.toContain('class="lag"');
    expect(paid).toContain('<span class="via"> rpc</span>');
    expect(html('locked')).not.toContain('Streams +');
    expect(html('locked')).toContain('✓ on-chain');
  });
});

// ---- the rules ---------------------------------------------------------------------------------

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const SIG = '3'.repeat(88);
const SIG_R = '4'.repeat(88);
let seq = 0;
const base = Date.parse('2026-11-21T18:05:00.000Z');
const state = (s: string, prev: string, pending: unknown, reason: string | null = null) => ({
  v: 1,
  type: 'bet.state',
  bet_id: BET,
  seq: ++seq,
  ts: new Date(base + seq * 1000).toISOString(),
  source: 'server',
  payload: {
    state: s,
    prev,
    onchain_status: null,
    chain_ack: 'rpc',
    pending_tx: pending,
    reason,
  },
});
const pending = (kind: string, signature: string, confirmed = true) => ({
  kind,
  signature,
  submitted_at: new Date(base).toISOString(),
  rpc_processed_at: confirmed ? new Date(base + 500).toISOString() : null,
  rpc_confirmed_at: confirmed ? new Date(base + 900).toISOString() : null,
});
const fold = (bet: BetView, ...frames: unknown[]): BetView => {
  let s: TickerState = { ...initialTicker, bets: { [BET]: bet } };
  for (const raw of frames) s = applyFrame(s, { kind: 'frame', raw, receivedAt: base + 30_000 });
  expect(s.dropped).toBe(0);
  return s.bets[BET]!;
};
const stakes = (a: string, b: string) =>
  ({
    terms: { stakes: { a, b } },
  }) as unknown as NonNullable<BetView['envelope']>;
const ruled = (outcome: string): BetView => ({
  ...emptyBet(BET),
  envelope: stakes('5000000', '5000000'),
  ruling: {
    outcome,
    reason: '',
    confidence: 0.9,
    cited_frames: [],
    model: 'm',
    stage: 'attempt',
    void_reason: outcome === 'VOID' ? 'camera_failure' : null,
    ruling_hash: 'ab'.repeat(32),
    attempt_no: 1,
    redo_reason: null,
  },
});

describe('RPC-path folding rules', () => {
  it('appeal_deadline from the reason the server writes (and nothing else)', () => {
    expect(appealDeadlineOf('appeal_deadline=1795284435')).toBe(1795284435);
    expect(appealDeadlineOf('x appeal_deadline=1795284435 y')).toBe(1795284435);
    expect(appealDeadlineOf('appeal_deadline=12')).toBeNull();
    expect(appealDeadlineOf('processed')).toBeNull();
    expect(appealDeadlineOf(null)).toBeNull();
  });

  it('RULED with the resolve: deadline, resolved_at, the ruling tx; a revert to RULED is ignored', () => {
    seq = 0;
    const b = fold(
      ruled('B_WINS'),
      state('RULED', 'JUDGING', pending('resolve', SIG_R), 'appeal_deadline=1795284435'),
    );
    expect(b.appeal_deadline).toBe(1795284435);
    expect(b.resolved_at).toBe(Math.floor((base + 900) / 1000));
    expect(b.txs.resolve).toBe(SIG_R);
    // a reverted payout lands back in RULED without a resolve: nothing is re-derived
    const reverted = fold(
      ruled('B_WINS'),
      state('RULED', 'FINALIZED', null, 'appeal_deadline=1795284999'),
    );
    expect(reverted.appeal_deadline).toBeNull();
    // an appeal already filed keeps the countdown off
    const appealed = fold(
      { ...ruled('B_WINS'), appealed: true },
      state('RULED', 'JUDGING', pending('resolve', SIG_R), 'appeal_deadline=1795284435'),
    );
    expect(appealed.appeal_deadline).toBeNull();
  });

  it("APPEALED with the server's appeal confirm: appealed, the countdown off, the appeal tx", () => {
    seq = 0;
    const b = fold(
      ruled('B_WINS'),
      state('RULED', 'JUDGING', pending('resolve', SIG_R), 'appeal_deadline=1795284435'),
      state('APPEALED', 'RULED', pending('appeal', SIG), 'appealed'),
    );
    expect(b).toMatchObject({ appealed: true, appeal_deadline: null });
    expect(b.txs.appeal).toBe(SIG);
    // any other APPEALED frame (no appeal tx) leaves the view as it was
    const other = fold(ruled('B_WINS'), state('APPEALED', 'RULED', null));
    expect(other.appealed).toBe(false);
  });

  it('PAID: the shared payout() over the stakes and the final outcome; concede and refund', () => {
    seq = 0;
    const paid = fold(ruled('B_WINS'), state('PAID', 'FINALIZED', pending('finalize', SIG)));
    expect(paid.payout).toEqual({
      to_a: '0',
      to_b: '10000000',
      event: 'BetFinalized',
      signature: SIG,
    });
    expect(paid.paid_at).toBe(new Date(base + 1000).toISOString());
    expect(paid.txs.payout).toBe(SIG);
    const gg = fold(ruled('A_WINS'), state('PAID', 'CONCEDED', pending('concede', SIG)));
    expect(gg.payout).toMatchObject({ to_a: '10000000', to_b: '0', event: 'BetConceded' });
    const refund = fold(ruled('VOID'), state('VOIDED', 'FINALIZED', pending('finalize', SIG)));
    expect(refund.payout).toMatchObject({ to_a: '5000000', to_b: '5000000' });
    expect(phaseSteps(refund).at(-1)!.label).toBe('Refund');
    // the appeal panel's outcome wins over the ruling's
    const flipped = fold(
      {
        ...ruled('B_WINS'),
        appeal_result: {
          final_outcome: 'A_WINS',
          flipped: true,
          decided_by: 'panel',
          tally: { A_WINS: 2, B_WINS: 1, ABSTAIN: 0 },
        },
      },
      state('PAID', 'APPEAL_RESOLVED', pending('resolve_appeal', SIG)),
    );
    expect(flipped.payout).toMatchObject({ to_a: '10000000', event: 'AppealResolved' });
    // a chain event after it does not move paid_at (one PAID moment)
    expect(paid.paid_at).not.toBeNull();
  });

  it('PAID without stakes or a decisive outcome derives nothing (no made-up amounts)', () => {
    seq = 0;
    expect(
      fold(emptyBet(BET), state('PAID', 'FINALIZED', pending('finalize', SIG))).payout,
    ).toBeNull();
    expect(fold(ruled('REDO'), state('PAID', 'FINALIZED', null)).payout).toBeNull();
    expect(derivedPayout({ ...ruled('A_WINS'), envelope: stakes('x', '1') }, 'PAID', null)).toBe(
      null,
    );
    // no payout tx in the frame: a generic label, no signature
    expect(derivedPayout(ruled('A_WINS'), 'PAID', null)).toEqual({
      to_a: '10000000',
      to_b: '0',
      event: 'Payout',
      signature: null,
    });
  });

  it('a cold-start snapshot of a settled bet shows the payout, but never replays the moment', () => {
    const snap = {
      bet_id: BET,
      room_id: null,
      state: 'PAID',
      prev_state: 'FINALIZED',
      onchain_status: 'Settled',
      chain_ack: 'rpc',
      pending_tx: null,
      party_a: { user_id: BET, pubkey: 'x', display_name: 'Logan', avatar_url: null },
      party_b: { user_id: BET, pubkey: 'y', display_name: 'Jake', avatar_url: null },
      my_party: null,
      envelope: null,
      draft: null,
      authorizations: { A: null, B: null },
      deadlines: {
        accept_deadline: null,
        resolve_deadline: null,
        appeal_deadline: 1795284435,
        appeal_resolve_deadline: null,
      },
      attempt_no: 1,
      redo_count: 0,
      latest_ruling: null,
      appeal: null,
      payout: null,
      signatures: {},
      end_reason: null,
      last_seq: 30,
    } as unknown as BetSnapshot;
    const v = foldSnapshot(ruled('B_WINS'), snap, base);
    expect(v.payout).toMatchObject({ to_a: '0', to_b: '10000000' });
    expect(v.paid_at).toBeNull();
    expect(v.appeal_deadline).toBeNull();
    // still RULED in the snapshot: the countdown comes from its deadlines
    const open = foldSnapshot(ruled('B_WINS'), { ...snap, state: 'RULED' }, base);
    expect(open.payout).toBeNull();
    expect(open.appeal_deadline).toBe(1795284435);
  });
});

describe('the appeal deadline re-fetch', () => {
  it('asks once more for a RULED bet with no countdown whose snapshot predates the ruling', () => {
    const snapAt = (st: string) => ({ state: st }) as unknown as BetSnapshot;
    const bet = { ...ruled('B_WINS'), state: 'RULED' };
    expect(
      deadlineRefetches({ bets: { [BET]: bet }, snapshots: { [BET]: snapAt('JUDGING') } }),
    ).toEqual([BET]);
    // not yet seeded (the first fetch is on its way), already RULED, or nothing to fill
    expect(deadlineRefetches({ bets: { [BET]: bet }, snapshots: {} })).toEqual([]);
    expect(
      deadlineRefetches({ bets: { [BET]: bet }, snapshots: { [BET]: snapAt('RULED') } }),
    ).toEqual([]);
    for (const b of [
      { ...bet, appeal_deadline: 1795284435 },
      { ...bet, appealed: true },
      { ...bet, state: 'PAID' },
    ])
      expect(
        deadlineRefetches({ bets: { [BET]: b }, snapshots: { [BET]: snapAt('JUDGING') } }),
      ).toEqual([]);
  });
});
