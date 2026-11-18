// `?preview=odds` on the stage URL: agreeing the odds of a bottle flip, on sample frames (no
// server), for rehearsal and screenshots. Labelled PREVIEW in the header like `?preview`. Every
// frame goes through the real applyFrame() and parses with the shared schemas.
//
// Logan bets Jake can't land a bottle flip and asks for 3 to 1 (Logan $5, Jake $15). Jake asks
// the judge what's fair; the judge reads Jake's record (10 of 12 bottle flips, demo history:
// Jake 10–2 seeded with POST /v1/demo/seed-h2h) and suggests 2 to 1 (Jake $10, Logan $5). The
// numbers are the shared odds math's own (k = 4 shrinkage toward the 25 % bottle-flip base rate:
// p = 11/16 = 0.6875, fair 2.2 : 1, band 2:1 / 3:1). Logan taps Accept, then Jake: the odds are
// agreed, the card is recomposed with the new stakes, both confirm and it locks.
//
//   ?preview=odds            loops the whole walk (LOOP_MS)
//   ?preview=odds-<step>     freezes on one moment: offer, suggest, waiting, agreed, locked
import type { BetSnapshot } from '@youre-on/shared/api';
import { hashJcs } from '@youre-on/shared/jcs';
import { sha256Hex } from '@youre-on/shared/primitives';
import { applyFrame, initialTicker, type TickerAction, type TickerState } from './ticker';

/** The `?preview=` value that plays this sample (App.tsx); `odds-<step>` freezes it. */
export const ODDS_PREVIEW = 'odds';
export const isOddsPreview = (p: string | null): boolean =>
  p === ODDS_PREVIEW || (p !== null && p.startsWith(`${ODDS_PREVIEW}-`));

export const ODDS_LOOP_MS = 32_000;
export const ODDS_STEPS = {
  offer: 6_000,
  suggest: 10_000,
  waiting: 14_000,
  agreed: 18_000,
  locked: 28_000,
} as const;
export type OddsStep = keyof typeof ODDS_STEPS;

const ROOM = '2b7d9c41-5e3a-4f60-8a1b-9c0d1e2f3a4b';
const BET = '5d0dd5e2-7a41-4c1e-9b2f-3c4d5e6f7a8b';
const USER_A = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const USER_B = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
const PK_A = 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4';
const PK_B = 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr';
const PROGRAM = 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIG_LOCK =
  'ghAZAC5uAErtvd8Y6X4kBidWNUVn6XfN5L3ZD4ScggmfYMgcyhMk2TVVHEA7QFcou2p7phVNaYRz23sLfsBtdJDm';
const NAMES = { A: 'Logan', B: 'Jake' } as const;
const OFFER = {
  logan: '00000000-0000-4000-8000-0000000000a1',
  judge: '00000000-0000-4000-8000-0000000000a2',
};

