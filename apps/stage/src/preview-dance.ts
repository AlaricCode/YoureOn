// `?preview=dance` on the stage URL: a Dance Off on sample frames (no server), for rehearsal,
// layout checks and screenshots. Labelled PREVIEW in the header like `?preview`. Every frame goes
// through the real applyFrame() and parses with the shared schemas (terms type 'dance_off' with
// no performer, DanceEvidence, the rule/dance-off@1 ruling), so it doubles as a smoke test.
//
// Logan challenges Jake to Wave Pop for $5 each. Both confirm, it locks, they line up (Logan on
// the left), dance the 15 s routine side by side, the server re-scores the poses and the ruling
// lands with the scoreboard. `dance` ends Logan 87.4, Jake 71.0, paid to Logan; `dance-tie` ends
// 78.3 to 77.1: too close to call, both refunded.
//
//   ?preview=dance            loops the whole walk (DANCE_LOOP_MS)
//   ?preview=dance-tie        loops the too-close-to-call variant
//   ?preview=dance-<step>     freezes on one moment: terms, lock, framing, dancing, scoring,
//                             ruling, paid (dance-tie-<step> for the variant)
import type { BetSnapshot } from '@youre-on/shared/api';
import { getRoutine, routineSha256, ROUTINES } from '@youre-on/shared/dance/routine';
import { DANCE_SCORER_VERSION } from '@youre-on/shared/dance/score';
import { danceTermsText } from '@youre-on/shared/dance/terms';
import { hashJcs } from '@youre-on/shared/jcs';
import { sha256Hex } from '@youre-on/shared/primitives';
import { DANCE_OFF_MODEL } from '@youre-on/shared/ruling';
import { applyFrame, initialTicker, type TickerAction, type TickerState } from './ticker';

/** The `?preview=` value that plays this sample (App.tsx); `dance-<step>` freezes it. */
export const DANCE_PREVIEW = 'dance';
export const isDancePreview = (p: string | null): boolean =>
  p === DANCE_PREVIEW || (p !== null && p.startsWith(`${DANCE_PREVIEW}-`));

export const DANCE_LOOP_MS = 52_000;
export const DANCE_STEPS = {
  terms: 3_000,
  lock: 7_000,
  framing: 11_000,
  dancing: 20_000,
  scoring: 32_500,
  ruling: 37_000,
  paid: 48_000,
} as const;
export type DanceStep = keyof typeof DANCE_STEPS;

type Variant = 'win' | 'tie';

const ROOM = '2b7d9c41-5e3a-4f60-8a1b-9c0d1e2f3a4b';
const BET: Record<Variant, string> = {
  win: '6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
  tie: '6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4c',
};
const USER_A = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const USER_B = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
const PK_A = 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4';
const PK_B = 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr';
const PROGRAM = 'BL3gwTBcftGQFdPNp7rZiAyDojkSusdAJ2dzNvFouwcp';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIG = {
  lock: 'VeaRKoEn9T7U9x9LEzWQwNBejcL6L48nPdsSQMRmQQ1rceGPFUY4oTQ3gxaaMvXWXRJShQ1pdoW3aLj7EeBqu5Ax',
  resolve:
    'sNKoNU923rYH2Jm5Co164JRGpvgL4Pc4983Q1EBb1XbqxRjLbwZTcoMMeW37xb75QSVzGjNBr4vgyrpNYiTKzzsi',
  pay: 'cPJW4bhUULsskzvTCGLm3tcPhBiu23ZUEGZJCgT2nvYoCjtFTkS86cqMipyY8Kkf7jC2CJwLhY9TFedMiiRjvJba',
};
const NAMES = { A: 'Logan', B: 'Jake' } as const;
const STAKE = '5000000';
const ROUTINE = getRoutine('wave-pop') ?? ROUTINES[0]!;

/** The sample scores (tenths) and grades per key move, in routine order (P / G / M). */
const RESULT: Record<
  Variant,
  { a: number; b: number; winner: 'A' | 'B' | null; too_close: boolean; ga: string; gb: string }
> = {
  win: { a: 874, b: 710, winner: 'A', too_close: false, ga: 'PPGPPGPMPPGP', gb: 'GPMGGMPGMGGM' },
  tie: { a: 783, b: 771, winner: 'A', too_close: true, ga: 'PGGPMGPGPGMG', gb: 'GPGGPMGPGPGM' },
};
const GRADE = { P: 'PERFECT', G: 'GOOD', M: 'MISS' } as const;
const grade = (s: string, i: number) => GRADE[(s[i % s.length] ?? 'M') as keyof typeof GRADE];

const iso = (ms: number) => new Date(ms).toISOString();
const isoSec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const unix = (ms: number) => Math.floor(ms / 1000);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hex = (s: string) => sha256Hex(`preview:dance:${s}`);

