// `?preview` on the stage URL: the pitch layout on sample frames (no server), for layout checks
// and projector rehearsal. Clearly labelled PREVIEW in the header; never used when connected.
import { hashJcs } from '@youre-on/shared/jcs';
import type { GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { applyFrame, initialTicker, type TickerState } from './ticker';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const PK_A = 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4';
const PK_B = 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr';
const PK_X = 'B1Qtn1Zk68Sqx2rFDNdqGbMv5m5t4pCKU2P1MDjZ7NWi';
const SIG = (c: string) => c.repeat(88);

/** `baseMs` fixes the story (the appeal window closes 20 s after it); `nowMs` keeps the quote fresh. */
export function previewState(baseMs: number, nowMs: number): TickerState {
  const t0 = baseMs - 60_000;
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
    type: 'skill',
    claim: 'Jake lands a water bottle flip upright on the table.',
    performer: 'B',
    yes_party: 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: ['The bottle comes to rest standing upright on its base.'],
    failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
    edge_cases: [],
    evidence_source: 'camera',
    market: null,
    stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
    deadline: new Date(Math.floor(t0 / 1000) * 1000 + 600_000).toISOString(),
    created_at: new Date(t0).toISOString(),
  };
  const envelope = {
    terms,
    terms_hash: hashJcs(terms),
    presentation: {
      title: 'Bottle flip',
      readback: 'Jake flips a bottle upright. Five dollars each.',
      stakes_display: '$5 each',
      odds_display: null,
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  };
  const meta = (s: string) => ({
    signature: s,
    slot: 400118200,
    block_height: null,
    outer_ix: 3,
    inner_ix: 0,
    block_time: Math.floor(t0 / 1000),
    observed_via: 'quicknode_stream',
  });
  let seq = 0;
  const ev = (type: string, payload: unknown) => ({
    v: 1,
    type,
    bet_id: BET,
    seq: ++seq,
    ts: new Date(t0 + seq * 1000).toISOString(),
    source: type.startsWith('chain.') ? 'chain' : 'server',
    payload,
  });
  const appealDeadline = Math.floor(baseMs / 1000) + 20;
  const frames: unknown[] = [
    ev('terms.proposed', { envelope }),
    ev('terms.authorized', {
      party: 'A',
      method: 'faceid_hold',
      authorized_at: new Date(t0 + 2000).toISOString(),
      count: 1,
    }),
    ev('terms.authorized', {
      party: 'B',
      method: 'faceid_hold',
      authorized_at: new Date(t0 + 3000).toISOString(),
      count: 2,
    }),
    ev('tx.submitted', { kind: 'atomic_lock', signature: SIG('5') }),
    ev('chain.BetCreated', {
      ...meta(SIG('5')),
      bet_id: BET,
      bet: PK_X,
      vault: PK_X,
      party_a: PK_A,
      party_b: PK_B,
      mint: terms.escrow.mint,
      stake_a: '5000000',
      stake_b: '5000000',
      terms_hash: envelope.terms_hash,
      judge_authority: PK_X,
      appeal_authority: PK_X,
      accept_deadline: Math.floor(t0 / 1000) + 300,
      rent_payer: PK_X,
      ts: Math.floor(t0 / 1000),
    }),
    ev('bet.state', {
      state: 'RULED',
      prev: 'JUDGING',
      onchain_status: 'Resolved',
      chain_ack: 'stream',
      pending_tx: null,
      reason: null,
    }),
    ev('chain.BetResolved', {
      ...meta(SIG('4')),
      bet_id: BET,
      judge: PK_X,
      outcome: 'PartyB',
      evidence_hash: '6d'.repeat(32),
      ruling_hash: 'ab'.repeat(32),
      appeal_deadline: appealDeadline,
      ts: Math.floor(baseMs / 1000) - 1,
    }),
  ];
  let s = initialTicker;
  for (const f of frames) s = applyFrame(s, { kind: 'frame', raw: f, receivedAt: nowMs });
  const bet = s.bets[BET]!;
  s = {
    ...s,
    status: 'open',
    presence: { room_id: BET, online: 3, members: 3 },
    bets: {
      ...s.bets,
      [BET]: {
        ...bet,
        ruling: {
          outcome: 'B_WINS',
          reason: 'Two full rotations, lands upright on its base in frame 7 and stays there.',
          confidence: 0.93,
          cited_frames: [7],
          model: 'anthropic/claude',
          stage: 'attempt',
          void_reason: null,
          ruling_hash: 'ab'.repeat(32),
        },
      },
    },
  };
  const start = Math.floor(nowMs / 300_000) * 300_000;
  const market: GeminiMarketSnapshot = {
    eventTicker: 'BTC05MPREVIEW',
    eventTitle: 'BTC 5-minute (preview)',
    instrumentSymbol: 'GEMI-BTC05MPREVIEW-UP',
    contractLabel: 'Up',
    status: 'active',
    marketState: 'open',
    strike: {
      value: '64389.6',
      type: 'reference',
      availableAt: new Date(start).toISOString(),
    },
    expiry: new Date(start + 300_000).toISOString(),
    bestBid: '0.54',
    bestAsk: '0.67',
    lastTradePrice: null,
    indexPrice: '64379.76',
    source: 'rest_event',
    exchangeTs: null,
    observedAt: new Date(nowMs).toISOString(),
  };
  for (let i = 0; i < 40; i++) {
    const price = (64380 + Math.sin(i / 4) * 18 + i * 0.6).toFixed(2);
    s = applyFrame(s, {
      kind: 'market',
      snapshot: { ...market, indexPrice: price },
      receivedAt: nowMs - (40 - i) * 2000,
    });
  }
  return s;
}
