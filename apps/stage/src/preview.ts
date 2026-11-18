// `?preview` on the stage URL: the pitch layout playing a full, realistic bet sequence from
// fixture frames (no server), for projector rehearsal, layout checks and screenshots. Every frame
// goes through the same applyFrame() as live WebSocket traffic and parses with the shared schemas,
// so the preview is also a smoke test of the reducer. Labelled PREVIEW in the header.
//
//   ?preview          loops: Beat 1-4 bottle flip (challenge, terms, both Face IDs, the atomic
//                     lock, a REDO, the GG ruling + appeal window, the payout), then Beat 6 (a
//                     Gemini BTC 5-minute bet, locked at fair stakes, settled by Gemini)
//   ?preview=<step>   freezes on one moment: challenge, terms, lock, locked, attempt, redo,
//                     judging, ruling, paid, market, settled
//   ?preview=gemini   Beat 6 alone, in real time: a Gemini bet's clock, the wait for Gemini, then
//                     Gemini's result (preview-market.ts)
// Signatures and keys are fixtures: the QR codes in preview point at transactions that do not exist.
import type { BetSnapshot } from '@youre-on/shared/api';
import { splitPot, type GeminiMarketSnapshot } from '@youre-on/shared/gemini';
import { hashJcs } from '@youre-on/shared/jcs';
import { sha256Hex } from '@youre-on/shared/primitives';
import { GEMINI_SETTLEMENT_MODEL } from '@youre-on/shared/ruling';
import type { DemoHealth } from './health';
import { applyFrame, initialTicker, type TickerAction, type TickerState } from './ticker';

const ROOM = '2b7d9c41-5e3a-4f60-8a1b-9c0d1e2f3a4b';
const BET_FLIP = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const BET_BTC = 'c41e8f20-3d5b-4a7c-9e1f-2a3b4c5d6e7f';
const USER_A = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const USER_B = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
const PK_A = 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4';
const PK_B = 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr';
const PK_X = 'B1Qtn1Zk68Sqx2rFDNdqGbMv5m5t4pCKU2P1MDjZ7NWi';
const PROGRAM = 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIG = {
  lock: 'VeaRKoEn9T7U9x9LEzWQwNBejcL6L48nPdsSQMRmQQ1rceGPFUY4oTQ3gxaaMvXWXRJShQ1pdoW3aLj7EeBqu5Ax',
  resolve:
    'sNKoNU923rYH2Jm5Co164JRGpvgL4Pc4983Q1EBb1XbqxRjLbwZTcoMMeW37xb75QSVzGjNBr4vgyrpNYiTKzzsi',
  pay: 'cPJW4bhUULsskzvTCGLm3tcPhBiu23ZUEGZJCgT2nvYoCjtFTkS86cqMipyY8Kkf7jC2CJwLhY9TFedMiiRjvJba',
  lock2: 'ghAZAC5uAErtvd8Y6X4kBidWNUVn6XfN5L3ZD4ScggmfYMgcyhMk2TVVHEA7QFcou2p7phVNaYRz23sLfsBtdJDm',
  resolve2:
    '9Kj9eB3ZveSXYCnbiY6mmJm3H7wWwTY4NjJiXWnQNpd3nJQZmVrePJTNNsRErtM5GJ1BgTwMTMmnHhvmUS7quMUp',
  pay2: 'GerzrLSJyjrNuxk9tMqGmauShKHjG3FhGA6d6VoVLJ9MURMSTB3nteGTCqCsbGdmR72d7FKExQNv12n1Ajgt7pJh',
};
const NAMES = { A: 'Logan', B: 'Jake' };
/** describeChecks() of the bottle-flip spec (visible end gate; at_rest, upright needs). */
export const FLIP_READBACK =
  'Ref cam: the bottle fully in shot at the end; the bottle comes to rest; the bottle stands upright. Film from the side. If the ref cam is offline, the judge decides alone.';
/** The ref cam's rows on the flip (checks.report labels, spec order: gate, need, need). */
const FLIP_CHECKS = [
  'the bottle fully in shot at the end',
  'the bottle comes to rest',
  'the bottle stands upright',
];

/** Beat 6: a $10 pot split at Gemini's 61% Up (Logan, party A, holds Up). */
const BTC_FAIR = splitPot(10_000_000n, 'YES', 61n);
const BTC_STAKES = { a: BTC_FAIR.a.toString(), b: BTC_FAIR.b.toString() };

