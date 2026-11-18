// Stand-in data for the app preview, until rooms, bets, the judge and payouts are served
// (TASKS D0-J4, D1-J1, D3-L1, D4-L2). The two bets are SCHEMAS §2.5 and §2.6 verbatim, with
// the phone's own name as party A, so the screens render real, hash-checked Terms.
import { computeTermsHash, type Terms } from '@youre-on/shared/terms';

export interface PreviewUser {
  user_id: string;
  display_name: string;
  online: boolean;
  face_enrolled: boolean;
}

export const ROOM = { code: 'UBC26X', name: 'Demo room' } as const;

export const MEMBERS: readonly PreviewUser[] = [
  { user_id: 'u-jake', display_name: 'Jake', online: true, face_enrolled: true },
  { user_id: 'u-sam', display_name: 'Sam', online: true, face_enrolled: false },
  { user_id: 'u-priya', display_name: 'Priya', online: false, face_enrolled: true },
];

/** DATA-MODEL §7.1 example: 4-7, −$7.00 against Jake. */
export const HEAD_TO_HEAD = { wins: 4, losses: 7, net: '-7000000' } as const;

/** Starting balance and what is in escrow, as `GET /v1/me/balance` would return them. */
export const BALANCE = { usdc: '42500000', in_escrow: '0' } as const;

/**
 * The Home sparkline in the design preview: the balance (cents) over 24 points, oldest first,
 * ending at BALANCE ($42.50). An irregular walk with an upward drift (a few flat runs, one real
 * dip in the middle): up overall (+$12.50), so it draws green.
 */
export const BALANCE_SERIES: readonly number[] = [
  3000, 3080, 3080, 3215, 3150, 3340, 3295, 3295, 3295, 3420, 3255, 3060, 2905, 3010, 3185, 3410,
  3375, 3560, 3560, 3735, 3690, 3905, 4030, 4250,
];

/**
 * The market screen's price line in the design preview: 20 recent Bitcoin ticks (USD), oldest
 * first, jittering up to the preview's starting price ($97,412.50), so it draws green.
 */
export const MARKET_TRAIL: readonly number[] = [
  97268.4, 97281.9, 97274.15, 97296.8, 97310.25, 97301.6, 97289.05, 97315.7, 97338.2, 97329.45,
  97347.9, 97362.3, 97351.15, 97368.6, 97384.95, 97372.4, 97391.8, 97404.25, 97398.1, 97412.5,
];

export interface HistoryItem {
  bet_id: string;
  title: string;
  opponent: string;
  /** Signed micro-USDC net for me; "0" for a refund. */
  net: string;
  outcome: 'won' | 'lost' | 'void';
  settled_at: string;
}

export const HISTORY: readonly HistoryItem[] = [
  {
    bet_id: 'h1',
    title: 'Bottle flip',
    opponent: 'Jake',
    net: '5000000',
    outcome: 'won',
    settled_at: '2026-11-15T22:10:00.000Z',
  },
  {
    bet_id: 'h2',
    title: 'Free throw',
    opponent: 'Sam',
    net: '-3000000',
    outcome: 'lost',
    settled_at: '2026-11-15T21:02:00.000Z',
  },
  {
    bet_id: 'h3',
    title: 'Coin in cup',
    opponent: 'Jake',
    net: '0',
    outcome: 'void',
    settled_at: '2026-11-14T19:45:00.000Z',
  },
];

const ESCROW = {
  cluster: 'devnet',
  program_id: 'HrN54SG8B4uJzrcfkAJNgqNyafpCNek9XZ9o8NcR15YX',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
} as const;
const A_KEY = 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4';
const B_KEY = 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr';

export interface PreviewBet {
  terms: Terms;
  termsHash: string;
}

/** SCHEMAS §2.5: "Bet you $5 you can't land a bottle flip." `me` is party A. */
export function bottleFlip(myName: string, opponent = 'Jake'): PreviewBet {
  const { terms, terms_hash } = computeTermsHash({
    schema_version: 1,
    bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
    escrow: ESCROW,
    party_a: { pubkey: A_KEY, display_name: myName },
    party_b: { pubkey: B_KEY, display_name: opponent },
    type: 'skill',
    claim: `${opponent} lands a water bottle flip upright on the table.`,
    performer: 'B',
    yes_party: 'B',
    attempts: { count: 1, rule: 'single' },
    success_criteria: [
      'The bottle rotates at least once in the air.',
      'The bottle comes to rest standing upright on its base.',
    ],
    failure_criteria: [
      'The bottle ends on its side, upside down, or off the table.',
      `${opponent} touches the bottle after releasing it.`,
    ],
    edge_cases: [
      {
        question: 'Does landing on the cap count?',
        answer: 'No. Only upright on its base counts.',
        asked_by: 'judge',
      },
    ],
    evidence_source: 'camera',
    market: null,
    stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
    deadline: '2026-11-21T18:15:00.000Z',
    created_at: '2026-11-21T18:05:12.345Z',
  });
  return { terms, termsHash: terms_hash };
}

/** SCHEMAS §2.6: "Bitcoin's up by the end of this pitch." A takes YES at 0.62. */
export function btcCloser(myName: string, opponent = 'Jake'): PreviewBet {
  const { terms, terms_hash } = computeTermsHash({
    schema_version: 1,
    bet_id: '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73',
    escrow: ESCROW,
    party_a: { pubkey: A_KEY, display_name: myName },
    party_b: { pubkey: B_KEY, display_name: opponent },
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
  return { terms, termsHash: terms_hash };
}

/** The judge's side of Beat 2, as live captions (`judge.line`), with who said each line. */
export const NEGOTIATION_SCRIPT: readonly { who: 'judge' | 'a' | 'b'; text: string }[] = [
  { who: 'a', text: "Bet you five bucks you can't land a bottle flip." },
  { who: 'judge', text: 'Bold. Does landing on the cap count, or only the base?' },
  { who: 'b', text: 'Only the base.' },
  { who: 'judge', text: 'One flip, upright on its base, five dollars each. Lock it in.' },
];

/** The judge's ruling line for the bottle flip (SCHEMAS §5.2 `reason`). */
export const RULING_REASON =
  'Frame 7 shows the bottle tipping onto its side after it touched down. Not upright.';

/** The settlement line for the BTC closer (SCHEMAS §5.2, model rule/gemini-settlement@1). */
export const MARKET_REASON = 'Gemini settled this contract YES.';

/** One filming tip for "Run it back" (TASKS D3-M2). */
export const FILMING_TIP = 'Keep the whole table in the shot, and stop a beat after it lands.';

/** Appeal panel seats (SCHEMAS §7): three providers vote independently. */
export const PANEL = [
  { seat: 0, name: 'Claude', reason: 'Bottle rests on its side in the last frame.' },
  { seat: 1, name: 'GPT', reason: 'Upright for one frame, then falls. Not at rest.' },
  { seat: 2, name: 'Gemini', reason: 'Final frames show it on its side.' },
] as const;
