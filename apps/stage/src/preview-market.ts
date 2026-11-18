// `?preview=gemini` on the stage URL: Beat 6 on sample frames (no server). A Gemini bet (Logan
// Up at 61/39) locked at `baseMs`, its contract expiring 75 s later, Gemini settling it DOWN 6 s
// after that, so a rehearsal sees the live clock, the wait and the result in under 1.5 minutes.
// Labelled PREVIEW in the header like `?preview`; never used when connected. The numbers are
// Gemini's real BTC05M2611180240 round (line 64389.6, settled 64367.38366666667).
// (`?preview=market` is preview.ts's frozen Beat 6 moment of the full loop, not this walk-through.)
import { hashJcs } from '@youre-on/shared/jcs';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { applyFrame, initialTicker, type TickerState } from './ticker';

/** The `?preview=` value that plays this sample (App.tsx). */
export const MARKET_PREVIEW = 'gemini';
/** The App rebuilds the sample once per slot: one relay tick (the fixture ticks every 2 s). */
export const MARKET_PREVIEW_SLOT_MS = 2000;

const BET = '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73';
const PK_A = 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4';
const PK_B = 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr';
const SIG = '5'.repeat(88);
const TICKER = 'BTC05MPREVIEW';

export function previewMarketState(baseMs: number, nowMs: number): TickerState {
  const expiryMs = Math.ceil((baseMs + 75_000) / 1000) * 1000;
  const expiry = new Date(expiryMs).toISOString();
  const start = new Date(expiryMs - 300_000).toISOString();
  const strike = { value: '64389.6', type: 'reference' as const, availableAt: start };
  const terms = {
    schema_version: 1,
    bet_id: BET,
    escrow: {
      cluster: 'devnet',
      program_id: 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    },
    party_a: { pubkey: PK_A, display_name: 'Logan' },
    party_b: { pubkey: PK_B, display_name: 'Jake' },
    type: 'real_world',
    claim: `Gemini's BTC 5-minute contract expiring ${expiry.slice(11, 16)} UTC resolves UP.`,
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
      eventTicker: TICKER,
      instrumentSymbol: `GEMI-${TICKER}-UP`,
      side: 'YES',
      priceAtLock: '0.61',
      priceSource: 'mid',
      quotedAt: new Date(baseMs - 20_000).toISOString(),
      strike,
      expiry,
    },
    stakes: { a: '6100000', b: '3900000', currency: 'USDC' },
    deadline: new Date(expiryMs + 600_000).toISOString(),
    created_at: new Date(baseMs - 20_000).toISOString(),
  };
  const terms_hash = hashJcs(terms);
  const envelope = {
    terms,
    terms_hash,
    presentation: {
      title: 'Bitcoin Up in 5 minutes',
      readback: `${terms.claim} Logan has Up, Jake has Down.`,
      stakes_display: '$6.10 vs $3.90',
      odds_display: '61/39',
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  };
  let seq = 0;
  const ev = (type: string, payload: unknown, at: number) => ({
    v: 1,
    type,
    bet_id: BET,
    seq: ++seq,
    ts: new Date(at).toISOString(),
    source: 'server',
    payload,
  });
  const state = (s: string) => ({
    state: s,
    prev: null,
    onchain_status: 'Locked',
    chain_ack: 'rpc',
    pending_tx: null,
    reason: null,
  });
  const snap = (at: number, price: string): GeminiMarketSnapshot => ({
    eventTicker: TICKER,
    eventTitle: 'BTC 5-minute (preview)',
    instrumentSymbol: `GEMI-${TICKER}-UP`,
    contractLabel: 'Up',
    status: 'active',
    marketState: 'open',
    strike,
    expiry,
    bestBid: '0.54',
    bestAsk: '0.67',
    lastTradePrice: null,
    indexPrice: price,
    source: 'rest_event',
    exchangeTs: null,
    observedAt: new Date(at).toISOString(),
  });
  /** Above the line early, ending where Gemini settled. */
  const priceAt = (t: number) => {
    const p = Math.min(1, Math.max(0, (t - (expiryMs - 300_000)) / 300_000));
    return (64_398.4 + (64_367.38 - 64_398.4) * p + 4 * Math.sin(t / 7_000) * (1 - p)).toFixed(2);
  };

  let s = initialTicker;
  const apply = (raw: unknown, at: number) =>
    (s = applyFrame(s, { kind: 'frame', raw, receivedAt: at }));
  apply(ev('terms.proposed', { envelope }, baseMs - 20_000), baseMs - 20_000);
  apply(ev('tx.submitted', { kind: 'atomic_lock', signature: SIG }, baseMs - 3_000), baseMs);
  apply(ev('bet.state', state('LOCKED'), baseMs), baseMs);
  apply(
    ev('tx.confirmed', { kind: 'atomic_lock', signature: SIG, slot: 400118200 }, baseMs),
    baseMs,
  );
  apply(ev('bet.state', state('AWAITING_MARKET'), baseMs), baseMs);
  const until = Math.min(nowMs, expiryMs);
  for (let t = baseMs - 80_000; t <= until; t += 2_000) {
    s = applyFrame(s, { kind: 'market', snapshot: snap(t, priceAt(t)), receivedAt: t });
    if (t >= baseMs) apply(ev('market.tick', { snapshot: snap(t, priceAt(t)) }, t), t);
  }
  const settledAt = expiryMs + 6_000;
  if (nowMs >= settledAt) {
    const record = {
      schema_version: 1,
      kind: 'gemini_settlement',
      bet_id: BET,
      terms_hash,
      contract: {
        eventTicker: TICKER,
        instrumentSymbol: `GEMI-${TICKER}-UP`,
        status: 'settled',
        resolutionSide: 'no',
        settlementValue: '64367.38366666667',
        strike,
        resolvedAt: new Date(expiryMs + 5_521).toISOString(),
      },
      source_url: `https://api.gemini.com/v1/prediction-markets/events/${TICKER}`,
      response_sha256: 'cd'.repeat(32),
      fetched_at: new Date(settledAt).toISOString(),
    };
    apply(ev('market.settled', { record, evidence_hash: hashJcs(record) }, settledAt), settledAt);
  }
  return { ...s, status: 'open', presence: { room_id: BET, online: 3, members: 3 } };
}