/** One loop of the sequence. */
export const LOOP_MS = 90_000;
/** Freeze points for ?preview=<step> (ms into the loop). */
export const PREVIEW_STEPS = {
  challenge: 1_000,
  terms: 11_000,
  lock: 15_000,
  locked: 21_000,
  attempt: 24_000,
  redo: 29_500,
  judging: 36_000,
  ruling: 41_000,
  paid: 50_500,
  market: 74_000,
  settled: 81_000,
} as const;
export type PreviewStep = keyof typeof PREVIEW_STEPS;
export const isPreviewStep = (s: string): s is PreviewStep => s in PREVIEW_STEPS;

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = (s: string) => sha256Hex(`preview:${s}`);
const iso = (ms: number) => new Date(ms).toISOString();
const isoSec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const unix = (ms: number) => Math.floor(ms / 1000);

// ---- evidence frames: a bottle flip drawn as SVG -------------------------------------------

type Pose = { x: number; y: number; deg: number } | null;
/** Attempt 1 leaves the frame (REDO); attempt 2 lands upright in frame 7. */
const FLIGHTS: Record<1 | 2, Pose[]> = {
  1: [
    { x: 40, y: 72, deg: 0 },
    { x: 58, y: 48, deg: 140 },
    { x: 78, y: 14, deg: 300 },
    { x: 96, y: -20, deg: 430 },
    null,
    null,
    { x: 160, y: 80, deg: 90 },
    { x: 160, y: 80, deg: 90 },
  ],
  2: [
    { x: 40, y: 72, deg: 0 },
    { x: 55, y: 52, deg: 120 },
    { x: 70, y: 34, deg: 260 },
    { x: 85, y: 30, deg: 400 },
    { x: 98, y: 44, deg: 540 },
    { x: 108, y: 64, deg: 650 },
    { x: 114, y: 72, deg: 712 },
    { x: 116, y: 72, deg: 720 },
  ],
};

