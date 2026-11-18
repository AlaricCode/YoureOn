// SCHEMAS §4.1 — the slow-mo replay: which frames play, which one is held, the schedule.
import { describe, expect, it } from 'vitest';
import type { CameraEvidence } from '../src/evidence';
import { judgeFrameTimesMs } from '../src/judge/frames';
import { sha256Hex } from '../src/primitives';
import {
  buildFoulReplay,
  buildWinReplay,
  clipPlan,
  ReplayClip,
  ReplayFoulInput,
  ReplayMoment,
  ReplayResponse,
  slowmoDwellMs,
  slowmoFrameAt,
  slowmoTimeline,
  SLOWMO_HOLD_MS,
  SLOWMO_INTRO_MS,
  SLOWMO_RATE,
  type WinReplayInput,
} from '../src/replay';
import { GEMINI_SETTLEMENT_MODEL, Ruling } from '../src/ruling';
import { HearingRuling } from '../src/hearing';
import { hearingRulingExample, rulingExample } from './fixtures';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const HASH = 'a'.repeat(64);
const DURATION = 4000;

/** A D10 upload: 12 frames from the shared sampler (4 lead-in, 8 landing) + the landing crop. */
function evidence(n = 12, crop = true): CameraEvidence {
  const times = judgeFrameTimesMs(DURATION, n);
  const frames: CameraEvidence['frames'] = times.map((t, i) => ({
    index: i,
    t_ms: t,
    sha256: sha256Hex(`f${i}`),
  }));
  if (crop)
    frames.push({
      index: n,
      t_ms: times.at(-1)!,
      sha256: sha256Hex(`f${n}`),
      landing_crop: true,
    });
  return {
    schema_version: 1,
    kind: 'camera',
    bet_id: BET,
    attempt_no: 2,
    clip_sha256: HASH,
    clip_bytes: 1_000_000,
    mime: 'video/mp4',
    duration_ms: DURATION,
    recorded_by: 'A',
    recorded_at: '2026-11-21T18:07:00.000Z',
    frames,
  };
}

function ruling(ev: CameraEvidence, over: Partial<Ruling> = {}): Ruling {
  return Ruling.parse({
    ...rulingExample(),
    attempt_no: ev.attempt_no,
    frame_hashes: ev.frames.map((f) => f.sha256),
    cited_frames: [12],
    outcome: 'B_WINS',
    ...over,
  });
}

function input(over: Partial<WinReplayInput> = {}, rOver: Partial<Ruling> = {}): WinReplayInput {
  const ev = over.evidence ?? evidence();
  const r = over.ruling ?? ruling(ev, rOver);
  return {
    bet_id: BET,
    evidence: ev,
    ruling: r,
    ruling_hash: HASH,
    final_outcome: r.outcome,
    attempt_frame_hashes: ev.frames.map((f) => f.sha256),
    ...over,
  };
}

const idxs = (m: ReplayMoment | null) => m!.frames.map((f) => f.idx);

