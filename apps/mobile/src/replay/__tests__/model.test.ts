// The phone's slow-mo player logic: mode choice, preload policy, which frames play and which is
// held, the animation plan from the shared timeline, the clip plan and the copy per mode.
import type { CameraEvidence } from '@youre-on/shared/evidence';
import { judgeFrameTimesMs } from '@youre-on/shared/judge/frames';
import {
  buildWinReplay,
  ReplayMoment,
  SLOWMO_CROP_MS,
  SLOWMO_HOLD_MS,
  SLOWMO_INTRO_MS,
  SLOWMO_ZOOM,
  slowmoDwellMs,
  type ReplayResponse,
} from '@youre-on/shared/replay';
import type { Ruling } from '@youre-on/shared/ruling';
import { describe, expect, it } from 'vitest';

import { FAKE_BET_ID, FAKE_NAMES, fakeClipMoment, fakeFoulMoment, fakeWinMoment } from '../fakes';
import {
  chooseMode,
  clipReachedFreeze,
  clipRun,
  framesPlan,
  heldFrame,
  initPlayer,
  isJudgesFrame,
  playableFrames,
  playbackSchedule,
  playerReducer,
  replayCopy,
  replayViewOf,
  type PlayerAction,
  type PlayerState,
} from '../model';

const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);
const all = (n: number) => Array<boolean>(n).fill(true);
const run = (s: PlayerState, ...as: PlayerAction[]) => as.reduce(playerReducer, s);
const loadAll = (s: PlayerState) =>
  run(s, ...s.loaded.map((_, i): PlayerAction => ({ type: 'frame_loaded', i })));

describe('fakes', () => {
  it('are valid ReplayMoments', () => {
    for (const m of [fakeWinMoment(), fakeFoulMoment(), fakeClipMoment()])
      expect(ReplayMoment.safeParse(m).success).toBe(true);
  });

  it('the win fake is what the server builds for the same upload and citations', () => {
    const times = judgeFrameTimesMs(3_000, 12);
    const hash = (i: number) => i.toString(16).padStart(64, '0');
    const frames: CameraEvidence['frames'] = times.map((t_ms, index) => ({
      index,
      t_ms,
      sha256: hash(index),
    }));
    frames.push({ index: 12, t_ms: times[11]!, sha256: hash(12), landing_crop: true });
    const evidence = { attempt_no: 1, duration_ms: 3_000, frames } as unknown as CameraEvidence;
    const ruling = {
      outcome: 'A_WINS',
      model: 'fake-judge@1',
      frame_hashes: frames.map((f) => f.sha256),
      cited_frames: [10, 12],
      reason: 'The bottle lands upright on its cap and stays there.',
    } as unknown as Ruling;
    const built = buildWinReplay({
      bet_id: FAKE_BET_ID,
      evidence,
      ruling,
      ruling_hash: 'ab'.repeat(32),
      final_outcome: 'A_WINS',
      attempt_frame_hashes: frames.map((f) => f.sha256),
    });
    expect(built).toEqual(fakeWinMoment());
  });
});

describe('chooseMode', () => {
  it('frames when there is no clip', () => {
    expect(chooseMode(fakeWinMoment(), NOW)).toBe('frames');
  });
  it('the clip while its signed url is good', () => {
    expect(chooseMode(fakeClipMoment(), NOW)).toBe('clip');
  });
  it('an expired (or about to expire) clip falls back to the frames', () => {
    const soon = new Date(NOW + 2_000).toISOString();
    expect(chooseMode(fakeClipMoment({ expiresAt: soon }), NOW)).toBe('frames');
  });
  it('nothing to play: an expired clip and no frames', () => {
    const past = new Date(NOW - 1).toISOString();
    expect(chooseMode({ ...fakeClipMoment({ expiresAt: past }), frames: [] }, NOW)).toBeNull();
  });
});

