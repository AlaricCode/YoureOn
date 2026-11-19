// The round engine on the judge-cam phone: the pure state machine (model/round) driven by a
// clock, the native pose view's frames and the count-in, with the side effects in one place.
//
// One shared timestamp (DANCE-OFF §6.2 step 4): at GO, in the same tick, startRound is called on
// the native view and the reference (skeleton clock, or video + music) starts. The native view
// makes the next camera frame t0, so poses, the clip and the reference share one instant (the
// remaining display / mirroring latency is what the calibrated sync offset absorbs).
//
// Frames go to framingCheck while framing, and to the round pipeline (tracker → live scorer →
// series) from the count-in on; the display reads everything from the live store, so a frame
// re-renders the meters and skeletons, not the screen.
//
// Two phones (./model/schedule): a bet round counts in from the attempt's go_at, so t0 is the
// same server instant the display phone (DanceDisplayScreen) starts the reference and the music
// on. While a display phone is there (`displayPhone`, decided once per round when the count-in
// starts), this phone stays silent and shows no reference: the display plays both. Without one
// (or a run that could not meet go_at), it plays the music itself (today's one-phone layout).
import type { RoutineData } from '@youre-on/shared/dance/routine';
import type { DanceRoundResult } from '@youre-on/shared/dance/score';
import type { PoseSeries } from '@youre-on/shared/dance/pose';
import { framingCheck } from '@youre-on/shared/dance/track';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type {
  DancePoseHandle,
  DancePoseState,
  PoseFrameEvent,
  StatusEvent,
  StopRoundResult,
} from '../../modules/dance-pose';
import { importSafely } from '../app/importSafely';
import { feel } from '../device/feedback';
import { nowMs, type DancePoseModule } from './hooks';
import { routineMedia } from './media';
import { createLiveStore, type LiveStore } from './model/liveStore';
import { createRoundPipeline, type RoundPipeline } from './model/pipeline';
import { recorderCountIn } from './model/schedule';
import {
  beatAt,
  countInBeatIndex,
  initialRound,
  recordingPhase,
  roundConfig,
  roundReducer,
  snapshotSchedule,
  type RoundConfig,
  type RoundEvent,
  type RoundState,
} from './model/round';

export interface DanceRoundOutput {
  run: number;
  series: PoseSeries;
  result: DanceRoundResult;
  stop: StopRoundResult;
  /** The pose rate the native view measured at the end. */
  fps: number;
}

export type CameraState = DancePoseState | 'loading';

const EMPTY_STOP: StopRoundResult = { clipUri: null, clipSha256: null, snapshots: [] };
/** Clock tick while anything is timed (framing hold, count-in, the round). */
const TICK_MS = 40;
const TICKING: ReadonlySet<RoundState['phase']> = new Set([
  'framing',
  'ready',
  'starting',
  'countIn',
  'dancing',
]);

/**
 * Only these fields change what the screen draws: lastOkAt moves on every framing frame, and the
 * framing reason is read from the live store (it can flicker frame to frame).
 */
const sameForRender = (a: RoundState, b: RoundState): boolean =>
  a.phase === b.phase &&
  a.okSince === b.okSince &&
  a.attemptNo === b.attemptNo &&
  a.countInAt === b.countInAt &&
  a.goAt === b.goAt &&
  a.error === b.error &&
  a.message === b.message &&
  a.run === b.run &&
  a.canRetryUpload === b.canRetryUpload;

interface AudioLike {
  play(): void;
  pause(): void;
  remove(): void;
}

export interface DanceRoundEngine {
  state: RoundState;
  cfg: RoundConfig;
  store: LiveStore;
  handleRef: RefObject<DancePoseHandle | null>;
  camera: CameraState;
  /** t0 on the nowMs clock (reference + beat bar), null before GO. */
  startAt: number | null;
  /**
   * A display phone plays the reference and the music: this phone shows neither. Fixed for a
   * round from its count-in on (the live `displayPhone` before that).
   */
  display: boolean;
  onPoses: (e: { nativeEvent: PoseFrameEvent }) => void;
  onStatus: (e: { nativeEvent: StatusEvent }) => void;
  dispatch: (e: RoundEvent) => { prev: RoundState; next: RoundState };
  /** Start pressed (framing stable; `force` skips that, for the calibration screen). */
  start: (force?: boolean) => void;
  /**
   * The attempt is open: count in (`force`: from framing, for an attempt started elsewhere).
   * `goAtLocal`: the attempt's go_at on the nowMs clock; the count-in starts there when t0 can
   * still be met (in sync with the display phone), else now.
   */
  beginCountIn: (attemptNo: number, force?: boolean, goAtLocal?: number | null) => void;
  /** Back to framing for a new round. */
  reset: () => void;
}