describe('buildWinReplay: frame selection and the hold', () => {
  it('12 + crop: the last lead-in frame, the 8 landing frames and the crop, in order; a cited crop is held', () => {
    const m = buildWinReplay(input())!;
    expect(ReplayMoment.parse(m)).toEqual(m);
    expect(idxs(m)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(m.hold_source).toBe('judge_cited');
    expect(m.frames.at(-1)).toMatchObject({ idx: 12, landing_crop: true, cited: true });
    expect(m.moment_ms).toBe(m.frames.at(-1)!.t_ms);
    expect(m.winner).toBe('B');
    expect(m.kind).toBe('win');
    expect(m.reason).toBe(rulingExample().reason);
    expect(m.frames[0]!.path).toBe(`/v1/bets/${BET}/attempts/2/frames/3`);
    expect(m.frames.every((f) => f.url === null)).toBe(true);
  });

  it('citing frame 9 cuts the sequence at 9', () => {
    const m = buildWinReplay(input({}, { cited_frames: [9, 7] }))!;
    expect(idxs(m)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(m.hold_source).toBe('judge_cited');
    expect(m.frames.filter((f) => f.cited).map((f) => f.idx)).toEqual([7, 9]);
  });

  it('a cited lead-in frame is inserted in time order', () => {
    const m = buildWinReplay(input({}, { cited_frames: [1, 9] }))!;
    expect(idxs(m)).toEqual([1, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('at least 3 frames are kept before the held one', () => {
    // holding frame 4 (the first landing frame) would leave only the lead-in before it
    expect(idxs(buildWinReplay(input({}, { cited_frames: [4] })))).toEqual([1, 2, 3, 4]);
    // a held lead-in frame: the earlier frames it has (only 2 before frame 2)
    expect(idxs(buildWinReplay(input({}, { cited_frames: [2] })))).toEqual([0, 1, 2]);
  });

  it('an appeal that flipped the outcome holds on the crop (last_frame) for the FINAL winner, with no judge reason', () => {
    const m = buildWinReplay(input({ final_outcome: 'A_WINS' }, { cited_frames: [9] }))!;
    expect(m.winner).toBe('A');
    expect(m.hold_source).toBe('last_frame');
    expect(idxs(m)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(m.reason).toBeNull();
  });

  it('nothing cited: holds on the crop as last_frame', () => {
    const m = buildWinReplay(input({}, { cited_frames: [] }))!;
    expect(m.hold_source).toBe('last_frame');
    expect(m.frames.at(-1)!.idx).toBe(12);
  });

  it('an older 8-frame upload with no crop works (holds on its last frame if nothing cited)', () => {
    const ev = evidence(8, false);
    const m = buildWinReplay(input({ evidence: ev }, { cited_frames: [] }))!;
    expect(m.frames.length).toBeGreaterThanOrEqual(4);
    expect(m.frames.some((f) => f.landing_crop)).toBe(false);
    expect(m.frames.at(-1)!.idx).toBe(7);
    expect(m.hold_source).toBe('last_frame');
    const cited = buildWinReplay(input({ evidence: ev }, { cited_frames: [6] }))!;
    expect(cited.frames.at(-1)!.idx).toBe(6);
    expect(cited.hold_source).toBe('judge_cited');
  });

  it('a hearing ruling whose frame hashes do not match the attempt marks nothing cited', () => {
    const ev = evidence();
    const h = HearingRuling.parse({
      ...hearingRulingExample(),
      outcome: 'B_WINS',
      cited_frames: [5],
      frame_hashes: ev.frames.map((_, i) => sha256Hex(`other${i}`)),
    });
    const m = buildWinReplay(input({ evidence: ev, ruling: h, final_outcome: 'B_WINS' }))!;
    expect(m.frames.some((f) => f.cited)).toBe(false);
    expect(m.hold_source).toBe('last_frame');
    // the same hearing over this attempt's frames: its citation counts
    const ok = HearingRuling.parse({ ...h, frame_hashes: ev.frames.map((f) => f.sha256) });
    const m2 = buildWinReplay(input({ evidence: ev, ruling: ok, final_outcome: 'B_WINS' }))!;
    expect(m2.frames.at(-1)!.idx).toBe(5);
    expect(m2.hold_source).toBe('judge_cited');
  });

  it('REDO, VOID, a non-decisive final outcome and Gemini settlements give no replay', () => {
    expect(
      buildWinReplay(
        input(
          {},
          { outcome: 'REDO', redo_reason: 'unclear', confidence: 0.4, claim_result: 'UNCLEAR' },
        ),
      ),
    ).toBeNull();
    expect(buildWinReplay(input({}, { outcome: 'VOID', void_reason: 'max_redos' }))).toBeNull();
    expect(buildWinReplay(input({ final_outcome: 'VOID' }))).toBeNull();
    // a VOID an appeal turned into a win: the frames, held on the last one, no judge reason
    const voidRuling = ruling(evidence(), { outcome: 'VOID', void_reason: 'max_redos' });
    const flippedVoid = buildWinReplay(input({ ruling: voidRuling, final_outcome: 'A_WINS' }))!;
    expect(flippedVoid.winner).toBe('A');
    expect(flippedVoid.hold_source).toBe('last_frame');
    expect(flippedVoid.reason).toBeNull();
    const ev = evidence();
    const gemini = {
      ...ruling(ev),
      model: GEMINI_SETTLEMENT_MODEL,
      frame_hashes: [],
      cited_frames: [],
    };
    expect(buildWinReplay(input({ evidence: ev, ruling: gemini }))).toBeNull();
  });
});

describe('schema refinements', () => {
  const win = () => buildWinReplay(input())!;
  const foulFields = {
    kind: 'foul',
    hold_source: 'detector',
    foul: { label: 'Toe 17 cm over', measure_cm: 17, detector: 'sam3/fal@1' },
    reason: null,
  };

  it('a foul needs its label; a win has none', () => {
    expect(ReplayMoment.safeParse({ ...win(), ...foulFields }).success).toBe(true);
    expect(ReplayMoment.safeParse({ ...win(), ...foulFields, foul: null }).success).toBe(false);
    expect(
      ReplayMoment.safeParse({ ...win(), ...foulFields, foul: { ...foulFields.foul, label: '' } })
        .success,
    ).toBe(false);
    expect(ReplayMoment.safeParse({ ...win(), foul: foulFields.foul }).success).toBe(false);
  });

  it('detector holds are foul-only, and a foul holds on the detector', () => {
    expect(ReplayMoment.safeParse({ ...win(), hold_source: 'detector' }).success).toBe(false);
    expect(
      ReplayMoment.safeParse({ ...win(), ...foulFields, hold_source: 'judge_cited' }).success,
    ).toBe(false);
  });

  it('frames or a clip; t_ms never decreases', () => {
    expect(ReplayMoment.safeParse({ ...win(), frames: [] }).success).toBe(false);
    const m = win();
    const frames = [...m.frames];
    frames[1] = { ...frames[1]!, t_ms: 0 };
    expect(ReplayMoment.safeParse({ ...m, frames }).success).toBe(false);
  });

  it('why = ready iff a replay is there', () => {
    expect(ReplayResponse.safeParse({ replay: win(), why: 'ready', final: true }).success).toBe(
      true,
    );
    expect(ReplayResponse.safeParse({ replay: null, why: 'ready', final: true }).success).toBe(
      false,
    );
    expect(ReplayResponse.safeParse({ replay: win(), why: 'purged', final: true }).success).toBe(
      false,
    );
    expect(ReplayResponse.safeParse({ replay: null, why: 'not_ruled', final: false }).success).toBe(
      true,
    );
  });

  it('a clip keeps from ≤ moment ≤ to', () => {
    const clip = {
      url: 'https://storage.example/clip.mp4?sig=1',
      expires_at: '2026-11-21T18:20:00.000Z',
      mime: 'video/mp4',
      source_rate: 1,
      from_ms: 2000,
      moment_ms: 3500,
      to_ms: 4000,
      overlays_burned: false,
    };
    expect(ReplayClip.safeParse(clip).success).toBe(true);
    expect(ReplayClip.safeParse({ ...clip, moment_ms: 4500 }).success).toBe(false);
  });
});

describe('buildFoulReplay (the detector contract)', () => {
  const base = () => buildWinReplay(input())!;
  const foul = (over: Partial<ReplayFoulInput> = {}): ReplayFoulInput => ({
    moment_ms: 1400,
    foul: { label: 'Toe 17 cm over', measure_cm: 17, detector: 'sam3/fal@1' },
    frames: [],
    clip: null,
    ...over,
  });

  it('from the attempt frames near the moment: held there, labelled, no judge reason', () => {
    const ev = evidence();
    const m = buildFoulReplay(base(), foul(), ev)!;
    expect(ReplayMoment.parse(m)).toEqual(m);
    expect(m).toMatchObject({
      kind: 'foul',
      hold_source: 'detector',
      moment_ms: 1400,
      reason: null,
    });
    expect(m.foul!.label).toBe('Toe 17 cm over');
    const held = m.frames.at(-1)!;
    const nearest = ev.frames.reduce((a, f) =>
      Math.abs(f.t_ms - 1400) < Math.abs(a.t_ms - 1400) ? f : a,
    );
    expect(held.idx).toBe(nearest.index);
    expect(m.frames.some((f) => f.cited)).toBe(false);
  });

  it("the detector's render: a pre-slowed clip with overlays burned in", () => {
    const clip = {
      url: 'https://storage.example/foul.mp4?sig=1',
      expires_at: '2026-11-21T18:20:00.000Z',
      mime: 'video/mp4' as const,
      source_rate: 0.25,
      from_ms: 0,
      moment_ms: 5600,
      to_ms: 8000,
      overlays_burned: true,
    };
    const m = buildFoulReplay(base(), foul({ clip }))!;
    expect(m.frames).toEqual([]);
    expect(m.clip).toEqual(clip);
  });

  it('an unconfirmed / malformed detector result gives nothing (no fake fouls)', () => {
    expect(
      buildFoulReplay(base(), { ...foul(), foul: { label: '', measure_cm: null, detector: 'x' } }),
    ).toBeNull();
    // nothing to show: no stills, no clip, no evidence
    expect(buildFoulReplay(base(), foul())).toBeNull();
  });
});

describe('slowmoTimeline', () => {
  const frames = (ts: number[], crop = false) =>
    ts.map((t, i) => ({
      idx: i,
      t_ms: t,
      landing_crop: crop && i === ts.length - 1,
      cited: false,
      path: `/v1/bets/${BET}/attempts/1/frames/${i}`,
      url: null,
    }));

  it('a 150 ms gap plays for 600 ms; clamps at 450 and 900', () => {
    expect(slowmoDwellMs(150)).toBe(600);
    expect(slowmoDwellMs(150) * SLOWMO_RATE).toBe(150);
    expect(slowmoDwellMs(0)).toBe(450);
    expect(slowmoDwellMs(40)).toBe(450);
    expect(slowmoDwellMs(2000)).toBe(900);
  });

  it('the typical 12-frame upload runs about 8.65 s, the hold last', () => {
    const m = buildWinReplay(input())!;
    const tl = slowmoTimeline(m);
    expect(tl.steps).toHaveLength(10);
    expect(tl.steps[0]!.at_ms).toBe(SLOWMO_INTRO_MS);
    expect(tl.steps[0]!.dwell_ms).toBe(900); // the lead-in frame, ~0.8 s before the window
    expect(tl.steps.slice(1, 8).map((s) => s.dwell_ms)).toEqual(Array(7).fill(600));
    expect(tl.steps[8]!.dwell_ms).toBe(450); // the last frame -> its crop (same instant)
    expect(tl.steps.at(-1)!.dwell_ms).toBe(SLOWMO_HOLD_MS);
    expect(tl.total_ms).toBe(500 + 900 + 7 * 600 + 450 + 2600);
    expect(tl.total_ms / 1000).toBeCloseTo(8.65, 2);
    expect(tl.hold_at_ms).toBe(tl.steps.at(-1)!.at_ms + 700); // the crop's closing zoom
    // zoom: 1 -> 1.08 over the sequence, then on to 1.14 during the hold
    expect(tl.steps[0]!.scale_from).toBe(1);
    expect(tl.steps.at(-1)!.scale_to).toBe(1.14);
    for (let i = 1; i < tl.steps.length; i++)
      expect(tl.steps[i]!.scale_from).toBeGreaterThanOrEqual(tl.steps[i - 1]!.scale_from);
  });

  it('reduced motion: no zoom, no cross-fades', () => {
    const tl = slowmoTimeline({ frames: frames([0, 150, 300], true) }, { reduceMotion: true });
    expect(tl.steps.every((s) => s.scale_from === 1 && s.scale_to === 1 && s.xfade_ms === 0)).toBe(
      true,
    );
    expect(tl.hold_at_ms).toBe(tl.steps.at(-1)!.at_ms);
  });

  it('slowmoFrameAt: black intro, cross-fade, then the held frame alone', () => {
    const tl = slowmoTimeline({ frames: frames([0, 150, 300]) });
    expect(slowmoFrameAt(tl, 0).current).toBe(-1);
    expect(slowmoFrameAt(tl, 0).frames.every((f) => f.opacity === 0)).toBe(true);
    const mid = slowmoFrameAt(tl, tl.steps[1]!.at_ms + 110);
    expect(mid.current).toBe(1);
    expect(mid.frames[0]!.opacity).toBe(1); // under the incoming frame
    expect(mid.frames[1]!.opacity).toBeCloseTo(0.5, 2);
    const hold = slowmoFrameAt(tl, tl.hold_at_ms + 10);
    expect(hold.holding).toBe(true);
    expect(hold.frames.map((f) => f.opacity)).toEqual([0, 0, 1]);
    expect(slowmoFrameAt(tl, tl.total_ms).frames[2]!.scale).toBe(1.14);
  });
});

describe('clipPlan', () => {
  const clip = (source_rate: number) =>
    ReplayClip.parse({
      url: 'https://storage.example/c.mp4',
      expires_at: '2026-11-21T18:20:00.000Z',
      mime: 'video/mp4',
      source_rate,
      from_ms: 1000,
      moment_ms: 2500,
      to_ms: 3000,
      overlays_burned: false,
    });
  it('a real-time source plays at 0.25x, a pre-slowed render at 1x', () => {
    expect(clipPlan(clip(1))).toEqual({
      playbackRate: 0.25,
      seekMs: 1000,
      freezeAtMs: 2500,
      endMs: 3000,
    });
    expect(clipPlan(clip(0.25)).playbackRate).toBe(1);
  });
});
