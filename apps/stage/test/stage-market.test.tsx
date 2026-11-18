// Beat 6 on the projector: a Gemini bet's card folds its own market.tick (the live price of ITS
// contract, which outlives the relay's rollover) and Gemini's settled record (market.settled),
// and renders who holds Up / Down, the line, BTC live, who is ahead, the countdown, then the
// settled (or voided) result with the evidence hash. Numbers are Gemini's real BTC05M2611180240
// settlement (line 64389.6, settled 64367.38366666667, "no").
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hashJcs } from '@youre-on/shared/jcs';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { BetCard, MarketPanel, StageView } from '../src/App';
import { applyFrame, initialTicker, type TickerAction, type TickerState } from '../src/ticker';

/** SSR markup without React's text-node separators. */
const html = (el: Parameters<typeof renderToString>[0]) =>
  renderToString(el).replace(/<!-- -->/g, '');

const BET = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
const terms = {
  schema_version: 1,
  bet_id: BET,
  escrow: {
    cluster: 'devnet',
    program_id: 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp',
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
  party_a: { pubkey: 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4', display_name: 'Logan' },
  party_b: { pubkey: 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr', display_name: 'Jake' },
  type: 'real_world',
  claim: "Gemini's BTC 5-minute contract expiring 02:40 UTC resolves UP.",
  performer: null,
  yes_party: 'A',
  attempts: { count: 1, rule: 'single' },
  success_criteria: ['Gemini settles this contract YES.'],
  failure_criteria: ['Gemini settles this contract NO.'],
  edge_cases: [
    {
      question: 'What if Gemini voids the contract?',
      answer: 'Then nobody wins and both stakes go back.',
      asked_by: 'judge',
    },
  ],
  evidence_source: 'gemini',
  market: {
    venue: 'gemini',
    eventTicker: 'BTC05M2611180240',
    instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
    side: 'YES',
    priceAtLock: '0.61',
    priceSource: 'mid',
    quotedAt: '2026-11-18T02:37:10.000Z',
    strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
    expiry: '2026-11-18T02:40:00.000Z',
  },
  stakes: { a: '6100000', b: '3900000', currency: 'USDC' },
  deadline: '2026-11-18T02:50:00.000Z',
  created_at: '2026-11-18T02:37:10.000Z',
};
const TERMS_HASH = hashJcs(terms);
const envelope = {
  terms,
  terms_hash: TERMS_HASH,
  presentation: {
    title: 'Bitcoin Up in 5 minutes',
    readback: 'x',
    stakes_display: '$6.10 vs $3.90',
    odds_display: '61/39',
    party_a_avatar_url: null,
    party_b_avatar_url: null,
  },
};
const snap = (over: Partial<GeminiMarketSnapshot> = {}): GeminiMarketSnapshot => ({
  eventTicker: 'BTC05M2611180240',
  eventTitle: 'BTC price today at 9:40pm EST',
  instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
  contractLabel: 'Up',
  status: 'active',
  marketState: 'open',
  strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
  expiry: '2026-11-18T02:40:00.000Z',
  bestBid: '0.54',
  bestAsk: '0.67',
  lastTradePrice: null,
  indexPrice: '64379.76',
  source: 'rest_event',
  exchangeTs: null,
  observedAt: '2026-11-18T02:37:12.000Z',
  ...over,
});
const record = (side: 'yes' | 'no' | null) => ({
  schema_version: 1,
  kind: 'gemini_settlement',
  bet_id: BET,
  terms_hash: TERMS_HASH,
  contract: {
    eventTicker: 'BTC05M2611180240',
    instrumentSymbol: 'GEMI-BTC05M2611180240-UP',
    status: side === null ? 'invalid' : 'settled',
    resolutionSide: side,
    settlementValue: side === null ? null : '64367.38366666667',
    strike: { value: '64389.6', type: 'reference', availableAt: '2026-11-18T02:35:00.000Z' },
    resolvedAt: '2026-11-18T02:40:05.521Z',
  },
  source_url: 'https://api.gemini.com/v1/prediction-markets/events/BTC05M2611180240',
  response_sha256: 'cd'.repeat(32),
  fetched_at: '2026-11-18T02:40:08.000Z',
});

let seq = 0;
const ev = (type: string, payload: unknown) => ({
  v: 1,
  type,
  bet_id: BET,
  seq: ++seq,
  ts: new Date(Date.parse('2026-11-18T02:37:00.000Z') + seq * 1000).toISOString(),
  source: 'server',
  payload,
});
const frame = (
  raw: unknown,
  receivedAt = Date.parse('2026-11-18T02:37:20.000Z'),
): TickerAction => ({
  kind: 'frame',
  raw,
  receivedAt,
});
const run = (frames: unknown[], s: TickerState = initialTicker) =>
  frames.reduce<TickerState>((acc, f) => applyFrame(acc, frame(f)), s);
const state = (s: string) => ({
  state: s,
  prev: null,
  onchain_status: 'Locked',
  chain_ack: 'rpc',
  pending_tx: null,
  reason: null,
});

describe('Beat 6 on the stage', () => {
  it('folds the bet, its own ticks (without stealing focus) and the settlement', () => {
    seq = 0;
    let s = run([ev('terms.proposed', { envelope }), ev('bet.state', state('AWAITING_MARKET'))]);
    expect(s.bets[BET]!.settlement).toBeNull();
    s = run([ev('market.tick', { snapshot: snap({ indexPrice: '64401.5' }) })], s);
    expect(s.betTicks[BET]?.indexPrice).toBe('64401.5');
    expect(s.bets[BET]!.state).toBe('AWAITING_MARKET'); // the card is untouched
    const rec = record('no');
    s = run([ev('market.settled', { record: rec, evidence_hash: hashJcs(rec) })], s);
    expect(s.bets[BET]!.settlement).toEqual({ record: rec, evidence_hash: hashJcs(rec) });
  });

  it('live: who holds Up / Down at what stake, the line, BTC, who is ahead, the countdown', () => {
    seq = 0;
    const s = run([ev('terms.proposed', { envelope }), ev('bet.state', state('AWAITING_MARKET'))]);
    const out = html(
      <MarketPanel
        bet={s.bets[BET]!}
        tick={snap({ indexPrice: '64401.5' })}
        now={Date.parse('2026-11-18T02:37:20.000Z')}
      />,
    );
    expect(out).toContain('BTC 5-MIN · GEMINI');
    expect(out).toContain('Up 61%');
    expect(out).toContain('Logan Up $6.10');
    expect(out).toContain('Jake Down $3.90');
    expect(out).toContain('$64,389.60'); // the line, latched at lock
    expect(out).toContain('$64,401.50'); // BTC live
    expect(out).toContain('2:40'); // settles in
    expect(out).toContain('Logan is ahead');
    // a tick of another contract (the relay rolled over) is not this bet's price
    const other = html(
      <MarketPanel
        bet={s.bets[BET]!}
        tick={snap({ eventTicker: 'BTC05M2611180245', indexPrice: '1' })}
        now={Date.parse('2026-11-18T02:37:20.000Z')}
      />,
    );
    expect(other).not.toContain('$1.00');
  });

  it('after expiry it waits for Gemini; then the settled result with the evidence hash', () => {
    seq = 0;
    let s = run([ev('terms.proposed', { envelope }), ev('bet.state', state('AWAITING_MARKET'))]);
    const after = Date.parse('2026-11-18T02:40:03.000Z');
    expect(html(<MarketPanel bet={s.bets[BET]!} tick={null} now={after} />)).toContain(
      'Waiting for Gemini to settle',
    );
    const rec = record('no');
    s = run([ev('market.settled', { record: rec, evidence_hash: hashJcs(rec) })], s);
    const out = html(<MarketPanel bet={s.bets[BET]!} tick={null} now={after} />);
    expect(out).toContain('Gemini settled DOWN');
    expect(out).toContain('Jake wins');
    expect(out).toContain('$64,367.38');
    expect(out).toContain(hashJcs(rec).slice(0, 8));
    expect(out).toContain(rec.source_url);
    expect(out).not.toContain('Waiting for Gemini');
  });

  it('a bet on the REPLAY feed is labelled REPLAY', () => {
    seq = 0;
    const replayTerms = {
      ...terms,
      market: {
        ...terms.market,
        eventTicker: 'REPLAY-BTC05M2611180240',
        instrumentSymbol: 'REPLAY-GEMI-BTC05M2611180240-UP',
      },
    };
    const env = { ...envelope, terms: replayTerms, terms_hash: hashJcs(replayTerms) };
    const s = run([ev('terms.proposed', { envelope: env })]);
    const out = html(
      <MarketPanel bet={s.bets[BET]!} tick={null} now={Date.parse('2026-11-18T02:37:20.000Z')} />,
    );
    expect(out).toContain('REPLAY · recorded Gemini round');
    // a live bet is not
    const live = run([ev('terms.proposed', { envelope })]);
    expect(
      html(
        <MarketPanel
          bet={live.bets[BET]!}
          tick={null}
          now={Date.parse('2026-11-18T02:37:20.000Z')}
        />,
      ),
    ).not.toContain('REPLAY');
  });

  it('a voided contract reads as a refund', () => {
    seq = 0;
    const rec = record(null);
    const s = run([
      ev('terms.proposed', { envelope }),
      ev('market.settled', { record: rec, evidence_hash: hashJcs(rec) }),
    ]);
    const out = html(
      <MarketPanel bet={s.bets[BET]!} tick={null} now={Date.parse('2026-11-18T02:40:10.000Z')} />,
    );
    expect(out).toContain('Gemini voided the contract');
  });

  it('the card and the whole stage include the panel for a Gemini bet only', () => {
    seq = 0;
    const s = run([ev('terms.proposed', { envelope }), ev('market.tick', { snapshot: snap() })]);
    const now = Date.parse('2026-11-18T02:37:20.000Z');
    expect(html(<BetCard bet={s.bets[BET]!} now={now} />)).toContain('market bet');
    const stage = html(<StageView state={s} now={now} />);
    expect(stage).toContain('BTC 5-MIN · GEMINI');
    expect(stage).toContain('$64,379.76'); // from the bet's own tick
    const skill = { ...s.bets[BET]!, envelope: { ...envelope, terms: { ...terms, market: null } } };
    expect(html(<BetCard bet={skill as never} now={now} />)).not.toContain('market bet');
  });
});
