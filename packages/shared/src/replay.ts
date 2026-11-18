// SCHEMAS §4.1 — the slow-mo replay after a bet: the winning moment from the judge's own evidence
// frames (now), the real clip at quarter speed (once a clip URL exists), or a detector-confirmed
// foul frozen at its moment (once a ReplayFoulSource is wired: apps/server/src/replay/fouls.ts).
// One implementation for the server (GET /v1/bets/:bet_id/replay), the stage and the phones.
//
//   win, frames   the landing-window frames of the deciding attempt (+ the last lead-in frame for
//                 context, + the landing crop as the closing zoom), played at SLOWMO_RATE of their
//                 real spacing, ending and holding on the judge's decisive cited frame.
//   win, clip     clip.url played at SLOWMO_RATE (or 1x for a pre-slowed render) over
//                 [from_ms, to_ms], frozen at moment_ms.
//   foul          only from a confirmed detector result (ReplayFoulInput). Nothing here derives a
//                 foul from the ruling: the ruling has no structured foul, and its free-text
//                 `reason` is never parsed.
//
// Pure TS (zod only): it runs on the server, in the stage page and on the phone.
import { z } from 'zod/v4';
import { CameraEvidence, FrameIndex } from './evidence';
import { isLandingFrame } from './judge/frames';
import { BetId, Hex32, IsoUtc, NText, Party } from './primitives';
import { GEMINI_SETTLEMENT_MODEL, type Ruling, type RulingOutcome } from './ruling';
import type { HearingRuling } from './hearing';

export const REPLAY_SCHEMA_VERSION = 1 as const;
/** Playback speed of real-time material (frames' spacing, a raw clip). */
export const SLOWMO_RATE = 0.25;
export const SLOWMO_DWELL_MIN_MS = 450;
export const SLOWMO_DWELL_MAX_MS = 900;
export const SLOWMO_XFADE_MS = 220;
export const SLOWMO_INTRO_MS = 500;
export const SLOWMO_HOLD_MS = 2600;
/** The landing crop is the closing zoom: it fades in over this long (instead of SLOWMO_XFADE_MS). */
export const SLOWMO_CROP_MS = 700;
export const SLOWMO_ZOOM = { from: 1, to: 1.08, holdTo: 1.14 } as const;
/** Frames kept before the held one when the cut would leave fewer (if the attempt has them). */
export const SLOWMO_MIN_BEFORE = 3;

export const ReplayKind = z.enum(['win', 'foul']);
export type ReplayKind = z.infer<typeof ReplayKind>;
export const ReplayHoldSource = z.enum(['judge_cited', 'last_frame', 'detector']);
export type ReplayHoldSource = z.infer<typeof ReplayHoldSource>;

export const ReplayFrame = z.strictObject({
  /** CameraEvidence.frames index (= attempt_frames.idx); null for a detector still. */
  idx: FrameIndex.nullable(),
  /** ms from clip start (the crop carries the last frame's t_ms). */
  t_ms: z.number().int().nonnegative(),
  landing_crop: z.boolean(),
  /** In the deciding ruling's cited_frames. */
  cited: z.boolean(),
  /** Server-relative GET with the caller's bearer (party app session / the room's stage session). */
  path: z.string().startsWith('/v1/bets/').max(200),
  /** Absolute, signed, short-lived GET once object storage exists; null today. Preferred when set. */
  url: z.url().nullable(),
});
export type ReplayFrame = z.infer<typeof ReplayFrame>;

export const ReplayClip = z
  .strictObject({
    url: z.url(), // signed GET
    expires_at: IsoUtc,
    mime: z.enum(['video/mp4', 'video/quicktime']),
    /** 1 = real time (player slows to SLOWMO_RATE); < 1 = already slowed (SAM render: 0.25). */
    source_rate: z.number().positive().max(1),
    /** All three in THIS file's timeline. */
    from_ms: z.number().int().nonnegative(),
    moment_ms: z.number().int().nonnegative(),
    to_ms: z.number().int().positive(),
    /** Boxes / line / FOUL text already drawn into the video: the player adds no overlay text. */
    overlays_burned: z.boolean(),
  })
  .refine((c) => c.from_ms <= c.moment_ms && c.moment_ms <= c.to_ms, 'from ≤ moment ≤ to');