export function useDanceRound(opts: {
  routine: RoutineData;
  pose: DancePoseModule | null;
  syncOffsetMs: number;
  /** Ask the native view for key-frame JPEGs (the bet round; calibration needs none). */
  snapshots: boolean;
  /** The other party's phone is the display (../app/danceFlow danceDisplayPresent). */
  displayPhone?: boolean;
  onFinished: (out: DanceRoundOutput) => void;
}): DanceRoundEngine {
  const { routine } = opts;
  const cfg = useMemo(() => roundConfig(routine), [routine]);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const stateRef = useRef<RoundState>(initialRound());
  const [state, setState] = useState<RoundState>(stateRef.current);
  const store = useMemo(() => createLiveStore(), []);
  const handleRef = useRef<DancePoseHandle | null>(null);
  const pipeline = useRef<RoundPipeline | null>(null);
  const [startAt, setStartAt] = useState<number | null>(null);
  const startAtRef = useRef<number | null>(null);
  const [camera, setCamera] = useState<CameraState>('loading');
  const fps = useRef(0);
  const countBeat = useRef(-1);
  const danceBeat = useRef(-1);
  const audio = useRef<AudioLike | null>(null);
  const goTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The count-in about to start ran from go_at (in sync with the display phone). */
  const nextSynced = useRef(false);
  /** This round's display decision (null: no round counting in or running). */
  const [runDisplay, setRunDisplay] = useState<boolean | null>(null);

  const stopAudio = () => {
    const a = audio.current;
    audio.current = null;
    if (!a) return;
    try {
      a.pause();
      a.remove();
    } catch {
      // Already released.
    }
  };

  // `dispatch` and the transition side effects reference each other through this ref.
  const transitionRef = useRef<(prev: RoundState, next: RoundState, at: number) => void>(
    () => undefined,
  );

  const dispatch = useCallback((e: RoundEvent) => {
    const prev = stateRef.current;
    const next = roundReducer(prev, e, cfgRef.current);
    if (next !== prev) {
      stateRef.current = next;
      if (!sameForRender(prev, next)) setState(next);
      if (next.phase !== prev.phase || next.run !== prev.run)
        transitionRef.current(prev, next, 'at' in e ? e.at : nowMs());
    }
    return { prev, next };
  }, []);

  const finish = useCallback(
    async (run: number) => {
      let stop = EMPTY_STOP;
      try {
        const h = handleRef.current;
        if (h) stop = await h.stopRound();
      } catch {
        stop = EMPTY_STOP;
      }
      stopAudio();
      if (stateRef.current.run !== run) return;
      const p = pipeline.current;
      const { series, result } = p
        ? p.final()
        : createRoundPipeline({ routine, syncOffsetMs: 0 }).final();
      store.flush();
      optsRef.current.onFinished({ run, series, result, stop, fps: fps.current });
    },
    [routine, store],
  );

  const go = useCallback(
    (at: number) => {
      const run = stateRef.current.run;
      pipeline.current?.beginRound();
      startAtRef.current = at;
      setStartAt(at);
      danceBeat.current = -1;
      const h = handleRef.current;
      const snapshotAtMs = optsRef.current.snapshots ? snapshotSchedule(routine) : [];
      if (!h) {
        dispatch({ type: 'round_failed', message: 'pose view not mounted' });
        return;
      }
      // The same tick: native t0 is the next camera frame; the reference already runs on `at`.
      h.startRound({ snapshotAtMs }).then(
        (r) => {
          if (!r.ok && stateRef.current.run === run)
            dispatch({ type: 'round_failed', message: r.message ?? 'startRound refused' });
        },
        (err: unknown) => {
          if (stateRef.current.run === run)
            dispatch({ type: 'round_failed', message: String(err) });
        },
      );
      try {
        audio.current?.play();
      } catch {
        // Music is a nicety; the round runs without it.
      }
      feel('holdComplete');
    },
    [dispatch, routine],
  );

  transitionRef.current = (prev, next, at) => {
    if (next.phase === 'countIn' && prev.phase !== 'countIn') {
      pipeline.current = createRoundPipeline({
        routine,
        syncOffsetMs: optsRef.current.syncOffsetMs,
      });
      store.reset();
      countBeat.current = -1;
      // Exactly on GO, not up to a tick late.
      if (goTimer.current) clearTimeout(goTimer.current);
      if (next.goAt !== null) {
        goTimer.current = setTimeout(
          () => dispatch({ type: 'tick', at: nowMs() }),
          Math.max(0, next.goAt - nowMs()),
        );
      }
      // A display phone plays the music, if it is there and this run is on its timeline.
      const display = optsRef.current.displayPhone === true && nextSynced.current;
      nextSynced.current = false;
      setRunDisplay(display);
      const media = routineMedia(routine);
      if (!display && media.audio !== null && media.video === null) {
        const asset = media.audio;
        void importSafely(() => import('expo-audio'))
          .then((A) => {
            if (stateRef.current.run === next.run) audio.current = A.createAudioPlayer(asset);
          })
          .catch(() => undefined);
      }
    }
    if (next.phase === 'dancing' && prev.phase === 'countIn') go(at);
    if (next.phase === 'scoring' && prev.phase === 'dancing') void finish(next.run);
    if (next.phase === 'failed' && (prev.phase === 'dancing' || prev.phase === 'countIn')) {
      // The round never really started: release the native round and the music.
      stopAudio();
      void handleRef.current?.stopRound().catch(() => undefined);
    }
    if (next.run !== prev.run) {
      pipeline.current = null;
      startAtRef.current = null;
      setStartAt(null);
      setRunDisplay(null);
      stopAudio();
      store.reset();
    }
  };

  // The clock.
  useEffect(() => {
    if (!TICKING.has(state.phase)) return;
    const id = setInterval(() => {
      const at = nowMs();
      const { next } = dispatch({ type: 'tick', at });
      if (next.phase === 'countIn' && next.countInAt !== null) {
        const i = countInBeatIndex(next.countInAt, at, cfgRef.current.beatMs);
        if (i > countBeat.current) {
          countBeat.current = i;
          feel('select');
        }
      } else if (next.phase === 'dancing' && startAtRef.current !== null) {
        const b = beatAt(routine, at - startAtRef.current);
        if (b && b.index !== danceBeat.current) {
          danceBeat.current = b.index;
          feel('select');
        }
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [state.phase, dispatch, routine]);

  useEffect(
    () => () => {
      if (goTimer.current) clearTimeout(goTimer.current);
      stopAudio();
    },
    [],
  );

  const onPoses = useCallback(
    (e: { nativeEvent: PoseFrameEvent }) => {
      const mod = optsRef.current.pose;
      const f = mod ? mod.toPoseFrame(e.nativeEvent) : null;
      if (!f) return;
      fps.current = f.fps;
      const s = stateRef.current;
      const people = f.people.map((p) => p.k);
      if (s.phase === 'framing' || s.phase === 'ready' || s.phase === 'starting') {
        const fr = framingCheck(people, f.w, f.h);
        if (s.phase !== 'starting')
          dispatch({ type: 'framing', at: nowMs(), ok: fr.ok, reason: fr.reason });
        store.update({
          w: f.w,
          h: f.h,
          people,
          a: fr.a !== undefined ? (people[fr.a] ?? null) : null,
          b: fr.b !== undefined ? (people[fr.b] ?? null) : null,
          framing: fr,
          fps: f.fps,
        });
        return;
      }
      const p = pipeline.current;
      if (recordingPhase(s.phase) && p) {
        const out = p.push(f);
        for (const u of out.updates) store.applyLive(u);
        store.update((v) => ({
          w: f.w,
          h: f.h,
          people,
          a: out.a,
          b: out.b,
          fps: f.fps,
          frames: v.frames + out.updates.length,
        }));
        return;
      }
      if (s.phase === 'scoring') return;
      store.update({ w: f.w, h: f.h, people, a: null, b: null, fps: f.fps });
    },
    [dispatch, store],
  );

  const onStatus = useCallback((e: { nativeEvent: StatusEvent }) => {
    const mod = optsRef.current.pose;
    const st = mod ? mod.toStatusEvent(e.nativeEvent) : null;
    if (st) setCamera(st.state);
  }, []);

  const start = useCallback(
    (force?: boolean) => {
      dispatch({ type: 'start', at: nowMs(), force: force === true });
    },
    [dispatch],
  );

  const beginCountIn = useCallback(
    (attemptNo: number, force?: boolean, goAtLocal?: number | null) => {
      const at = nowMs();
      const plan = recorderCountIn(goAtLocal ?? null, at, cfgRef.current.beatMs);
      nextSynced.current = plan.synced;
      dispatch({
        type: 'attempt',
        at,
        attemptNo,
        force: force === true,
        countInAt: plan.countInAt,
      });
      nextSynced.current = false;
    },
    [dispatch],
  );

  const reset = useCallback(() => {
    if (goTimer.current) clearTimeout(goTimer.current);
    dispatch({ type: 'reset' });
  }, [dispatch]);

  return {
    state,
    cfg,
    store,
    handleRef,
    camera,
    startAt,
    display: runDisplay ?? opts.displayPhone === true,
    onPoses,
    onStatus,
    dispatch,
    start,
    beginCountIn,
    reset,
  };
}