function envelope(v: Variant, base: number) {
  const text = danceTermsText(ROUTINE, STAKE);
  const terms = {
    schema_version: 1,
    bet_id: BET[v],
    escrow: { cluster: 'devnet', program_id: PROGRAM, mint: MINT },
    party_a: { pubkey: PK_A, display_name: NAMES.A },
    party_b: { pubkey: PK_B, display_name: NAMES.B },
    type: 'dance_off',
    claim: text.claim,
    performer: null,
    yes_party: 'A',
    attempts: { count: 1, rule: 'single' },
    success_criteria: text.success_criteria,
    failure_criteria: text.failure_criteria,
    edge_cases: [],
    evidence_source: 'camera',
    market: null,
    stakes: { a: STAKE, b: STAKE, currency: 'USDC' },
    deadline: isoSec(base + 900_000),
    created_at: iso(base + 1_500),
  };
  return {
    terms,
    terms_hash: hashJcs(terms),
    presentation: {
      title: `Dance off · ${ROUTINE.title}`,
      readback: `${ROUTINE.title}, fifteen seconds, side by side. Five dollars each.`,
      stakes_display: '$5 each',
      odds_display: null,
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  };
}

const FRAMES = [0, 1, 2, 3].map((i) => ({ index: i, t_ms: 2_000 + i * 3_500 }));

function evidence(v: Variant, base: number) {
  const r = RESULT[v];
  return {
    schema_version: 1,
    kind: 'dance',
    bet_id: BET[v],
    attempt_no: 1,
    terms_hash: envelope(v, base).terms_hash,
    routine: { id: ROUTINE.id, version: ROUTINE.version, sha256: routineSha256(ROUTINE) },
    scorer_version: DANCE_SCORER_VERSION,
    pose_sha256: hex(`${v}:pose`),
    pose_frames: 228,
    sync_offset_ms: 0,
    scores: { a: r.a, b: r.b },
    winner: r.winner,
    too_close: r.too_close,
    failed: null,
    key_moves: ROUTINE.key_moves.map((k, i) => ({
      id: k.id,
      a: grade(r.ga, i),
      b: grade(r.gb, i),
    })),
    checks: { coverage_a_pct: 98, coverage_b_pct: 96, max_people: 2, side_swaps: 0 },
    frames: FRAMES.map((f) => ({ ...f, sha256: hex(`${v}:f${f.index}`) })),
    clip_sha256: hex(`${v}:clip`),
  };
}

const LINE: Record<Variant, string> = {
  win: 'Logan hit eight perfect moves and owned the wave; Jake found the beat half the time.',
  tie: 'Too close to call: 78.3 to 77.1. Nobody takes this one home.',
};

function snapshot(v: Variant): BetSnapshot {
  const ref = (p: 'A' | 'B') => ({
    user_id: p === 'A' ? USER_A : USER_B,
    pubkey: (p === 'A' ? PK_A : PK_B) as never,
    display_name: NAMES[p],
    avatar_url: null,
  });
  return {
    bet_id: BET[v],
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

function sequence(v: Variant): Entry[] {
  const out: Entry[] = [];
  const bet = BET[v];
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
          bet_id: bet,
          seq: n,
          ts: iso(base + at),
          source: 'server',
          payload: payload(base),
        },
      }),
    });
  };
  const state = (
    at: number,
    s: string,
    prev: string | null,
    onchain: string | null = null,
    tx: { kind: string; signature: string; sentAt: number } | null = null,
    reason: (base: number) => string | null = () => null,
  ) =>
    frame(at, 'bet.state', (b) => ({
      state: s,
      prev,
      onchain_status: onchain,
      chain_ack: onchain ? 'rpc' : 'none',
      pending_tx: tx
        ? {
            kind: tx.kind,
            signature: tx.signature,
            submitted_at: iso(b + tx.sentAt),
            rpc_processed_at: iso(b + at - 300),
            rpc_confirmed_at: iso(b + at),
          }
        : null,
      reason: reason(b),
    }));
  const judge = (at: number, text: string) =>
    frame(at, 'judge.line', () => ({ utterance_id: uuid(++line), text, final: true }));
  const auth = (at: number, party: 'A' | 'B', count: number) =>
    frame(at, 'terms.authorized', (b) => ({
      party,
      method: 'faceid_hold',
      authorized_at: iso(b + at),
      count,
    }));
  const r = RESULT[v];

  out.push({ at: 0, action: (b) => ({ kind: 'snapshot', receivedAt: b, bet: snapshot(v) }) });
  state(0, 'DRAFTING', null);
  frame(500, 'bet.invite_answered', () => ({ party: 'B', answer: 'accepted' }));
  frame(1_500, 'terms.proposed', (b) => ({ envelope: envelope(v, b) }));
  state(1_500, 'TERMS_PROPOSED', 'DRAFTING');
  judge(1_800, `Dance off: ${ROUTINE.title}, fifteen seconds, five dollars each. Both confirm.`);
  state(5_000, 'AWAITING_AUTHORIZATIONS', 'TERMS_PROPOSED');
  auth(6_000, 'A', 1);
  auth(7_500, 'B', 2);
  state(7_500, 'AWAITING_LOCK', 'AWAITING_AUTHORIZATIONS');
  frame(8_000, 'tx.submitted', () => ({ kind: 'atomic_lock', signature: SIG.lock }));
  frame(9_000, 'tx.confirmed', () => ({
    kind: 'atomic_lock',
    signature: SIG.lock,
    slot: 400_118_245,
  }));
  state(9_000, 'LOCKED', 'AWAITING_LOCK', 'Locked');
  judge(9_300, 'Locked. Logan on the left, Jake on the right. Get both of you in the shot.');
  frame(14_000, 'attempt.started', (b) => ({
    attempt_no: 1,
    performer: 'A',
    max_ms: 15_000,
    recorder_device_id: uuid(901),
    go_at: iso(b + 16_000),
  }));
  state(14_000, 'ATTEMPT', 'LOCKED', 'Locked');
  state(31_500, 'JUDGING', 'ATTEMPT', 'Locked');
  frame(35_000, 'dance.scored', (b) => {
    const e = evidence(v, b);
    return {
      evidence: e,
      evidence_hash: hashJcs(e),
      validation: {
        verdict: 'valid',
        notes: 'Both danced the whole round, side by side.',
        skipped: false,
      },
      announcer_line: LINE[v],
    };
  });
  frame(35_000, 'ruling.issued', (b) => {
    const e = evidence(v, b);
    const decisive = !r.too_close && r.winner !== null;
    return {
      ruling: {
        schema_version: 1,
        ruling_id: uuid(701),
        bet_id: bet,
        stage: 'attempt',
        attempt_no: 1,
        outcome: decisive ? (r.winner === 'A' ? 'A_WINS' : 'B_WINS') : 'VOID',
        claim_result: decisive ? (r.winner === 'A' ? 'MET' : 'NOT_MET') : 'UNCLEAR',
        redo_reason: null,
        void_reason: decisive ? null : 'undecidable',
        confidence: 1,
        reason: LINE[v],
        cited_frames: [],
        frame_hashes: e.frames.map((f) => f.sha256),
        model: DANCE_OFF_MODEL,
        evidence_hash: hashJcs(e),
        terms_hash: e.terms_hash,
        created_at: iso(b + 35_000),
      },
      ruling_hash: hex(`${v}:ruling`),
    };
  });
  const resolve = { kind: 'resolve', signature: SIG.resolve, sentAt: 35_200 };
  state(36_000, 'RULED', 'JUDGING', 'Resolved', resolve, (b) =>
    v === 'win' ? `appeal_deadline=${unix(b + 36_000) + 10}` : null,
  );
  frame(36_000, 'tx.confirmed', () => ({
    kind: 'resolve',
    signature: SIG.resolve,
    slot: 400_118_290,
  }));
  const pay = { kind: 'finalize', signature: SIG.pay, sentAt: 47_000 };
  if (v === 'win') {
    state(47_000, 'FINALIZED', 'RULED', 'Resolved', pay);
    state(47_600, 'PAID', 'FINALIZED', 'Settled', pay);
    judge(47_900, 'Paid. Logan takes ten dollars. Good dancing, Jake.');
  } else {
    state(42_000, 'VOIDED', 'RULED', 'Refunded', { ...pay, sentAt: 41_500 });
    judge(42_300, 'Both stakes are back. Run it back with double or nothing?');
  }
  return out.sort((x, y) => x.at - y.at);
}