export type ReplayClip = z.infer<typeof ReplayClip>;

export const ReplayFoul = z.strictObject({
  /** Display data, e.g. 'Toe 17 cm over'. */
  label: NText(40),
  measure_cm: z.number().nonnegative().nullable(),
  /** e.g. 'sam3/fal@1'. */
  detector: z.string().min(1).max(80),
});
export type ReplayFoul = z.infer<typeof ReplayFoul>;

export const ReplayMoment = z
  .strictObject({
    schema_version: z.literal(REPLAY_SCHEMA_VERSION),
    bet_id: BetId,
    attempt_no: z.number().int().min(1),
    kind: ReplayKind,
    /** The FINAL winner (appeal final_outcome when there was one, else the ruling's). */
    winner: Party,
    /** The moment, ms from the original clip's start (win: the held frame's t_ms). */
    moment_ms: z.number().int().nonnegative(),
    hold_source: ReplayHoldSource,
    /** Play order, t_ms non-decreasing; the LAST frame is the one held. */
    frames: z.array(ReplayFrame).max(24),
    clip: ReplayClip.nullable(),
    foul: ReplayFoul.nullable(),
    /** The ruling this illustrates; `model` lets the stage keep its "replay ruling" label (isCachedRulingModel). */
    ruling_hash: Hex32,
    model: z.string().min(1).max(80),
    /**
     * The judge's spoken reason (data); null for a foul, and null when an appeal overturned the
     * ruling (its reason argued for the side that lost).
     */
    reason: NText(280).nullable(),
  })
  .superRefine((m, ctx) => {
    const bad = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if ((m.kind === 'foul') !== (m.foul !== null)) bad('foul', 'set iff kind = foul');
    if (m.kind === 'foul' && m.hold_source !== 'detector')
      bad('hold_source', 'a foul holds on the detector moment');
    if (m.kind === 'win' && m.hold_source === 'detector')
      bad('hold_source', 'detector is foul-only');
    if (m.frames.length === 0 && m.clip === null) bad('frames', 'frames or a clip');
    if (m.frames.some((f, i) => i > 0 && f.t_ms < m.frames[i - 1]!.t_ms))
      bad('frames', 't_ms must not decrease');
  });
export type ReplayMoment = z.infer<typeof ReplayMoment>;

export const ReplayWhy = z.enum(['ready', 'not_ruled', 'no_winner', 'no_frames', 'purged']);
export type ReplayWhy = z.infer<typeof ReplayWhy>;
/** GET /v1/bets/:bet_id/replay -> 200. why = 'ready' iff replay !== null. */
export const ReplayResponse = z
  .strictObject({ replay: ReplayMoment.nullable(), why: ReplayWhy, final: z.boolean() })
  .refine((r) => (r.why === 'ready') === (r.replay !== null), 'why/replay mismatch');
export type ReplayResponse = z.infer<typeof ReplayResponse>;

export const replayPath = (betId: string) => `/v1/bets/${encodeURIComponent(betId)}/replay`;
export const replayFramePath = (betId: string, n: number, idx: number) =>
  `/v1/bets/${encodeURIComponent(betId)}/attempts/${n}/frames/${idx}`;

/**
 * What a foul detector (Alaric's SAM 3.1 tracking: apps/server/src/replay/fouls.ts
 * ReplayFoulSource) hands to buildFoulReplay. ONLY a confirmed foul (his confirmFoul at
 * confidence ≥ 0.7): anything suspected or unconfirmed is not passed at all.
 */
export const ReplayFoulInput = z.strictObject({
  /** Original clip timeline (release ± foul). */
  moment_ms: z.number().int().nonnegative(),
  /** label 'Toe 17 cm over', measure_cm, detector. */
  foul: ReplayFoul,
  /** VR stills via his GET, or attempt frames. Empty: the attempt's own frames near moment_ms. */
  frames: z.array(ReplayFrame.omit({ cited: true })).max(8),
  /** His render: source_rate 0.25, overlays_burned true. */
  clip: ReplayClip.nullable(),
});
export type ReplayFoulInput = z.infer<typeof ReplayFoulInput>;