export function bottleFrame(attempt: 1 | 2, i: number): string {
  const p = FLIGHTS[attempt][i] ?? null;
  const bottle = p
    ? `<g transform="translate(${p.x} ${p.y}) rotate(${p.deg}) scale(1.5)">` +
      `<rect x="-7" y="-12" width="14" height="24" rx="4" fill="#9fd4ff" fill-opacity=".9"/>` +
      `<rect x="-7" y="2" width="14" height="10" rx="3" fill="#3b8fd9"/>` +
      `<rect x="-3" y="-19" width="6" height="8" fill="#9fd4ff"/>` +
      `<rect x="-3.5" y="-22" width="7" height="4" rx="1" fill="#e5484d"/></g>`
    : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e2e32"/>` +
    `<stop offset="1" stop-color="#141416"/></linearGradient></defs>` +
    `<rect width="160" height="120" fill="url(#g)"/>` +
    `<rect y="90" width="160" height="30" fill="#6b4f35"/><rect y="90" width="160" height="2" fill="#8a6a4a"/>` +
    bottle +
    `<circle cx="150" cy="9" r="3" fill="#e5484d"/>` +
    `<text x="6" y="12" font-family="monospace" font-size="9" fill="#fff" fill-opacity=".8">f${i}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ---- the sequence ---------------------------------------------------------------------------

interface Entry {
  at: number;
  /**
   * A chain.* event (QuickNode Streams); `previewAt(…, { chain: false })` leaves them out and
   * `{ via: 'rpc_poll' }` replays them as the fallback observed them.
   */
  chain?: boolean;
  action: (base: number) => TickerAction;
}

function marketAt(nowMs: number): GeminiMarketSnapshot {
  const start = Math.floor(nowMs / 300_000) * 300_000;
  const d = new Date(start + 300_000);
  const tag = [
    d.getUTCFullYear() % 100,
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  ]
    .map((n) => String(n).padStart(2, '0'))
    .join('');
  const i = nowMs / 2000;
  return {
    eventTicker: `BTC05M${tag}`,
    eventTitle: 'BTC 5-minute (preview)',
    instrumentSymbol: `GEMI-BTC05M${tag}-UP`,
    contractLabel: 'Up',
    status: 'active',
    marketState: 'open',
    strike: { value: '64389.6', type: 'reference', availableAt: iso(start) },
    expiry: iso(start + 300_000),
    bestBid: '0.56',
    bestAsk: '0.66',
    lastTradePrice: null,
    indexPrice: (64404 + Math.sin(i / 5) * 16 + Math.sin(i / 1.7) * 4).toFixed(2),
    source: 'rest_event',
    exchangeTs: null,
    observedAt: iso(nowMs),
  };
}

function sequence(): Entry[] {
  const out: Entry[] = [];
  const seqs: Record<string, number> = {};
  // Each bet's entries are added in time order, so a counter per bet is its gapless seq.
  const frame = (at: number, betId: string, type: string, payload: (base: number) => unknown) => {
    const seq = (seqs[betId] = (seqs[betId] ?? 0) + 1);
    out.push({
      at,
      chain: type.startsWith('chain.'),
      action: (base) => ({
        kind: 'frame',
        receivedAt: base + at,
        raw: {
          v: 1,
          type,
          bet_id: betId,
          seq,
          ts: iso(base + at),
          source: type.startsWith('chain.') ? 'chain' : 'server',
          payload: payload(base),
        },
      }),
    });
  };
  const snapshot = (at: number, betId: string) =>
    out.push({
      at,
      action: (base) => ({ kind: 'snapshot', receivedAt: base + at, bet: snapshotOf(betId) }),
    });
  const state = (
    at: number,
    betId: string,
    s: string,
    prev: string | null,
    onchain: string | null = null,
  ) =>
    frame(at, betId, 'bet.state', () => ({
      state: s,
      prev,
      onchain_status: onchain,
      chain_ack: onchain ? 'rpc' : 'none',
      pending_tx: null,
      reason: null,
    }));
  /**
   * bet.state as the payout service publishes it once its own RPC confirms a tx: RULED carries the
   * resolve and `appeal_deadline=<unix s>`, FINALIZED / PAID the payout tx.
   */
  const stateTx = (
    at: number,
    betId: string,
    s: string,
    prev: string,
    onchain: string,
    tx: { kind: string; signature: string; sentAt: number; confirmed: boolean },
    reason: (base: number) => string | null = () => null,
  ) =>
    frame(at, betId, 'bet.state', (b) => ({
      state: s,
      prev,
      onchain_status: onchain,
      chain_ack: 'rpc',
      pending_tx: {
        kind: tx.kind,
        signature: tx.signature,
        submitted_at: iso(b + tx.sentAt),
        rpc_processed_at: tx.confirmed ? iso(b + at - 400) : null,
        rpc_confirmed_at: tx.confirmed ? iso(b + at) : null,
      },
      reason: reason(b),
    }));
  const confirmed = (at: number, betId: string, kind: string, signature: string) =>
    frame(at, betId, 'tx.confirmed', () => ({
      kind,
      signature,
      slot: 400_118_200 + Math.round(at / 400),
    }));
  let line = 0;
  const judge = (at: number, betId: string, text: string) =>
    frame(at, betId, 'judge.line', () => ({ utterance_id: uuid(++line), text, final: true }));
  /** The judge.cue the payout service sends with PAID (the stage voices it, voice.ts). */
  const paidCue = (at: number, betId: string, winner: string, toA: string, toB: string) =>
    frame(at, betId, 'judge.cue', () => ({
      cue: 'PAID',
      text: `[EVENT] PAID winner=${winner} amount=${winner === NAMES.A ? toA : toB} to_a=${toA} to_b=${toB} :: Congratulate ${winner} in one line.`,
      speak: true,
    }));
  const meta = (signature: string, base: number, at: number) => ({
    signature,
    slot: 400_118_200 + Math.round(at / 400),
    block_height: null,
    outer_ix: 3,
    inner_ix: 0,
    block_time: unix(base + at),
    observed_via: 'quicknode_stream',
  });

  // ---- Beats 1-4: the bottle flip --------------------------------------------------------
  const flip = (base: number) => flipEnvelope(base);
  snapshot(0, BET_FLIP);
  // A face challenge between rivals: the stage shows "Logan 4–7 Jake · Rivals" under VS.
  frame(0, BET_FLIP, 'bet.invited', () => ({
    challenger: { user_id: USER_A, pubkey: PK_A, display_name: NAMES.A, avatar_url: null },
    room_id: ROOM,
    rivalry: {
      challenge_method: 'face',
      a_wins: 4,
      b_wins: 7,
      pushes: 0,
      total: 11,
      streak: { party: 'B', length: 2 },
      rival: true,
      includes_seed: true,
    },
  }));
  state(0, BET_FLIP, 'DRAFTING', null);
  frame(1_500, BET_FLIP, 'bet.invite_answered', () => ({ party: 'B', answer: 'accepted' }));
  judge(3_000, BET_FLIP, "Alright, Logan. What's the bet?");
  frame(4_500, BET_FLIP, 'party.line', () => ({
    party: 'B',
    utterance_id: uuid(++line),
    text: 'Easy money. I never miss.',
    final: true,
  }));
  judge(6_000, BET_FLIP, 'Jake, does landing on the cap count? No? Upright on its base only.');
  frame(9_000, BET_FLIP, 'terms.proposed', (b) => ({ envelope: flip(b) }));
  state(9_000, BET_FLIP, 'TERMS_PROPOSED', 'DRAFTING');
  // the server compiles the terms into ref cam checks beside the bet (non-binding, checks.ts)
  frame(9_400, BET_FLIP, 'checks.compiled', (b) => ({
    terms_hash: flip(b).terms_hash,
    decision: 'checks',
    readback: FLIP_READBACK,
  }));
  judge(
    9_500,
    BET_FLIP,
    'Jake lands a bottle flip upright. Five dollars each. Both of you, lock it in.',
  );
  state(12_000, BET_FLIP, 'AWAITING_AUTHORIZATIONS', 'TERMS_PROPOSED');
  const auth = (at: number, party: 'A' | 'B', count: number) =>
    frame(at, BET_FLIP, 'terms.authorized', (b) => ({
      party,
      method: 'faceid_hold',
      authorized_at: iso(b + at),
      count,
    }));
  auth(14_000, 'A', 1);
  auth(16_500, 'B', 2);
  state(16_500, BET_FLIP, 'AWAITING_LOCK', 'AWAITING_AUTHORIZATIONS');
  frame(17_000, BET_FLIP, 'tx.submitted', () => ({ kind: 'atomic_lock', signature: SIG.lock }));
  frame(18_000, BET_FLIP, 'tx.confirmed', () => ({
    kind: 'atomic_lock',
    signature: SIG.lock,
    slot: 400_118_245,
  }));
  state(18_000, BET_FLIP, 'LOCKED', 'AWAITING_LOCK', 'Locked');
  judge(18_200, BET_FLIP, "Locked. Ten dollars in escrow. Jake, whenever you're ready.");
  frame(19_800, BET_FLIP, 'chain.BetCreated', (b) => ({
    ...meta(SIG.lock, b, 19_800),
    bet_id: BET_FLIP,
    bet: PK_X,
    vault: PK_X,
    party_a: PK_A,
    party_b: PK_B,
    mint: MINT,
    stake_a: '5000000',
    stake_b: '5000000',
    terms_hash: flip(b).terms_hash,
    judge_authority: PK_X,
    appeal_authority: PK_X,
    accept_deadline: unix(b) + 300,
    rent_payer: PK_X,
    ts: unix(b + 17_000),
  }));
  frame(19_900, BET_FLIP, 'chain.BetAccepted', (b) => ({
    ...meta(SIG.lock, b, 19_900),
    inner_ix: 1,
    bet_id: BET_FLIP,
    party_a: PK_A,
    party_b: PK_B,
    terms_hash: flip(b).terms_hash,
    stake_a: '5000000',
    stake_b: '5000000',
    vault_amount: '10000000',
    resolve_deadline: unix(b) + 900,
    ts: unix(b + 17_000),
  }));
  const attempt = (at: number, n: 1 | 2) => {
    frame(at, BET_FLIP, 'attempt.started', (b) => ({
      attempt_no: n,
      performer: 'B',
      max_ms: 15_000,
      recorder_device_id: uuid(900 + n),
      go_at: iso(b + at + 3000),
    }));
    state(at, BET_FLIP, 'ATTEMPT', n === 1 ? 'LOCKED' : 'JUDGING', 'Locked');
  };
  const evidence = (at: number, n: 1 | 2) => {
    frame(at, BET_FLIP, 'attempt.evidence', (b) => ({
      evidence: {
        schema_version: 1,
        kind: 'camera',
        bet_id: BET_FLIP,
        attempt_no: n,
        clip_sha256: hex(`clip${n}`),
        clip_bytes: 2_400_000,
        mime: 'video/mp4',
        duration_ms: 4_200,
        recorded_by: 'A',
        recorded_at: iso(b + at - 1000),
        frames: Array.from({ length: 8 }, (_, i) => ({
          index: i,
          t_ms: i * 520,
          sha256: hex(`f${n}.${i}`),
        })),
      },
      frame_urls: Array.from({ length: 8 }, (_, i) => bottleFrame(n, i)),
    }));
    state(at, BET_FLIP, 'JUDGING', 'ATTEMPT', 'Locked');
  };
  const ruling = (at: number, n: 1 | 2, r: Record<string, unknown>) =>
    frame(at, BET_FLIP, 'ruling.issued', (b) => ({
      ruling: {
        schema_version: 1,
        ruling_id: uuid(700 + n),
        bet_id: BET_FLIP,
        stage: 'attempt',
        attempt_no: n,
        frame_hashes: Array.from({ length: 8 }, (_, i) => hex(`f${n}.${i}`)),
        model: 'anthropic/claude-sonnet-5-5',
        evidence_hash: hex(`clip${n}`),
        terms_hash: flip(b).terms_hash,
        created_at: iso(b + at),
        void_reason: null,
        ...r,
      },
      ruling_hash: hex(`ruling${n}`),
    }));
  /**
   * The ref cam's report, just before the ruling: attempt 1's bottle is out of shot at the end
   * (the judge already calls it REDO, so no veto); attempt 2's three checks pass, the box on the
   * bottle in the end frames (the preview frames' 160x120 px).
   */
  const report = (at: number, n: 1 | 2) =>
    frame(at, BET_FLIP, 'checks.report', () => {
      const ok = n === 2;
      const rows = FLIP_CHECKS.map((label, i) => ({
        role: i === 0 ? 'gate' : 'need',
        label,
        value: ok ? 'true' : i === 0 ? 'false' : 'unknown',
        why: ok ? 'ok' : 'absent',
        frames: [5, 6, 7],
        measures: [],
      }));
      const box = (b: number[], score: number) => [
        { key: 'bottle', prompt: 'bottle', box_xyxy: b, score },
      ];
      return {
        attempt_no: n,
        status: 'ok',
        gate: ok ? 'true' : 'false',
        need: ok ? 'true' : 'unknown',
        veto: null,
        results: rows,
        boxes: ok
          ? {
              5: box([84, 47, 133, 81], 0.91),
              6: box([102, 39, 126, 90], 0.95),
              7: box([105, 39, 127, 90], 0.96),
            }
          : {},
        frame_size: { w: 160, h: 120 },
        report_hash: hex(`report${n}`),
      };
    });
  attempt(22_000, 1);
  evidence(26_000, 1);
  report(28_000, 1);
  ruling(28_000, 1, {
    outcome: 'REDO',
    claim_result: 'UNCLEAR',
    confidence: 0.41,
    reason: 'The bottle leaves the frame after frame 2; I cannot see how it lands. Redo.',
    cited_frames: [2, 3],
    redo_reason: 'unclear',
  });
  judge(28_300, BET_FLIP, 'Redo! The bottle flew out of the shot. Keep it in frame, Jake.');
  attempt(31_000, 2);
  evidence(35_000, 2);
  report(37_000, 2);
  ruling(37_000, 2, {
    outcome: 'B_WINS',
    claim_result: 'MET',
    confidence: 0.94,
    reason: 'Two full rotations; it lands upright on its base in frame 7 and stays there.',
    cited_frames: [7, 6],
    redo_reason: null,
  });
  judge(37_300, BET_FLIP, 'Jake wins! Logan, you have ten seconds to appeal.');
  const flipResolve = { kind: 'resolve', signature: SIG.resolve, sentAt: 37_500, confirmed: true };
  stateTx(
    38_200,
    BET_FLIP,
    'RULED',
    'JUDGING',
    'Resolved',
    flipResolve,
    (b) => `appeal_deadline=${unix(b + 38_600) + 10}`,
  );
  confirmed(38_200, BET_FLIP, 'resolve', SIG.resolve);
  frame(38_600, BET_FLIP, 'chain.BetResolved', (b) => ({
    ...meta(SIG.resolve, b, 38_600),
    bet_id: BET_FLIP,
    judge: PK_X,
    outcome: 'PartyB',
    evidence_hash: hex('clip2'),
    ruling_hash: hex('ruling2'),
    appeal_deadline: unix(b + 38_600) + 10,
    ts: unix(b + 38_600),
  }));
  const flipPay = { kind: 'finalize', signature: SIG.pay, sentAt: 48_800, confirmed: false };
  stateTx(48_800, BET_FLIP, 'FINALIZED', 'RULED', 'Resolved', flipPay);
  frame(48_800, BET_FLIP, 'tx.submitted', () => ({ kind: 'finalize', signature: SIG.pay }));
  stateTx(49_400, BET_FLIP, 'PAID', 'FINALIZED', 'Settled', { ...flipPay, confirmed: true });
  confirmed(49_400, BET_FLIP, 'finalize', SIG.pay);
  paidCue(49_400, BET_FLIP, NAMES.B, '$0.00', '$10.00');
  frame(49_600, BET_FLIP, 'chain.BetFinalized', (b) => ({
    ...meta(SIG.pay, b, 49_600),
    bet_id: BET_FLIP,
    final_status: 'Settled',
    outcome: 'PartyB',
    mint: MINT,
    party_a: PK_A,
    party_b: PK_B,
    party_a_token: '11111111111111111111111111111111',
    party_b_token: PK_B,
    to_a: '0',
    to_b: '10000000',
    ts: unix(b + 49_600),
    caller: PK_X,
  }));
  judge(49_800, BET_FLIP, 'Paid. Jake takes ten dollars. GG, Logan.');
  frame(50_400, BET_FLIP, 'chain.BetClosed', (b) => ({
    ...meta(SIG.pay, b, 50_400),
    inner_ix: 1,
    bet_id: BET_FLIP,
    final_status: 'Settled',
    rent_payer: PK_X,
    rent_returned: '3285120',
    residual_to_a: '0',
    ts: unix(b + 50_400),
  }));

  // ---- Beat 6: a bet on Gemini's BTC 5-minute market --------------------------------------
  const btc = (base: number) => btcEnvelope(base);
  snapshot(57_000, BET_BTC);
  state(57_000, BET_BTC, 'DRAFTING', null);
  judge(
    58_000,
    BET_BTC,
    "Bitcoin up by the end of this pitch? Gemini's market has it at 61 percent.",
  );
  frame(61_000, BET_BTC, 'terms.proposed', (b) => ({ envelope: btc(b) }));
  state(61_000, BET_BTC, 'TERMS_PROPOSED', 'DRAFTING');
  state(62_500, BET_BTC, 'AWAITING_AUTHORIZATIONS', 'TERMS_PROPOSED');
  frame(64_000, BET_BTC, 'terms.authorized', (b) => ({
    party: 'A',
    method: 'faceid_hold',
    authorized_at: iso(b + 64_000),
    count: 1,
  }));
  frame(65_500, BET_BTC, 'terms.authorized', (b) => ({
    party: 'B',
    method: 'passcode_hold',
    authorized_at: iso(b + 65_500),
    count: 2,
  }));
  frame(66_000, BET_BTC, 'tx.submitted', () => ({ kind: 'atomic_lock', signature: SIG.lock2 }));
  frame(67_000, BET_BTC, 'tx.confirmed', () => ({
    kind: 'atomic_lock',
    signature: SIG.lock2,
    slot: 400_118_420,
  }));
  frame(68_600, BET_BTC, 'chain.BetCreated', (b) => ({
    ...meta(SIG.lock2, b, 68_600),
    bet_id: BET_BTC,
    bet: PK_X,
    vault: PK_X,
    party_a: PK_A,
    party_b: PK_B,
    mint: MINT,
    stake_a: BTC_STAKES.a,
    stake_b: BTC_STAKES.b,
    terms_hash: btc(b).terms_hash,
    judge_authority: PK_X,
    appeal_authority: PK_X,
    accept_deadline: unix(b) + 400,
    rent_payer: PK_X,
    ts: unix(b + 66_000),
  }));
  state(69_000, BET_BTC, 'AWAITING_MARKET', 'LOCKED', 'Locked');
  // Gemini's settled record (the market panel's result), then the rule ruling that commits to it
  const settledHash = (b: number) => hashJcs(btcSettlement(b));
  frame(79_600, BET_BTC, 'market.settled', (b) => ({
    record: btcSettlement(b),
    evidence_hash: settledHash(b),
  }));
  frame(80_000, BET_BTC, 'ruling.issued', (b) => ({
    ruling: {
      schema_version: 1,
      ruling_id: uuid(801),
      bet_id: BET_BTC,
      stage: 'settlement',
      attempt_no: 1,
      outcome: 'A_WINS',
      claim_result: 'MET',
      confidence: 1,
      reason:
        'Gemini settled the contract UP: BTC closed at $64,412.10, above the $64,389.60 line.',
      cited_frames: [],
      frame_hashes: [],
      model: GEMINI_SETTLEMENT_MODEL,
      evidence_hash: settledHash(b),
      terms_hash: btc(b).terms_hash,
      created_at: iso(b + 80_000),
      redo_reason: null,
      void_reason: null,
    },
    ruling_hash: hex('ruling-btc'),
  }));
  judge(80_200, BET_BTC, 'Gemini says up. Logan takes the pot.');
  stateTx(
    80_800,
    BET_BTC,
    'RULED',
    'AWAITING_MARKET',
    'Resolved',
    { kind: 'resolve', signature: SIG.resolve2, sentAt: 80_300, confirmed: true },
    (b) => `appeal_deadline=${unix(b + 81_400)}`,
  );
  confirmed(80_800, BET_BTC, 'resolve', SIG.resolve2);
  frame(81_400, BET_BTC, 'chain.BetResolved', (b) => ({
    ...meta(SIG.resolve2, b, 81_400),
    bet_id: BET_BTC,
    judge: PK_X,
    outcome: 'PartyA',
    evidence_hash: settledHash(b),
    ruling_hash: hex('ruling-btc'),
    appeal_deadline: unix(b + 81_400),
    ts: unix(b + 81_400),
  }));
  const btcPay = { kind: 'finalize', signature: SIG.pay2, sentAt: 81_600, confirmed: false };
  stateTx(81_600, BET_BTC, 'FINALIZED', 'RULED', 'Resolved', btcPay);
  frame(81_600, BET_BTC, 'tx.submitted', () => ({ kind: 'finalize', signature: SIG.pay2 }));
  stateTx(81_800, BET_BTC, 'PAID', 'FINALIZED', 'Settled', { ...btcPay, confirmed: true });
  confirmed(81_800, BET_BTC, 'finalize', SIG.pay2);
  paidCue(81_800, BET_BTC, NAMES.A, '$10.00', '$0.00');
  frame(82_000, BET_BTC, 'chain.BetFinalized', (b) => ({
    ...meta(SIG.pay2, b, 82_000),
    bet_id: BET_BTC,
    final_status: 'Settled',
    outcome: 'PartyA',
    mint: MINT,
    party_a: PK_A,
    party_b: PK_B,
    party_a_token: PK_A,
    party_b_token: '11111111111111111111111111111111',
    to_a: '10000000',
    to_b: '0',
    ts: unix(b + 82_000),
    caller: PK_X,
  }));
  return out.sort((x, y) => x.at - y.at);
}

function terms(base: number, over: Record<string, unknown>) {
  return {
    schema_version: 1,
    escrow: { cluster: 'devnet', program_id: PROGRAM, mint: MINT },
    party_a: { pubkey: PK_A, display_name: NAMES.A },
    party_b: { pubkey: PK_B, display_name: NAMES.B },
    edge_cases: [],
    ...over,
    created_at: iso(base),
  };
}

const envCache = new Map<string, ReturnType<typeof envelopeOf>>();
function envelopeOf(
  t: Record<string, unknown>,
  title: string,
  readback: string,
  stakes: string,
  odds: string | null,
) {
  return {
    terms: t,
    terms_hash: hashJcs(t),
    presentation: {
      title,
      readback,
      stakes_display: stakes,
      odds_display: odds,
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  };
}

function flipEnvelope(base: number) {
  const key = `flip:${base}`;
  let e = envCache.get(key);
  if (!e) {
    const t = terms(base + 9_000, {
      bet_id: BET_FLIP,
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
      stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
      deadline: isoSec(base + 9_000 + 600_000),
    });
    e = envelopeOf(
      t,
      'Bottle flip',
      'Jake flips a bottle upright. Five dollars each.',
      '$5 each',
      null,
    );
    envCache.set(key, e);
    if (envCache.size > 8) envCache.delete(envCache.keys().next().value!);
  }
  return e;
}

function btcEnvelope(base: number) {
  const key = `btc:${base}`;
  let e = envCache.get(key);
  if (!e) {
    const m = marketAt(base + 61_000);
    const t = terms(base + 61_000, {
      bet_id: BET_BTC,
      type: 'real_world',
      claim: "Bitcoin is above Gemini's line when this 5-minute contract closes.",
      performer: null,
      yes_party: 'A',
      attempts: { count: 1, rule: 'single' },
      success_criteria: ["Gemini settles the BTC 5-minute contract 'Up'."],
      failure_criteria: ["Gemini settles it 'Down'."],
      evidence_source: 'gemini',
      market: {
        venue: 'gemini',
        eventTicker: m.eventTicker,
        instrumentSymbol: m.instrumentSymbol,
        side: 'YES',
        priceAtLock: '0.61',
        priceSource: 'mid',
        quotedAt: iso(base + 60_500),
        strike: m.strike,
        expiry: isoSec(Date.parse(m.expiry)),
      },
      stakes: { ...BTC_STAKES, currency: 'USDC' },
      deadline: isoSec(Date.parse(m.expiry) + 600_000),
    });
    e = envelopeOf(
      t,
      'BTC up in 5',
      'Logan says Bitcoin finishes up. Gemini sets the odds.',
      '$6.10 vs $3.90',
      '61/39',
    );
    envCache.set(key, e);
    if (envCache.size > 8) envCache.delete(envCache.keys().next().value!);
  }
  return e;
}

/** Beat 6: Gemini's settled record of the bet's contract (UP at $64,412.10), as market.settled. */
function btcSettlement(base: number) {
  const m = marketAt(base + 61_000); // the contract btcEnvelope locked
  return {
    schema_version: 1,
    kind: 'gemini_settlement',
    bet_id: BET_BTC,
    terms_hash: btcEnvelope(base).terms_hash,
    contract: {
      eventTicker: m.eventTicker,
      instrumentSymbol: m.instrumentSymbol,
      status: 'settled',
      resolutionSide: 'yes',
      settlementValue: '64412.1',
      strike: m.strike,
      resolvedAt: iso(base + 79_000),
    },
    source_url: `https://api.gemini.com/v1/prediction-markets/events/${m.eventTicker}`,
    response_sha256: hex('gemini-body'),
    fetched_at: iso(base + 79_600),
  };
}

