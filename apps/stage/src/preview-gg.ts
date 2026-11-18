// `?preview=gg…` / `?preview=review…`: the GG moment and the spoken review request, played on
// the preview's bottle flip (preview.ts) from its frozen ruling (Jake wins, Logan has the appeal
// window). Every frame goes through applyFrame() and parses with the shared schemas, like the
// main preview. Fixture signatures: the QR codes point at transactions that do not exist.
//
//   ?preview=gg                 loops: Logan says GG -> the record ticks over -> the payout lands
//   ?preview=gg-stamp           frozen: the stamp just landed (the record not ticked yet)
//   ?preview=gg-record          frozen: the record ticked over, the payout on its way
//   ?preview=gg-paid            frozen: paid, the count-up done
//   ?preview=gg-done            frozen: after the moment: the PAID panel says GG
//   ?preview=gg-reverted        frozen: the concede failed ("GG didn't go through")
//   ?preview=review             loops: review requested -> Logan confirms -> the panel votes
//   ?preview=review-open        frozen: "REVIEW REQUESTED · Logan confirms on their phone · 0:04"
//   ?preview=review-confirmed   frozen: Logan confirmed (the appeal tx is on its way)
//   ?preview=review-panel       frozen: the three-judge panel voting (the banner gave way)
//   ?preview=review-declined    frozen: Logan kept the ruling
//   ?preview=review-lapsed      frozen: not confirmed by confirm_by
import { recordAfter, type PairRecord } from '@youre-on/shared/gg';
import { previewAt, PREVIEW_STEPS, type PreviewFrame } from './preview';
import { applyFrame, type TickerState } from './ticker';

/** The ruling the scenes start from (ms into the main preview loop). */
const RULED_AT = PREVIEW_STEPS.ruling;
export const GG_LOOP_MS = 14_000;