// ---- building a moment ------------------------------------------------------------------------

export interface WinReplayInput {
  bet_id: string;
  /** The deciding attempt's CameraEvidence (attempts.evidence_canonical). */
  evidence: CameraEvidence;
  ruling: Ruling | HearingRuling;
  ruling_hash: string;
  /** appeal.final_outcome when there was an appeal, else ruling.outcome. Non-decisive -> null. */
  final_outcome: RulingOutcome | string;
  /** attempts.frame_hashes of that attempt (send order). Cited frames count only if they match. */
  attempt_frame_hashes: readonly string[];
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type EvFrame = CameraEvidence['frames'][number];

/**
 * The win replay from the judge's own frames, or null when there is nothing honest to show
 * (REDO, a VOID that stayed VOID, a Gemini settlement, a non-decisive final outcome, no frames).
 */
export function buildWinReplay(input: WinReplayInput): ReplayMoment | null {
  const { evidence: ev, ruling } = input;
  // A VOID ruling shows nothing unless an appeal decided a winner (then it is held on the last
  // frame, unlabelled: the judge did not pick this side).
  if (ruling.outcome === 'REDO') return null;
  if (ruling.model === GEMINI_SETTLEMENT_MODEL || ruling.frame_hashes.length === 0) return null;
  const final = input.final_outcome;
  if (final !== 'A_WINS' && final !== 'B_WINS') return null;
  const winner: Party = final === 'A_WINS' ? 'A' : 'B';
  const flipped = final !== ruling.outcome;

  const frames = [...ev.frames].sort((a, b) => a.index - b.index);
  const regular = frames.filter((f) => f.landing_crop !== true);
  const crop = frames.find((f) => f.landing_crop === true) ?? null;
  if (regular.length === 0) return null;
  // Cited frames only count when the ruling was given exactly this attempt's frames.
  const matched =
    sameList(ruling.frame_hashes, input.attempt_frame_hashes) &&
    sameList(
      ruling.frame_hashes,
      frames.map((f) => f.sha256),
    );
  const cited = new Set(matched ? ruling.cited_frames : []);

  const landing = regular.filter((f) => isLandingFrame(f.t_ms, ev.duration_ms));
  const leadIns = regular.filter((f) => !isLandingFrame(f.t_ms, ev.duration_ms));
  const picked = new Map<number, EvFrame>();
  const lastLead = leadIns.at(-1);
  if (lastLead) picked.set(lastLead.index, lastLead);
  for (const f of landing) picked.set(f.index, f);
  if (crop) picked.set(crop.index, crop);
  for (const f of frames) if (cited.has(f.index)) picked.set(f.index, f);

  // Evidence order (index) is time order, the crop last.
  const order = [...picked.values()].sort((a, b) => a.index - b.index);
  const citedInSet = order.filter((f) => cited.has(f.index));
  const judgeHold = !flipped && citedInSet.length > 0 ? citedInSet.at(-1)! : null;
  const hold = judgeHold ?? crop ?? order.at(-1)!;

  // Cut at the held frame; keep at least SLOWMO_MIN_BEFORE frames before it when the attempt has them.
  let seq = order.filter((f) => f.index <= hold.index);
  if (seq.length - 1 < SLOWMO_MIN_BEFORE) {
    const have = new Set(seq.map((f) => f.index));
    const earlier = regular
      .filter((f) => f.index < hold.index && !have.has(f.index))
      .sort((a, b) => b.index - a.index);
    for (const f of earlier) {
      if (seq.length - 1 >= SLOWMO_MIN_BEFORE) break;
      seq.push(f);
    }
    seq = seq.sort((a, b) => a.index - b.index);
  }

  let t = 0;
  const out: ReplayFrame[] = seq.map((f) => {
    t = Math.max(t, f.t_ms);
    return {
      idx: f.index,
      t_ms: t,
      landing_crop: f.landing_crop === true,
      cited: cited.has(f.index),
      path: replayFramePath(input.bet_id, ev.attempt_no, f.index),
      url: null,
    };
  });
  const m = ReplayMoment.safeParse({
    schema_version: REPLAY_SCHEMA_VERSION,
    bet_id: input.bet_id,
    attempt_no: ev.attempt_no,
    kind: 'win',
    winner,
    moment_ms: out.at(-1)!.t_ms,
    hold_source: judgeHold ? 'judge_cited' : 'last_frame',
    frames: out,
    clip: null,
    foul: null,
    ruling_hash: input.ruling_hash,
    model: ruling.model,
    reason: flipped ? null : ruling.reason,
  });
  return m.success ? m.data : null;
}

/** Frames of a foul replay built from the attempt itself: up to 4 at or before the moment. */
const FOUL_FRAMES_BEFORE = 3;

/**
 * The foul variant of a moment: the detector's moment frozen, labelled with its measurement.
 * `base` is the deciding attempt's moment fields (from buildWinReplay or the same inputs);
 * `foul` must be a CONFIRMED detector result (an invalid one returns null). With no detector
 * stills and no clip, the attempt's own frames up to the moment are used (`evidence`).
 */
export function buildFoulReplay(
  base: Pick<ReplayMoment, 'bet_id' | 'attempt_no' | 'winner' | 'ruling_hash' | 'model'>,
  foul: ReplayFoulInput,
  evidence?: CameraEvidence,
): ReplayMoment | null {
  const input = ReplayFoulInput.safeParse(foul);
  if (!input.success) return null;
  const f = input.data;
  let frames: ReplayFrame[] = [...f.frames]
    .sort((a, b) => a.t_ms - b.t_ms)
    .map((x) => ({ ...x, cited: false }));
  if (frames.length === 0 && f.clip === null && evidence) {
    const regular = evidence.frames
      .filter((x) => x.landing_crop !== true)
      .sort((a, b) => a.index - b.index);
    // The frame nearest the moment is held; up to FOUL_FRAMES_BEFORE before it lead in.
    let at = 0;
    for (let i = 0; i < regular.length; i++)
      if (Math.abs(regular[i]!.t_ms - f.moment_ms) < Math.abs(regular[at]!.t_ms - f.moment_ms))
        at = i;
    frames = regular.slice(Math.max(0, at - FOUL_FRAMES_BEFORE), at + 1).map((x) => ({
      idx: x.index,
      t_ms: x.t_ms,
      landing_crop: false,
      cited: false,
      path: replayFramePath(base.bet_id, base.attempt_no, x.index),
      url: null,
    }));
  }
  const m = ReplayMoment.safeParse({
    schema_version: REPLAY_SCHEMA_VERSION,
    bet_id: base.bet_id,
    attempt_no: base.attempt_no,
    kind: 'foul',
    winner: base.winner,
    moment_ms: f.moment_ms,
    hold_source: 'detector',
    frames,
    clip: f.clip,
    foul: f.foul,
    ruling_hash: base.ruling_hash,
    model: base.model,
    reason: null,
  });
  return m.success ? m.data : null;
}

// ---- playing a moment -------------------------------------------------------------------------

export interface SlowmoStep {
  /** Stable per frame (React key). */
  key: string;
  /** When this frame starts fading in, ms from the start of the replay. */
  at_ms: number;
  /** How long it is the current frame (the held frame: SLOWMO_HOLD_MS). */
  dwell_ms: number;
  /** Its fade-in (0 with reduced motion). */
  xfade_ms: number;
  /** Zoom over its dwell (1 throughout with reduced motion). */
  scale_from: number;
  scale_to: number;
}

export interface SlowmoTimeline {
  steps: SlowmoStep[];
  /** When the held (last) frame is fully in: the ring and the label appear. */
  hold_at_ms: number;
  total_ms: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** A frame's on-screen time at SLOWMO_RATE of its real gap to the next frame (450..900 ms). */
export const slowmoDwellMs = (gapMs: number): number =>
  clamp(Math.round(Math.max(0, gapMs) / SLOWMO_RATE), SLOWMO_DWELL_MIN_MS, SLOWMO_DWELL_MAX_MS);

/**
 * The frames' schedule: SLOWMO_INTRO_MS of black (the badge), then each frame for
 * slowmoDwellMs(gap to the next), cross-faded, the zoom easing 1 -> 1.08 over the sequence; the
 * last frame fades in (the crop over SLOWMO_CROP_MS) and holds SLOWMO_HOLD_MS while the zoom
 * goes on to 1.14. A typical 12-frame upload (1 lead-in + 8 landing + the crop):
 * 0.5 + 0.9 + 7 × 0.6 + 0.45 + 2.6 ≈ 8.65 s.
 */
export function slowmoTimeline(
  m: Pick<ReplayMoment, 'frames'>,
  opts: { reduceMotion?: boolean } = {},
): SlowmoTimeline {
  const rm = opts.reduceMotion === true;
  const fr = m.frames;
  if (fr.length === 0) return { steps: [], hold_at_ms: 0, total_ms: 0 };
  const dwells = fr.map((f, i) =>
    i === fr.length - 1 ? SLOWMO_HOLD_MS : slowmoDwellMs(fr[i + 1]!.t_ms - f.t_ms),
  );
  const last = fr.length - 1;
  const lastXfade = rm ? 0 : fr[last]!.landing_crop ? SLOWMO_CROP_MS : SLOWMO_XFADE_MS;
  // the zoom runs over the sequence up to the moment the held frame is fully in
  let at = SLOWMO_INTRO_MS;
  const starts = dwells.map((d) => {
    const s = at;
    at += d;
    return s;
  });
  const holdAt = starts[last]! + lastXfade;
  const z = SLOWMO_ZOOM;
  const zoomAt = (t: number) =>
    rm
      ? 1
      : round3(
          z.from +
            (z.to - z.from) *
              clamp((t - SLOWMO_INTRO_MS) / Math.max(1, holdAt - SLOWMO_INTRO_MS), 0, 1),
        );
  const steps = fr.map((f, i): SlowmoStep => {
    const isLast = i === last;
    return {
      key: `${f.idx ?? 'd'}:${i}`,
      at_ms: starts[i]!,
      dwell_ms: dwells[i]!,
      xfade_ms: isLast ? lastXfade : rm ? 0 : SLOWMO_XFADE_MS,
      scale_from: zoomAt(starts[i]!),
      scale_to: isLast ? (rm ? 1 : z.holdTo) : zoomAt(starts[i]! + dwells[i]!),
    };
  });
  return { steps, hold_at_ms: holdAt, total_ms: starts[last]! + SLOWMO_HOLD_MS };
}

/** Which frame is current at `t` (-1 during the intro), and each frame's opacity and zoom. */
export function slowmoFrameAt(
  tl: SlowmoTimeline,
  t: number,
): { current: number; frames: Array<{ opacity: number; scale: number }>; holding: boolean } {
  let current = -1;
  tl.steps.forEach((s, i) => {
    if (t >= s.at_ms) current = i;
  });
  const frames = tl.steps.map((s, i) => {
    const next = tl.steps[i + 1];
    let opacity = 0;
    if (t >= s.at_ms) {
      opacity = s.xfade_ms > 0 ? clamp((t - s.at_ms) / s.xfade_ms, 0, 1) : 1;
      // a frame stays fully under the next one until that one is in (no dip to black)
      if (next && t >= next.at_ms + next.xfade_ms) opacity = 0;
    }
    const p = clamp((t - s.at_ms) / Math.max(1, s.dwell_ms), 0, 1);
    return { opacity, scale: round3(s.scale_from + (s.scale_to - s.scale_from) * p) };
  });
  return { current, frames, holding: tl.steps.length > 0 && t >= tl.hold_at_ms };
}

export interface ClipPlan {
  playbackRate: number;
  seekMs: number;
  freezeAtMs: number;
  endMs: number;
}

/** How to play a clip: a real-time source at SLOWMO_RATE, a pre-slowed render at 1x. */
export const clipPlan = (clip: ReplayClip): ClipPlan => ({
  playbackRate: clip.source_rate === 1 ? SLOWMO_RATE : 1,
  seekMs: clip.from_ms,
  freezeAtMs: clip.moment_ms,
  endMs: clip.to_ms,
});

/** Once-per-(bet, attempt, kind) key (the stage's auto-play). */
export const replayKey = (m: Pick<ReplayMoment, 'bet_id' | 'attempt_no' | 'kind'>): string =>
  `${m.bet_id}:${m.attempt_no}:${m.kind}`;
