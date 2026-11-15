// Examples copied from SCHEMAS.md, used across tests. Vectors (hashed) live in ./vectors/*.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const loadVectorInput = <T = Record<string, unknown>>(name: string): T =>
  structuredClone(
    (
      JSON.parse(readFileSync(join(import.meta.dirname, 'vectors', `${name}.json`), 'utf8')) as {
        input: T;
      }
    ).input,
  );

export const skillTerms = () => loadVectorInput('terms-v1-001');
export const rulingExample = () => loadVectorInput('ruling-v1-001');
export const hearingRulingExample = () => loadVectorInput('hearing-ruling-v1-001');

/** §2.6 fields over the §2.5 base. */
export const realWorldTerms = () => ({
  ...skillTerms(),
  bet_id: '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73',
  type: 'real_world',
  claim: "Gemini's BTC 5-minute contract expiring 18:10 UTC resolves UP.",
  performer: null,
  yes_party: 'A',
  attempts: { count: 1, rule: 'single' },
  success_criteria: ['Gemini settles this contract YES.'],
  failure_criteria: ['Gemini settles this contract NO.'],
  edge_cases: [],
  evidence_source: 'gemini',
  market: {
    venue: 'gemini',
    eventTicker: 'BTC05M2611211810',
    instrumentSymbol: 'GEMI-BTC05M2611211810-UP',
    side: 'YES',
    priceAtLock: '0.62',
    priceSource: 'mid',
    quotedAt: '2026-11-21T18:06:30.000Z',
    strike: { value: '97250.03', type: 'reference', availableAt: '2026-11-21T18:05:00.000Z' },
    expiry: '2026-11-21T18:10:00.000Z',
  },
  stakes: { a: '6200000', b: '3800000', currency: 'USDC' },
  deadline: '2026-11-21T18:20:00.000Z',
  created_at: '2026-11-21T18:06:30.120Z',
});

/** §8.1 */
export const marketSnapshot = () => ({
  eventTicker: 'BTC05M2611211810',
  eventTitle: 'BTC price today at 1:10pm EST',
  instrumentSymbol: 'GEMI-BTC05M2611211810-UP',
  contractLabel: 'Up',
  status: 'active' as const,
  marketState: 'open' as const,
  strike: {
    value: '97250.03' as string | null,
    type: 'reference' as const,
    availableAt: '2026-11-21T18:05:00.000Z',
  },
  expiry: '2026-11-21T18:10:00.000Z',
  bestBid: '0.5800' as string | null,
  bestAsk: '0.6600' as string | null,
  lastTradePrice: '0.6100' as string | null,
  indexPrice: '97318.442',
  source: 'ws_book_ticker' as const,
  exchangeTs: '2026-11-21T18:06:29.812Z',
  observedAt: '2026-11-21T18:06:29.840Z',
});

/** §7 AppealVote example. */
export const appealVote = () => ({
  schema_version: 1,
  appeal_id: 'e9f8a7b6-c5d4-4e3f-a2b1-c0d9e8f7a6b5',
  bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
  seat: 1,
  provider: 'openai',
  model: 'openai/gpt-5',
  status: 'ok',
  outcome: 'A_WINS',
  confidence: 0.71,
  reason: 'The cap strike is the landing; it only rights itself after a bounce.',
  counted_as: 'A_WINS',
  latency_ms: 2400,
  created_at: '2026-11-21T18:07:41.000Z',
});

/** §10.1 example. */
export const betResolvedEvent = () => ({
  v: 1,
  type: 'chain.BetResolved',
  bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
  seq: 14,
  ts: '2026-11-21T18:07:05.230Z',
  source: 'chain',
  payload: {
    signature:
      '52i3cfdiJhBc6Wko6rxC2MUJBK2SoB7JBt6wLy8UEYUwyLPzxMvLr8PTvx1PjQJsCMjW3gCDWNaiymADMGhazeUk',
    slot: null,
    block_height: 400118207,
    outer_ix: 2,
    inner_ix: 0,
    block_time: 1795284425,
    observed_via: 'quicknode_stream',
    bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
    judge: 'B1Qtn1Zk68Sqx2rFDNdqGbMv5m5t4pCKU2P1MDjZ7NWi',
    outcome: 'PartyB',
    evidence_hash: '6d16c2ef16a63aba518b2e229f7d80e11663560fcd38112d38c5e26a66e14a06',
    ruling_hash: '997ce27843ff323b7f7f8816f9eff0d0044a485a43c5625512a8967f82755daa',
    appeal_deadline: 1795284435,
    ts: 1795284425,
  },
});