function snapshotOf(betId: string): BetSnapshot {
  const ref = (p: 'A' | 'B') => ({
    user_id: p === 'A' ? USER_A : USER_B,
    pubkey: (p === 'A' ? PK_A : PK_B) as never,
    display_name: NAMES[p],
    avatar_url: null,
  });
  return {
    bet_id: betId,
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

const SEQUENCE = sequence();

export interface PreviewFrame {
  state: TickerState;
  /** The clock the page renders countdowns with. */
  now: number;
  /** ms into the loop. */
  t: number;
}

/** A chain.* frame as the other observer would have sent it (`opts.via`: rpc_poll, the fallback). */
function observedBy(a: TickerAction, via: 'quicknode_stream' | 'rpc_poll'): TickerAction {
  if (a.kind !== 'frame') return a;
  const raw = a.raw as { payload: Record<string, unknown> };
  return { ...a, raw: { ...raw, payload: { ...raw.payload, observed_via: via } } };
}

/**
 * The stage at a moment of the sample sequence. `step` freezes it; otherwise it loops, with the
 * loop anchored at `startMs` (so the first frame is the challenge).
 */
export function previewAt(
  startMs: number,
  nowMs: number,
  step: string | null = null,
  opts: { chain?: boolean; via?: 'quicknode_stream' | 'rpc_poll' } = {},
): PreviewFrame {
  const frozen = step && isPreviewStep(step) ? PREVIEW_STEPS[step] : null;
  const t = frozen ?? (((nowMs - startMs) % LOOP_MS) + LOOP_MS) % LOOP_MS;
  const now = frozen !== null ? startMs + frozen : nowMs;
  const base = now - t;
  let s: TickerState = initialTicker;
  for (const e of SEQUENCE) {
    if (e.at > t) break;
    if (e.chain && opts.chain === false) continue;
    s = applyFrame(s, e.chain && opts.via ? observedBy(e.action(base), opts.via) : e.action(base));
  }
  // 80 s of the BTC index (one point every 2 s), the newest at `now`
  for (let i = 40; i >= 0; i--) {
    const at = now - i * 2000;
    s = applyFrame(s, { kind: 'market', snapshot: marketAt(at), receivedAt: at });
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

/** What GET /v1/demo/health looks like on a healthy pitch day (the strip's sample values). */
export const PREVIEW_HEALTH: DemoHealth = {
  chain_configured: true,
  lock_signer: 'server',
  rpc: 'quicknode',
  fee_payer: PK_X,
  fee_payer_sol: 4.82,
  nonce_pool: { size: 8, free: 7, leased: 1, advancing: 0, retired: 0 },
  last_tx: { kind: 'finalize', status: 'confirmed', signature: SIG.pay },
  rpc_ms: 142,
  rpc_error: null,
  db_ms: 9,
};

/** Back-compat: the frozen "ruled, appeal window open" moment. */
export function previewState(baseMs: number, nowMs: number): TickerState {
  return previewAt(baseMs, nowMs, 'ruling').state;
}