const SIG = {
  concede:
    '5YfzgMAJighSxt31VtKrY5QyMje8K1SZdJNZCJzGqjvwpaeZnfqxECZvTF9LJ6EP4rGBpzNMQAwZRGAnSZvwN7iQ',
  appeal:
    '3H47D8VyL2CAvoGn2sKpCWu7XHy6cKbCRW9kTusMr4mtq8qDcAHbsAxA2MywMkKd7HbK3dHkJFxZ3FLXVU8jX7oF',
};
const PK = {
  A: 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4',
  B: 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr',
  X: 'B1Qtn1Zk68Sqx2rFDNdqGbMv5m5t4pCKU2P1MDjZ7NWi',
  MINT: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

/** Logan 7-4 Jake before this bet, Jake on a two-bet run: rivals. */
export const PREVIEW_RECORD_BEFORE: PairRecord = {
  a_wins: 7,
  b_wins: 4,
  pushes: 0,
  total: 11,
  streak: { party: 'B', length: 2 },
  rival: true,
  includes_seed: false,
};

type Scene = 'gg' | 'gg-reverted' | 'review' | 'review-declined' | 'review-lapsed';

/** Frozen steps: the scene and the ms into it (null = loop the scene). */
export const GG_PREVIEW_STEPS: Record<string, { scene: Scene; at: number | 'lapsed' | null }> = {
  gg: { scene: 'gg', at: null },
  'gg-stamp': { scene: 'gg', at: 1_150 },
  'gg-record': { scene: 'gg', at: 2_200 },
  'gg-paid': { scene: 'gg', at: 4_400 },
  'gg-done': { scene: 'gg', at: 10_000 },
  'gg-reverted': { scene: 'gg-reverted', at: 2_600 },
  review: { scene: 'review', at: null },
  'review-open': { scene: 'review', at: 2_500 },
  'review-confirmed': { scene: 'review', at: 3_500 },
  'review-panel': { scene: 'review', at: 7_400 },
  'review-declined': { scene: 'review-declined', at: 3_400 },
  'review-lapsed': { scene: 'review-lapsed', at: 'lapsed' },
};
export const isGgPreview = (s: string | null | undefined): s is string =>
  !!s && Object.prototype.hasOwnProperty.call(GG_PREVIEW_STEPS, s);

const iso = (ms: number) => new Date(ms).toISOString();
const unix = (ms: number) => Math.floor(ms / 1000);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface Step {
  at: number;
  type: string;
  payload: unknown;
}

function vote(betId: string, r: number, at: number, seat: number) {
  const v = [
    ['anthropic', 'anthropic/claude-sonnet-5-5', 0.91, 'Two full rotations; upright on its base.'],
    ['openai', 'openai/gpt-5.5', 0.88, 'Lands upright in frame 7 and stays there.'],
    ['google', 'google/gemini-3-pro', 0.84, 'Clean landing on the base. The ruling holds.'],
  ][seat] as [string, string, number, string];
  return {
    vote: {
      schema_version: 1,
      appeal_id: uuid(0xa11),
      bet_id: betId,
      seat,
      provider: v[0],
      model: v[1],
      status: 'ok',
      outcome: 'B_WINS',
      confidence: v[2],
      reason: v[3],
      counted_as: 'B_WINS',
      latency_ms: 2_400 + seat * 700,
      created_at: iso(r + at),
    },
  };
}

function steps(scene: Scene, betId: string, r: number, deadlineMs: number): Step[] {
  const out: Step[] = [];
  const add = (at: number, type: string, payload: unknown) => out.push({ at, type, payload });
  const state = (
    at: number,
    s: string,
    prev: string,
    tx: { kind: string; signature: string; sentAt: number; confirmed: boolean } | null,
    reason: string | null = null,
  ) =>
    add(at, 'bet.state', {
      state: s,
      prev,
      onchain_status: 'Resolved',
      chain_ack: 'rpc',
      pending_tx: tx && {
        kind: tx.kind,
        signature: tx.signature,
        submitted_at: iso(r + tx.sentAt),
        rpc_processed_at: tx.confirmed ? iso(r + at - 300) : null,
        rpc_confirmed_at: tx.confirmed ? iso(r + at) : null,
      },
      reason,
    });
  const meta = (signature: string, at: number) => ({
    signature,
    slot: 400_118_400 + Math.round(at / 400),
    block_height: null,
    outer_ix: 2,
    inner_ix: 0,
    block_time: unix(r + at),
    observed_via: 'quicknode_stream',
  });
  const judge = (at: number, n: number, text: string) =>
    add(at, 'judge.line', { utterance_id: uuid(0x900 + n), text, final: true });

  if (scene === 'gg' || scene === 'gg-reverted') {
    const concede = { kind: 'concede', signature: SIG.concede, sentAt: 1_000, confirmed: false };
    state(1_000, 'CONCEDED', 'RULED', concede);
    add(1_000, 'tx.submitted', { kind: 'concede', signature: SIG.concede });
    add(1_000, 'bet.gg', {
      by: 'A',
      winner: 'B',
      to_a: '0',
      to_b: '10000000',
      record: {
        before: PREVIEW_RECORD_BEFORE,
        after: recordAfter(PREVIEW_RECORD_BEFORE, 'B'),
      },
      conceded_at: iso(r + 1_000),
    });
    if (scene === 'gg-reverted') {
      state(2_200, 'RULED', 'CONCEDED', null, 'concede_failed');
      return out;
    }
    state(2_600, 'PAID', 'CONCEDED', { ...concede, confirmed: true });
    add(2_600, 'tx.confirmed', { kind: 'concede', signature: SIG.concede, slot: 400_118_410 });
    add(2_600, 'judge.cue', {
      cue: 'PAID',
      text: '[EVENT] PAID winner=Jake amount=$10.00 to_a=$0.00 to_b=$10.00 via=gg loser=Logan record="Logan 7-5 Jake" :: Logan said GG. Praise the sportsmanship in one short line, then congratulate Jake.',
      speak: true,
    });
    add(2_900, 'chain.BetConceded', {
      ...meta(SIG.concede, 2_900),
      bet_id: betId,
      final_status: 'Settled',
      outcome: 'PartyB',
      mint: PK.MINT,
      party_a: PK.A,
      party_b: PK.B,
      party_a_token: '11111111111111111111111111111111',
      party_b_token: PK.B,
      to_a: '0',
      to_b: '10000000',
      ts: unix(r + 2_900),
      conceded_by: PK.A,
    });
    judge(3_600, 1, 'Classy GG, Logan. Jake takes ten dollars.');
    return out;
  }

  // the review scenes: someone said "check that again" right after the ruling
  const confirmBy = deadlineMs - 1_000;
  const reviewId = uuid(0x7e1);
  add(800, 'review.requested', {
    review_id: reviewId,
    for_party: 'A',
    source: 'voice',
    requested_at: iso(r + 800),
    confirm_by: iso(confirmBy),
  });
  judge(1_100, 1, 'Review requested. Logan, confirm on your phone.');
  if (scene === 'review-declined') {
    add(3_000, 'review.closed', { review_id: reviewId, reason: 'declined' });
    return out;
  }
  if (scene === 'review-lapsed') {
    add(confirmBy - r + 150, 'review.closed', { review_id: reviewId, reason: 'lapsed' });
    return out;
  }
  const appeal = { kind: 'appeal', signature: SIG.appeal, sentAt: 3_200, confirmed: true };
  add(3_200, 'tx.submitted', { kind: 'appeal', signature: SIG.appeal });
  state(3_900, 'APPEALED', 'RULED', appeal);
  add(4_100, 'chain.BetAppealed', {
    ...meta(SIG.appeal, 4_100),
    bet_id: betId,
    appellant: PK.A,
    original_outcome: 'PartyB',
    appeal_resolve_deadline: unix(r) + 300,
    ts: unix(r + 4_100),
  });
  add(6_000, 'appeal.vote', vote(betId, r, 6_000, 0));
  add(7_000, 'appeal.vote', vote(betId, r, 7_000, 1));
  add(9_000, 'appeal.vote', vote(betId, r, 9_000, 2));
  return out;
}

/**
 * The stage at a moment of a GG / review scene. `startMs` anchors the main preview (as
 * previewAt); the scene starts at its frozen ruling.
 */
export function previewGgAt(startMs: number, nowMs: number, step: string): PreviewFrame {
  const def = GG_PREVIEW_STEPS[step] ?? GG_PREVIEW_STEPS.gg!;
  const ruled = previewAt(startMs, startMs, 'ruling');
  const r = startMs + RULED_AT;
  let s: TickerState = ruled.state;
  const betId = s.focusBetId!;
  const deadlineMs = (s.bets[betId]?.appeal_deadline ?? unix(r) + 7) * 1000;
  const scene = steps(def.scene, betId, r, deadlineMs).sort((x, y) => x.at - y.at);
  const t =
    def.at === 'lapsed'
      ? deadlineMs - 1_000 - r + 900
      : (def.at ?? (((nowMs - startMs) % GG_LOOP_MS) + GG_LOOP_MS) % GG_LOOP_MS);
  let seq = s.lastSeq[betId] ?? 0;
  for (const e of scene) {
    if (e.at > t) break;
    s = applyFrame(s, {
      kind: 'frame',
      receivedAt: r + e.at,
      raw: {
        v: 1,
        type: e.type,
        bet_id: betId,
        seq: ++seq,
        ts: iso(r + e.at),
        source: e.type.startsWith('chain.') ? 'chain' : 'server',
        payload: e.payload,
      },
    });
  }
  return { t, now: r + t, state: s };
}
