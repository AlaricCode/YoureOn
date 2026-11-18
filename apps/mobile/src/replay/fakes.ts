// Fake replay moments for ReplayPreview, the simulator and tests. Shaped exactly like a server
// answer (SCHEMAS §4.1 ReplayMoment) for the phone's standard 12-frame + landing-crop upload, at
// the instants the real sampler picks (judgeFrameTimesMs). The foul is a preview of mode B only:
// the app never shows a foul the server did not send (no fake fouls in the product).
import { judgeFrameTimesMs } from '@youre-on/shared/judge/frames';
import {
  REPLAY_SCHEMA_VERSION,
  replayFramePath,
  type ReplayClip,
  type ReplayFrame,
  type ReplayMoment,
} from '@youre-on/shared/replay';

export const FAKE_BET_ID = '0b0e5f1e-5c2a-4f7e-9d3b-6a1c2e4f8a90';
export const FAKE_NAMES = { A: 'Logan', B: 'Alaric' } as const;
const DURATION_MS = 3_000;
const ATTEMPT = 1;
const HASH = 'ab'.repeat(32);

const times = judgeFrameTimesMs(DURATION_MS, 12);

const frame = (idx: number, o: { crop?: boolean; cited?: boolean } = {}): ReplayFrame => ({
  idx,
  t_ms: o.crop ? times[times.length - 1]! : times[idx]!,
  landing_crop: o.crop === true,
  cited: o.cited === true,
  path: replayFramePath(FAKE_BET_ID, ATTEMPT, idx),
  url: null,
});

/**
 * Mode A from frames: the last lead-in frame, the 8 landing frames and the landing crop, the judge
 * having cited frame 10 and the crop; held on the crop (the highest cited index).
 */
export function fakeWinMoment(): ReplayMoment {
  const frames = [3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => frame(i, { cited: i === 10 }));
  frames.push(frame(12, { crop: true, cited: true }));
  return {
    schema_version: REPLAY_SCHEMA_VERSION,
    bet_id: FAKE_BET_ID,
    attempt_no: ATTEMPT,
    kind: 'win',
    winner: 'A',
    moment_ms: frames[frames.length - 1]!.t_ms,
    hold_source: 'judge_cited',
    frames,
    clip: null,
    foul: null,
    ruling_hash: HASH,
    model: 'fake-judge@1',
    reason: 'The bottle lands upright on its cap and stays there.',
  };
}

/** Mode B as a detector would supply it: frozen at the release with the measurement. */
export function fakeFoulMoment(): ReplayMoment {
  const frames = [0, 1, 2].map((i) => frame(i));
  return {
    schema_version: REPLAY_SCHEMA_VERSION,
    bet_id: FAKE_BET_ID,
    attempt_no: ATTEMPT,
    kind: 'foul',
    winner: 'B',
    moment_ms: frames[frames.length - 1]!.t_ms,
    hold_source: 'detector',
    frames,
    clip: null,
    foul: { label: 'Toe 17 cm over', measure_cm: 17, detector: 'sam3/fal@1' },
    ruling_hash: HASH,
    model: 'fake-judge@1',
    reason: null,
  };
}

/** A win with a live clip (mode A-clip), real-time source: played at 0.25x. */
export function fakeClipMoment(
  o: { expiresAt?: string; sourceRate?: number; burned?: boolean } = {},
): ReplayMoment {
  const clip: ReplayClip = {
    url: 'https://clips.example.invalid/attempt-1.mp4?sig=fake',
    expires_at: o.expiresAt ?? '2099-01-01T00:00:00.000Z',
    mime: 'video/mp4',
    source_rate: o.sourceRate ?? 1,
    from_ms: 1_600,
    moment_ms: 2_850,
    to_ms: 3_000,
    overlays_burned: o.burned ?? false,
  };
  return { ...fakeWinMoment(), clip };
}