const SEQUENCES: Record<Variant, Entry[]> = { win: sequence('win'), tie: sequence('tie') };

/**
 * The dance sample at a moment: `preview` is the `?preview=` value ('dance' / 'dance-tie' loop
 * from `startMs`, 'dance-<step>' / 'dance-tie-<step>' freeze on that step). Returns the state and
 * the clock to render it with.
 */
export function previewDanceAt(
  startMs: number,
  nowMs: number,
  preview: string = DANCE_PREVIEW,
): { state: TickerState; now: number; t: number } {
  let rest = preview.startsWith(`${DANCE_PREVIEW}-`) ? preview.slice(DANCE_PREVIEW.length + 1) : '';
  let variant: Variant = 'win';
  if (rest === 'tie' || rest.startsWith('tie-')) {
    variant = 'tie';
    rest = rest.slice(4);
  }
  const frozen = rest && rest in DANCE_STEPS ? DANCE_STEPS[rest as DanceStep] : null;
  const t = frozen ?? (((nowMs - startMs) % DANCE_LOOP_MS) + DANCE_LOOP_MS) % DANCE_LOOP_MS;
  const now = frozen !== null ? startMs + frozen : nowMs;
  const base = now - t;
  let s: TickerState = initialTicker;
  for (const e of SEQUENCES[variant]) {
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