describe('player reducer: preload policy', () => {
  const m = fakeWinMoment();
  const n = m.frames.length;

  it('starts loading, and plays once every frame has loaded', () => {
    let s = initPlayer(m, { nowMs: NOW });
    expect(s).toMatchObject({ phase: 'loading', mode: 'frames', run: 0 });
    s = run(
      s,
      ...Array.from({ length: n - 1 }, (_, i): PlayerAction => ({ type: 'frame_loaded', i })),
    );
    expect(s.phase).toBe('loading');
    s = run(s, { type: 'frame_loaded', i: n - 1 });
    expect(s).toMatchObject({ phase: 'playing', run: 1 });
  });

  it('plays as soon as all have settled with at least 2 loaded', () => {
    const s = run(
      initPlayer(m, { nowMs: NOW }),
      { type: 'frame_loaded', i: 0 },
      { type: 'frame_loaded', i: 1 },
      ...Array.from({ length: n - 2 }, (_, k): PlayerAction => ({
        type: 'frame_failed',
        i: k + 2,
      })),
    );
    expect(s.phase).toBe('playing');
  });

  it('errors when every frame settled with fewer than 2 loaded', () => {
    const s = run(
      initPlayer(m, { nowMs: NOW }),
      { type: 'frame_loaded', i: 0 },
      ...Array.from({ length: n - 1 }, (_, k): PlayerAction => ({
        type: 'frame_failed',
        i: k + 1,
      })),
    );
    expect(s.phase).toBe('error');
  });

  it('after the 4 s timeout: plays with 2 loaded, errors with 1', () => {
    const two = run(
      initPlayer(m, { nowMs: NOW }),
      { type: 'frame_loaded', i: 3 },
      { type: 'frame_loaded', i: 5 },
      { type: 'preload_timeout' },
    );
    expect(two.phase).toBe('playing');
    const one = run(
      initPlayer(m, { nowMs: NOW }),
      { type: 'frame_loaded', i: 3 },
      { type: 'preload_timeout' },
    );
    expect(one.phase).toBe('error');
  });

  it('ignores late loads once playing, and duplicate events', () => {
    const s = run(
      initPlayer(m, { nowMs: NOW }),
      { type: 'frame_loaded', i: 0 },
      { type: 'frame_loaded', i: 0 },
      { type: 'frame_loaded', i: 1 },
      { type: 'preload_timeout' },
    );
    expect(s.loaded.filter(Boolean)).toHaveLength(2);
    const later = run(s, { type: 'frame_loaded', i: 2 });
    expect(later.phase).toBe('playing');
    expect(later.run).toBe(s.run);
  });

  it('drawn (preview) frames play at once', () => {
    expect(initPlayer(m, { nowMs: NOW, preloaded: true })).toMatchObject({
      phase: 'playing',
      run: 1,
    });
  });
});

describe('player reducer: hold, end, replay again', () => {
  const m = fakeWinMoment();
  it('playing -> holding -> ended -> playing (run + 1)', () => {
    let s = loadAll(initPlayer(m, { nowMs: NOW }));
    expect(s.phase).toBe('playing');
    s = run(s, { type: 'end' }, { type: 'hold' });
    expect(s.phase).toBe('ended'); // a hold after the end is ignored
    s = run(loadAll(initPlayer(m, { nowMs: NOW })), { type: 'hold' });
    expect(s.phase).toBe('holding');
    s = run(s, { type: 'end' });
    expect(s.phase).toBe('ended');
    const again = run(s, { type: 'again' });
    expect(again).toMatchObject({ phase: 'playing', run: s.run + 1 });
    expect(again.loaded).toEqual(s.loaded); // no re-preload
  });

  it('"again" does nothing while loading or after an error', () => {
    const loading = initPlayer(m, { nowMs: NOW });
    expect(run(loading, { type: 'again' })).toBe(loading);
    const err = run(loading, { type: 'preload_timeout' });
    expect(run(err, { type: 'again' }).phase).toBe('error');
  });
});

describe('player reducer: clip mode', () => {
  it('loading -> playing on clip_ready; the freeze holds', () => {
    const s = run(initPlayer(fakeClipMoment(), { nowMs: NOW }), { type: 'clip_ready' });
    expect(s).toMatchObject({ mode: 'clip', phase: 'playing', run: 1 });
    expect(run(s, { type: 'hold' }).phase).toBe('holding');
  });

  it('a failed clip falls back to preloading the frames', () => {
    const s = run(initPlayer(fakeClipMoment(), { nowMs: NOW }), { type: 'clip_failed' });
    expect(s).toMatchObject({ mode: 'frames', phase: 'loading' });
    expect(loadAll(s).phase).toBe('playing');
  });

  it('a failed clip with no frames is an error', () => {
    const m = { ...fakeClipMoment(), frames: [] };
    expect(run(initPlayer(m, { nowMs: NOW }), { type: 'clip_failed' }).phase).toBe('error');
  });

  it('frame events do not start a clip', () => {
    const s = run(initPlayer(fakeClipMoment(), { nowMs: NOW }), { type: 'preload_timeout' });
    expect(s.phase).toBe('loading');
  });
});