const iso = (ms: number) => new Date(ms).toISOString();
const isoSec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** The card at `at` with these stakes (micro-USDC). */
function envelope(base: number, at: number, a: string, b: string, display: string, odds: string) {
  const terms = {
    schema_version: 1,
    bet_id: BET,
    escrow: { cluster: 'devnet', program_id: PROGRAM, mint: MINT },
    party_a: { pubkey: PK_A, display_name: NAMES.A },
    party_b: { pubkey: PK_B, display_name: NAMES.B },
    type: 'skill',
    claim: 'Jake lands a water bottle flip upright on the table.',
    performer: 'B',
    yes_party: 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: [
      'The bottle rotates at least once in the air.',
      'It comes to rest standing upright on its base.',
    ],
    failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
    edge_cases: [
      {
        question: 'Does landing on the cap count?',
        answer: 'No. Only upright on its base.',
        asked_by: 'judge',
      },
    ],
    evidence_source: 'camera',
    market: null,
    stakes: { a, b, currency: 'USDC' },
    deadline: isoSec(base + at + 600_000),
    created_at: iso(base + at),
  };
  return {
    terms,
    terms_hash: hashJcs(terms),
    presentation: {
      title: 'Bottle flip',
      readback: `Jake lands a bottle flip upright. ${display}.`,
      stakes_display: display,
      odds_display: odds,
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  };
}

/** The judge's suggestion, as the server's suggest-odds engine returns it (sample numbers). */
function suggestion() {
  return {
    ratio: '2:1',
    favored: 'B',
    stakes: { a: '5000000', b: '10000000' },
    chance_pct: 69,
    fair_ratio: 2.2,
    allowed: ['2:1', '3:1'],
    base_rate_pct: 25,
    sample_meaningful: true,
    stats: {
      performer: { party: 'B', display_name: NAMES.B },
      category: 'bottle_flip',
      category_label: 'Bottle flip',
      overall: { wins: 14, losses: 6, pushes: 0 },
      in_category: { made: 10, tries: 12 },
      as_performer: { made: 12, tries: 15 },
      recent: ['W', 'W', 'L', 'W', 'W'],
      streak: { kind: 'W', n: 2 },
      h2h: {
        wins: 7,
        losses: 4,
        pushes: 0,
        net: '15000000',
        net_display: '+$15',
        last_settled_at: '2026-11-17T21:04:00.000Z',
        includes_seed: true,
      },
      includes_seed: true,
    },
    reason: 'Jake has landed 10 of his last 12 bottle flips and is 7 and 4 against Logan.',
    source: 'model',
    model: 'claude-opus-5-5',
    cache_key: sha256Hex('preview:odds-suggestion'),
  };
}

function snapshot(): BetSnapshot {
  const ref = (p: 'A' | 'B') => ({
    user_id: p === 'A' ? USER_A : USER_B,
    pubkey: (p === 'A' ? PK_A : PK_B) as never,
    display_name: NAMES[p],
    avatar_url: null,
  });
  return {
    bet_id: BET,
    room_id: ROOM,
    state: 'DRAFTING',
    prev_state: null,
    onchain_status: null,
    chain_ack: 'none',
    pending_tx: null,
    party_a: ref('A'),
    party_b: ref('B'),
    my_party: null,
    envelope: null,
    draft: null,
    authorizations: { A: null, B: null },
    deadlines: {
      accept_deadline: null,
      resolve_deadline: null,
      appeal_deadline: null,
      appeal_resolve_deadline: null,
    },
    attempt_no: null,
    redo_count: 0,
    latest_ruling: null,
    appeal: null,
    payout: null,
    signatures: {},
    end_reason: null,
    last_seq: 0,
  };
}

interface Entry {
  at: number;
  action: (base: number) => TickerAction;
}

function sequence(): Entry[] {
  const out: Entry[] = [];
  let seq = 0;
  let line = 0;
  const frame = (at: number, type: string, payload: (base: number) => unknown) => {
    const n = ++seq;
    out.push({
      at,
      action: (base) => ({
        kind: 'frame',
        receivedAt: base + at,
        raw: {
          v: 1,
          type,
          bet_id: BET,
          seq: n,
          ts: iso(base + at),
          source: 'server',
          payload: payload(base),
        },
      }),
    });
  };
  const state = (at: number, s: string, prev: string | null, onchain: string | null = null) =>
    frame(at, 'bet.state', () => ({
      state: s,
      prev,
      onchain_status: onchain,
      chain_ack: onchain ? 'rpc' : 'none',
      pending_tx: null,
      reason: null,
    }));
  const judge = (at: number, text: string) =>
    frame(at, 'judge.line', () => ({ utterance_id: uuid(++line), text, final: true }));
  const said = (at: number, party: 'A' | 'B', text: string) =>
    frame(at, 'party.line', () => ({ party, utterance_id: uuid(++line), text, final: true }));
  const card1 = (b: number) => envelope(b, 4_000, '5000000', '15000000', '$5 vs $15', '3 to 1');
  const card2 = (b: number) => envelope(b, 16_000, '5000000', '10000000', '$5 vs $10', '2 to 1');

  out.push({ at: 0, action: (b) => ({ kind: 'snapshot', receivedAt: b, bet: snapshot() }) });
  state(0, 'DRAFTING', null);
  frame(500, 'bet.invite_answered', () => ({ party: 'B', answer: 'accepted' }));
  judge(1_000, "Alright, Logan. What's the bet?");
  said(2_500, 'A', "Jake can't land this bottle flip. Give me three to one.");
  frame(4_000, 'terms.proposed', (b) => ({ envelope: card1(b) }));
  state(4_000, 'TERMS_PROPOSED', 'DRAFTING');
  frame(4_000, 'odds.offered', (b) => ({
    offer: {
      offer_id: OFFER.logan,
      n: 1,
      parent_id: null,
      from: 'A',
      stakes: { a: '5000000', b: '15000000' },
      ratio_label: '3 to 1',
      favored: 'B',
      terms_hash: card1(b).terms_hash,
      suggestion: null,
      created_at: iso(b + 4_000),
    },
  }));
  judge(
    4_300,
    'Logan puts in five, Jake puts in fifteen; winner takes twenty. Jake, accept or counter.',
  );
  said(7_000, 'B', 'Judge, what odds are fair?');
  frame(8_500, 'odds.offered', (b) => ({
    offer: {
      offer_id: OFFER.judge,
      n: 2,
      parent_id: OFFER.logan,
      from: 'judge',
      stakes: { a: '5000000', b: '10000000' },
      ratio_label: '2 to 1',
      favored: 'B',
      terms_hash: card1(b).terms_hash,
      suggestion: suggestion(),
      created_at: iso(b + 8_500),
    },
  }));
  frame(8_500, 'odds.answered', () => ({
    offer_id: OFFER.logan,
    party: 'A',
    answer: 'countered',
    by_offer_id: OFFER.judge,
  }));
  frame(8_600, 'judge.cue', () => ({
    cue: 'ODDS_OFFERED',
    text: '[EVENT] ODDS_OFFERED name=Judge ratio="2 to 1" :: Say the suggestion and its reason; both tap Accept or Counter.',
    speak: false,
  }));
  judge(
    8_800,
    "Jake has landed 10 of his last 12 bottle flips. I'd make it 2 to 1: Jake puts in ten, Logan puts in five. Both agree?",
  );
  frame(13_000, 'odds.answered', () => ({
    offer_id: OFFER.judge,
    party: 'A',
    answer: 'accepted',
    by_offer_id: null,
  }));
  said(14_800, 'B', 'Fine. Two to one.');
  frame(16_000, 'odds.answered', () => ({
    offer_id: OFFER.judge,
    party: 'B',
    answer: 'accepted',
    by_offer_id: null,
  }));
  frame(16_000, 'terms.proposed', (b) => ({ envelope: card2(b) }));
  frame(16_000, 'odds.agreed', (b) => ({
    offer_id: OFFER.judge,
    stakes: { a: '5000000', b: '10000000' },
    ratio_label: '2 to 1',
    terms_hash: card2(b).terms_hash,
  }));
  judge(16_300, 'Odds agreed: Logan five, Jake ten; winner takes fifteen. Both lock it in.');
  state(20_000, 'AWAITING_AUTHORIZATIONS', 'TERMS_PROPOSED');
  const auth = (at: number, party: 'A' | 'B', count: number) =>
    frame(at, 'terms.authorized', (b) => ({
      party,
      method: 'faceid_hold',
      authorized_at: iso(b + at),
      count,
    }));
  auth(21_500, 'A', 1);
  auth(23_000, 'B', 2);
  state(23_000, 'AWAITING_LOCK', 'AWAITING_AUTHORIZATIONS');
  frame(23_500, 'tx.submitted', () => ({ kind: 'atomic_lock', signature: SIG_LOCK }));
  frame(24_500, 'tx.confirmed', () => ({
    kind: 'atomic_lock',
    signature: SIG_LOCK,
    slot: 400_118_245,
  }));
  state(24_500, 'LOCKED', 'AWAITING_LOCK', 'Locked');
  judge(24_700, "Locked. Fifteen dollars in escrow. Jake, whenever you're ready.");
  return out.sort((x, y) => x.at - y.at);
}

const SEQUENCE = sequence();

/**
 * The odds sample at a moment: `preview` is the `?preview=` value ('odds' loops from `startMs`,
 * 'odds-<step>' freezes on that step). Returns the state and the clock to render it with.
 */
export function previewOddsAt(
  startMs: number,
  nowMs: number,
  preview: string = ODDS_PREVIEW,
): { state: TickerState; now: number; t: number } {
  const step = preview.startsWith(`${ODDS_PREVIEW}-`)
    ? preview.slice(ODDS_PREVIEW.length + 1)
    : null;
  const frozen = step && step in ODDS_STEPS ? ODDS_STEPS[step as OddsStep] : null;
  const t = frozen ?? (((nowMs - startMs) % ODDS_LOOP_MS) + ODDS_LOOP_MS) % ODDS_LOOP_MS;
  const now = frozen !== null ? startMs + frozen : nowMs;
  const base = now - t;
  let s: TickerState = initialTicker;
  for (const e of SEQUENCE) {
    if (e.at > t) break;
    s = applyFrame(s, e.action(base));
  }
  return {
    t,
    now,
    state: {
      ...s,
      status: 'open',
      clockOffsetMs: 0,
      presence: {
        room_id: ROOM,
        online: 3,
        members: 3,
        online_by_user: { [USER_A]: true, [USER_B]: true },
      },
    },
  };
}