describe('which frames play, and the held frame', () => {
  it('all loaded: moment order, the crop held, and it is the judge frame', () => {
    const m = fakeWinMoment();
    const play = playableFrames(m, all(m.frames.length));
    expect(play.map((p) => p.frame.idx)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const ts = play.map((p) => p.frame.t_ms);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
    const held = heldFrame(play);
    expect(held?.frame.landing_crop).toBe(true);
    expect(isJudgesFrame(m, held)).toBe(true);
  });

  it('a frame that failed is skipped; if the crop failed the last loaded frame is held (no judge tag)', () => {
    const m = fakeWinMoment();
    const loaded = all(m.frames.length);
    loaded[2] = false;
    loaded[m.frames.length - 1] = false; // the crop
    const play = playableFrames(m, loaded);
    expect(play.map((p) => p.frame.idx)).toEqual([3, 4, 6, 7, 8, 9, 10, 11]);
    const held = heldFrame(play);
    expect(held?.frame.idx).toBe(11);
    expect(isJudgesFrame(m, held)).toBe(false);
  });

  it('a held cited frame after an appeal flip (last_frame) gets no judge tag', () => {
    const m: ReplayMoment = { ...fakeWinMoment(), hold_source: 'last_frame', winner: 'B' };
    expect(isJudgesFrame(m, heldFrame(playableFrames(m, all(m.frames.length))))).toBe(false);
  });

  it('a foul is never a judge frame', () => {
    const m = fakeFoulMoment();
    expect(isJudgesFrame(m, heldFrame(playableFrames(m, all(m.frames.length))))).toBe(false);
  });
});

describe('framesPlan (the shared timeline per Image)', () => {
  const m = fakeWinMoment();
  const plan = framesPlan(m, all(m.frames.length), { reduceMotion: false });

  it('starts after the intro and dwells at 0.25x of each real gap (clamped)', () => {
    expect(plan.anims[0]!.fadeInAt).toBe(SLOWMO_INTRO_MS);
    for (let i = 0; i < plan.anims.length - 1; i++) {
      const a = plan.anims[i]!;
      const gap = m.frames[i + 1]!.t_ms - m.frames[i]!.t_ms;
      expect(a.scaleMs).toBe(slowmoDwellMs(gap));
      expect(plan.anims[i + 1]!.fadeInAt).toBe(a.fadeInAt + a.scaleMs);
      // the frame stays under the next one until that one is fully in
      expect(a.fadeOutAt).toBe(plan.anims[i + 1]!.fadeInAt + plan.anims[i + 1]!.fadeMs);
    }
    expect(slowmoDwellMs(150)).toBe(600);
  });

  it('holds on the crop: closing zoom fade, push-in to 1.14 over the hold, then ends', () => {
    const last = plan.anims.at(-1)!;
    expect(last.at).toBe(m.frames.length - 1);
    expect(last.fadeMs).toBe(SLOWMO_CROP_MS);
    expect(last.fadeOutAt).toBeNull();
    expect(last.scaleTo).toBe(SLOWMO_ZOOM.holdTo);
    expect(last.scaleMs).toBe(SLOWMO_HOLD_MS);
    expect(plan.holdAt).toBe(last.fadeInAt + SLOWMO_CROP_MS);
    expect(plan.endAt).toBe(last.fadeInAt + SLOWMO_HOLD_MS);
    expect(plan.endAt).toBeGreaterThan(7_000);
    expect(plan.endAt).toBeLessThan(10_000);
    // the zoom only grows
    for (const a of plan.anims) expect(a.scaleTo).toBeGreaterThanOrEqual(a.scaleFrom);
  });

  it('skips frames that did not load (anims point at the loaded Images only)', () => {
    const loaded = all(m.frames.length);
    loaded[4] = false;
    const p = framesPlan(m, loaded, { reduceMotion: false });
    expect(p.anims.map((a) => a.at)).not.toContain(4);
    expect(p.anims).toHaveLength(m.frames.length - 1);
  });

  it('reduced motion: no zoom, cuts instead of crossfades', () => {
    const p = framesPlan(m, all(m.frames.length), { reduceMotion: true });
    for (const a of p.anims) {
      expect(a.scaleFrom).toBe(1);
      expect(a.scaleTo).toBe(1);
      expect(a.fadeMs).toBe(0);
    }
  });

  it('the timers: hold then end', () => {
    expect(playbackSchedule(plan)).toEqual([
      { at_ms: plan.holdAt, action: 'hold' },
      { at_ms: plan.endAt, action: 'end' },
    ]);
  });
});

describe('clip mode plan', () => {
  it('a real-time clip plays at 0.25x from from_ms and freezes at moment_ms', () => {
    const r = clipRun(fakeClipMoment())!;
    expect(r).toEqual({ playbackRate: 0.25, seekSec: 1.6, freezeSec: 2.85, playMs: 5_000 });
    expect(clipReachedFreeze(r, 2.7)).toBe(false);
    expect(clipReachedFreeze(r, 2.84)).toBe(true);
  });

  it('a pre-slowed render (source_rate 0.25) plays at 1x', () => {
    const r = clipRun(fakeClipMoment({ sourceRate: 0.25 }))!;
    expect(r.playbackRate).toBe(1);
    expect(r.playMs).toBe(1_250);
  });

  it('no clip, no plan', () => {
    expect(clipRun(fakeWinMoment())).toBeNull();
  });
});

describe('replayCopy: win vs foul', () => {
  it('a win held on the judge-cited crop', () => {
    const m = fakeWinMoment();
    const held = heldFrame(playableFrames(m, all(m.frames.length)));
    expect(replayCopy(m, FAKE_NAMES, { mode: 'frames', held })).toEqual({
      badge: 'Slow-mo replay',
      title: 'Winning moment',
      speed: '0.25x',
      chip: 'Logan wins',
      holdTag: "Judge's frame",
      holdData: null,
      badgeOnly: false,
    });
  });

  it('a win after an appeal flip names the final winner and drops the judge tag', () => {
    const m: ReplayMoment = { ...fakeWinMoment(), hold_source: 'last_frame', winner: 'B' };
    const held = heldFrame(playableFrames(m, all(m.frames.length)));
    const c = replayCopy(m, FAKE_NAMES, { mode: 'frames', held });
    expect(c.chip).toBe('Alaric wins');
    expect(c.holdTag).toBeNull();
  });

  it('a foul: "Foul" with the measurement, the non-fouler wins', () => {
    const m = fakeFoulMoment();
    const held = heldFrame(playableFrames(m, all(m.frames.length)));
    expect(replayCopy(m, FAKE_NAMES, { mode: 'frames', held })).toMatchObject({
      title: 'Foul',
      chip: 'Alaric wins',
      holdTag: 'Foul',
      holdData: 'Toe 17 cm over',
      badgeOnly: false,
    });
  });

  it('a foul whose moment frame failed to load: no "Foul" tag on the wrong frame', () => {
    const m = fakeFoulMoment();
    const loaded = all(m.frames.length).map((x, i) => (i === m.frames.length - 1 ? false : x));
    const held = heldFrame(playableFrames(m, loaded));
    const c = replayCopy(m, FAKE_NAMES, { mode: 'frames', held });
    expect(c.title).toBe('Foul');
    expect(c.holdTag).toBeNull();
    expect(c.holdData).toBeNull();
  });

  it('a burned-in clip draws only the badge; its frames fallback draws everything', () => {
    const m = fakeClipMoment({ sourceRate: 0.25, burned: true });
    expect(replayCopy(m, FAKE_NAMES, { mode: 'clip', held: null })).toMatchObject({
      badgeOnly: true,
      speed: '0.25x',
    });
    expect(replayCopy(m, FAKE_NAMES, { mode: 'frames', held: null }).badgeOnly).toBe(false);
  });
});

describe('replayViewOf: when the Replay button shows', () => {
  const res = (r: Partial<ReplayResponse>): ReplayResponse => ({
    replay: null,
    why: 'not_ruled',
    final: false,
    ...r,
  });

  it('shows only for a ready answer', () => {
    const m = fakeWinMoment();
    expect(replayViewOf(res({ replay: m, why: 'ready', final: true }), NOW)).toEqual({
      moment: m,
      why: 'ready',
      final: true,
    });
    for (const why of ['not_ruled', 'no_winner', 'no_frames', 'purged'] as const)
      expect(replayViewOf(res({ why, final: why !== 'not_ruled' }), NOW).moment).toBeNull();
  });

  it('hides a ready answer with nothing playable (expired clip, no frames)', () => {
    const past = new Date(NOW - 1).toISOString();
    const m = { ...fakeClipMoment({ expiresAt: past }), frames: [] };
    expect(replayViewOf(res({ replay: m, why: 'ready' }), NOW).moment).toBeNull();
  });
});
