// The Dance Off on the judge-cam phone (DANCE-OFF §6.2, §6.3). It IS the display (HDMI shows it
// through iOS mirroring):
//   1. Framing: live skeletons and the framing check's reason; Start unlocks after framing has
//      held for 1 s. When framing passes, the phone tries the face assignment once (§3,
//      ./faceIdentify, time-boxed, never blocking Start): with both players identified, each one's
//      name tag sits over their skeleton (A may stand on the right); without, the "A ← | → B"
//      hint as before (the left / right rule).
//   2. Start → POST /attempts (onStartAttempt) → the attempt arrives. An attempt another phone
//      started (A pressed Start; the server named this judge cam) counts in on its own.
//   3. Count-in "3, 2, 1" on the routine's beat (numerals + haptic) from the attempt's go_at, then
//      GO at go_at + 3 beats: the same server instant the display phone uses (./model/schedule).
//   4. GO: startRound and the reference start in the same tick; duration_ms of dancing with a live
//      name tag over each player ("Logan · 87") and PERFECT / GOOD / MISS popups. With a display
//      phone (the other party's phone, online in the room when the count-in starts), this phone
//      is silent and shows the camera panel only: the display plays the mirrored reference and
//      the music. Without one, today's layout: the reference panel beside the camera, and the
//      music from here.
//   5. stopRound → the local final score → the result (no network so far).
//   6. Upload (onUpload) → "Sending to judge" → the announcer line once the ruling lands (the bet
//      flow then moves on to the ruling screen).
// The pose module loads lazily (importSafely); without it the camera panel says "No camera".
// In the iOS Simulator only (no camera; ../device/simulator), "Simulator: play a sample round"
// runs this same flow on synthetic poses and key frames (./model/simRound): A follows the
// routine, B lags and stops halfway, so two simulators can test the display, sync and ruling.
import { parseDanceTermsRoutine } from '@youre-on/shared/dance/terms';
import { routineDisplayTitle, type RoutineData } from '@youre-on/shared/dance/routine';
import type { DanceRoundResult } from '@youre-on/shared/dance/score';
import type { Terms } from '@youre-on/shared/terms';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { toPoseFrame, toStatusEvent } from '../../modules/dance-pose/src/frame';
import { danceRoundGuard, type CallOffGuard } from '../app/callOff';
import { simulatorSampleOffered } from '../device/simulator';
import { useReportCallOffGuard } from '../screens/CallOff';

import { AlertLine, PrimaryButton, QuietButton, TextButton } from '../ui/kit';
import { DotsLabel, Screen, TopBar } from '../ui/parts';
import { half, palette, space, type } from '../ui/tokens';
import { safeLine } from './DanceResultBreakdown';
import { DANCE_COPY, danceLabels, dt, ERROR_COPY, FRAMING_COPY } from './copy';
import { appDocumentsUri, readFileBytes } from './fs';
import { nowMs, useDanceSettings, useDancePose, useFrameClock, useLive } from './hooks';
import { DANCE_CAMERA, guideSides, previewMirrored } from './model/camera';
import type { LiveStore } from './model/liveStore';
import {
  attemptCountIn,
  autoStartLeftMs,
  autoStartNumeral,
  framingProgress,
  type RoundState,
} from './model/round';
import { serverIsoToLocalMs } from './model/schedule';
import { createSimPoseSource, SIM_FRAME_MS, type SimPoseSource } from './model/simRound';
import { buildDanceUploadBundle, readSnapshots, type DanceUploadBundle } from './model/upload';
import type { DanceFaceId } from './faceIdentify';
import { ResultCard, type ResultData } from './ResultCard';
import { DanceStage } from './Stage';
import { PLAYER_TINT } from './theme';
import { useDanceRound, type DanceRoundEngine, type DanceRoundOutput } from './useDanceRound';

export type { DanceUploadBundle };

export type DanceOffScreenProps = {
  betId: string;
  terms: Terms;
  me: 'A' | 'B';
  names: { a: string; b: string };
  /** The open attempt; go_at is the SERVER's instant (mapped onto this phone via clockOffsetMs). */
  attempt: { attempt_no: number; go_at: string; max_ms: number } | null;
  /** Server time − this phone's Date.now() (net Clock.offsetMs). */
  clockOffsetMs: number;
  /** The other party's phone is the display (../app/danceFlow danceDisplayPresent). */
  displayPhone: boolean;
  /** Face assignment (DANCE-OFF §3): the embedder and the identify call; null: left / right. */
  faceId?: DanceFaceId | null;
  ruling: { outcome: string; reason: string } | null;
  onStartAttempt: () => Promise<{ ok: true } | { ok: false; message: string }>;
  onUpload: (
    bundle: DanceUploadBundle,
    attemptNo: number,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onLeave?: () => void;
  /**
   * Where the round stands for "Call it off" (../app/callOff danceRoundGuard): held while it
   * counts in / dances / scores, and off while this phone holds a local result.
   */
  onCallOffGuard?: (guard: CallOffGuard) => void;
};

/** The pose payload parsers without the native module (the Simulator's sample round). */
const POSE_PARSERS = { toPoseFrame, toStatusEvent };

/** A server go_at on the round clock, read now (the offset can re-sync at any time). */
const goAtOnRoundClock = (goAt: string, offsetMs: number): number | null =>
  serverIsoToLocalMs(goAt, { offsetMs, wallNow: Date.now(), monoNow: nowMs() });

/** A local round result → the result card. */
export function resultFromRound(routine: RoutineData, r: DanceRoundResult): ResultData {
  return {
    scores: { a: r.a.score_x10, b: r.b.score_x10 },
    winner: r.winner,
    tooClose: r.too_close || r.failed !== null,
    moves: routine.key_moves.map((m, i) => ({
      id: m.id,
      name: m.name,
      a: r.a.key_moves[i]?.grade ?? 'MISS',
      b: r.b.key_moves[i]?.grade ?? 'MISS',
    })),
  };
}

export function DanceOffScreen(props: DanceOffScreenProps) {
  const parsed = parseDanceTermsRoutine(props.terms);
  if (!parsed.ok) {
    return (
      <Screen>
        <TopBar title={dt(DANCE_COPY.title)} onBack={props.onLeave} />
        <View style={styles.center}>
          <AlertLine message={dt(DANCE_COPY.unknownRoutine)} />
          {props.onLeave ? (
            <QuietButton label={dt(DANCE_COPY.leave)} onPress={props.onLeave} />
          ) : null}
        </View>
      </Screen>
    );
  }
  return <DanceOffRound {...props} routine={parsed.routine} />;
}

// ---------------------------------------------------------------------------------------
// Framing guide: "A ← | → B" over the camera panel, the reason under it. Once both players are
// identified by face their name tags (Stage NameTags) say who is who, so the hint goes.
// ---------------------------------------------------------------------------------------

function FramingGuide({
  store,
  names,
  visible,
  mirrored,
}: {
  store: LiveStore;
  names: { a: string; b: string };
  visible: boolean;
  /** The preview is a mirror image (the selfie camera): A, on the image's left, is on the right. */
  mirrored: boolean;
}) {
  const ok = useLive(store, (v) => v.framing?.ok === true);
  const byFace = useLive(store, (v) => v.byFace);
  if (!visible || byFace) return null;
  const sides = guideSides(mirrored);
  const labels = danceLabels(names);
  const tint = { a: PLAYER_TINT.A, b: PLAYER_TINT.B } as const;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.centerLine, ok && styles.centerLineOk]} />
      <View style={styles.guideRow}>
        <Text style={[styles.guideName, { color: tint[sides.left] }]} numberOfLines={1}>
          {`${labels[sides.left]} ←`}
        </Text>
        <Text style={[styles.guideName, { color: tint[sides.right] }]} numberOfLines={1}>
          {`→ ${labels[sides.right]}`}
        </Text>
      </View>
    </View>
  );
}

/** The framing reason and the hold bar, then Start. */
function FramingFooter({
  round,
  store,
  camera,
  onStart,
  onSample,
}: {
  round: RoundState;
  store: LiveStore;
  camera: 'ok' | 'none' | 'error';
  onStart: () => void;
  /** The Simulator only: run the sample round (undefined: not offered). */
  onSample?: (() => void) | undefined;
}) {
  const now = useFrameClock(round.phase === 'framing' && round.okSince !== null, 30);
  const reason = useLive(store, (v) => v.framing?.reason ?? null);
  const faces = useLive(store, (v) => v.faces);
  const progress = framingProgress(round, now);
  const ready = round.phase === 'ready';
  const line =
    camera === 'none'
      ? dt(DANCE_COPY.noCamera)
      : camera === 'error'
        ? dt(DANCE_COPY.cameraError)
        : ready
          ? dt(DANCE_COPY.holdStill)
          : reason
            ? dt(FRAMING_COPY[reason])
            : dt(DANCE_COPY.findingYou);
  return (
    <View style={styles.footer}>
      <View style={styles.footerLine}>
        <Text style={[styles.reason, ready && { color: palette.accent }]} numberOfLines={1}>
          {line}
        </Text>
      </View>
      <View style={styles.holdTrack}>
        <View style={[styles.holdFill, { width: `${progress * 100}%` }]} />
      </View>
      {/* Who is who: by face once both are matched; until then each name is a side. The reason
          an attempt ended is shown as it came, so it can be read out. */}
      {faces === 'idle' ? null : (
        <Text style={styles.faces} numberOfLines={1} testID="dance-faces">
          {faces === 'matched'
            ? dt(DANCE_COPY.facesMatched)
            : faces === 'looking'
              ? dt(DANCE_COPY.facesLooking)
              : `${dt(DANCE_COPY.facesSides)} (${faces})`}
        </Text>
      )}
      <PrimaryButton
        label={dt(DANCE_COPY.start)}
        onPress={ready ? onStart : undefined}
        disabled={!ready}
        testID="dance-start"
      />
      {onSample ? (
        <QuietButton
          testID="dance-sim-sample"
          label={dt(DANCE_COPY.simSample)}
          onPress={onSample}
        />
      ) : null}
    </View>
  );
}

function StatusFooter({ children }: { children: ReactNode }) {
  return <View style={[styles.footer, styles.statusFooter]}>{children}</View>;
}

/** How long past the countdown the round waits for a face attempt that is still running. */
const FACE_OVERTIME_MS = 3_000;

// ---------------------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------------------

function DanceOffRound(props: DanceOffScreenProps & { routine: RoutineData }) {
  const { routine, names, me } = props;
  const [settings] = useDanceSettings();
  const pose = useDancePose();
  /** The Simulator's sample round: synthetic poses in place of the camera (./model/simRound). */
  const [sim, setSim] = useState<SimPoseSource | null>(null);
  const simRef = useRef<SimPoseSource | null>(null);
  simRef.current = sim;
  /** Where iOS put this app's sandbox, read once (../device/simulator). */
  const [documentsUri] = useState(appDocumentsUri);
  const [result, setResult] = useState<DanceRoundResult | null>(null);
  const bundle = useRef<DanceUploadBundle | null>(null);
  /** Start was pressed and POST /attempts is out: the next unused attempt counts in. */
  const waiting = useRef(false);
  /** Attempts this screen has counted in on (and not given back with "Dance again"). */
  const usedAttempts = useRef(new Set<number>());
  /** Attempts this screen has seen (the one open at mount included): only a new one auto-starts. */
  const seenAttempts = useRef(new Set<number>(props.attempt ? [props.attempt.attempt_no] : []));
  const propsRef = useRef(props);
  propsRef.current = props;

  const engineRef = useRef<DanceRoundEngine | null>(null);

  const upload = useCallback(async () => {
    const e = engineRef.current;
    const b = bundle.current;
    const attemptNo = e?.state.attemptNo ?? null;
    if (!e || !b || attemptNo === null) return;
    e.dispatch({ type: 'upload' });
    let r: { ok: true } | { ok: false; message: string };
    try {
      r = await propsRef.current.onUpload(b, attemptNo);
    } catch (err) {
      r = { ok: false, message: String(err) };
    }
    if (r.ok) e.dispatch({ type: 'uploaded' });
    else e.dispatch({ type: 'upload_failed', message: r.message });
  }, []);

  const onFinished = useCallback(
    (out: DanceRoundOutput) => {
      void (async () => {
        setResult(out.result);
        const snaps = await readSnapshots(
          out.stop.snapshots,
          simRef.current ? simRef.current.read : readFileBytes,
        );
        const built = buildDanceUploadBundle({
          routine,
          series: out.series,
          result: out.result,
          clipSha256: out.stop.clipSha256,
          snapshots: snaps,
        });
        const e = engineRef.current;
        if (!e || e.state.run !== out.run) return;
        if (!built.ok) {
          bundle.current = null;
          e.dispatch({ type: 'scored', ok: false, message: built.detail });
          return;
        }
        bundle.current = built.bundle;
        e.dispatch({ type: 'scored', ok: true });
        void upload();
      })();
    },
    [routine, upload],
  );

  const engine = useDanceRound({
    routine,
    pose: sim ? POSE_PARSERS : pose.mod,
    syncOffsetMs: settings.syncOffsetMs,
    snapshots: true,
    displayPhone: props.displayPhone,
    faceId: props.faceId ?? null,
    onFinished,
  });
  engineRef.current = engine;
  const { state } = engine;
  useReportCallOffGuard(props.onCallOffGuard, danceRoundGuard(state.phase, result !== null));

  // The sample round: frames at SIM_FPS through the same onPoses path, and the sample source
  // standing in for the native view's handle (startRound / stopRound / the key frames).
  useEffect(() => {
    if (!sim) return;
    const id = setInterval(() => {
      const e = engineRef.current;
      if (!e) return;
      e.handleRef.current = sim.handle;
      e.onPoses({ nativeEvent: sim.frame(nowMs()) });
    }, SIM_FRAME_MS);
    return () => clearInterval(id);
  }, [sim]);
  // Framing holds by itself on synthetic poses: Start as soon as it unlocks (one tap in all).
  useEffect(() => {
    if (sim && state.phase === 'ready') engineRef.current?.start();
  }, [sim, state.phase]);

  // 2. Start → the attempt. An attempt already open (and not danced) is used as is (its go_at is
  // long past, so it counts in from now, out of step with the display); otherwise POST /attempts
  // and wait for an attempt not used yet. Attempts are compared by number only.
  const attemptNo = props.attempt?.attempt_no ?? null;
  useEffect(() => {
    if (state.phase !== 'starting') return;
    const a = propsRef.current.attempt;
    if (a && !usedAttempts.current.has(a.attempt_no)) {
      usedAttempts.current.add(a.attempt_no);
      engineRef.current?.beginCountIn(
        a.attempt_no,
        false,
        goAtOnRoundClock(a.go_at, propsRef.current.clockOffsetMs),
      );
      return;
    }
    waiting.current = true;
    let live = true;
    const failed = (message: string) => {
      if (!live) return;
      waiting.current = false;
      engineRef.current?.dispatch({ type: 'start_failed', message });
    };
    propsRef.current.onStartAttempt().then(
      (r) => {
        if (!r.ok) failed(r.message);
      },
      (err: unknown) => failed(String(err)),
    );
    return () => {
      live = false;
      waiting.current = false;
    };
  }, [state.phase, state.run]);

  // The attempt arrives: after our own Start (waiting), or, new while this screen frames, one
  // that another phone started with this device as the recorder. It counts in without a Start.
  useEffect(() => {
    const a = propsRef.current.attempt;
    if (!a) return;
    const fresh = !seenAttempts.current.has(a.attempt_no);
    seenAttempts.current.add(a.attempt_no);
    const go = attemptCountIn({
      phase: state.phase,
      fresh,
      used: usedAttempts.current.has(a.attempt_no),
      waiting: waiting.current,
    });
    if (go === null) return;
    waiting.current = false;
    usedAttempts.current.add(a.attempt_no);
    engineRef.current?.beginCountIn(
      a.attempt_no,
      go === 'forced',
      goAtOnRoundClock(a.go_at, propsRef.current.clockOffsetMs),
    );
  }, [state.phase, attemptNo]);

  const danceAgain = () => {
    // Nothing reached the judge (a camera error, no key frames, no attempt): give the open
    // attempt back, so the next Start counts in on it. A second POST /attempts would be refused
    // while the bet is still in ATTEMPT.
    if (state.phase !== 'submitted' && state.attemptNo !== null)
      usedAttempts.current.delete(state.attemptNo);
    bundle.current = null;
    waiting.current = false;
    setResult(null);
    engine.reset();
  };

  const realCamera: 'ok' | 'none' | 'error' =
    pose.status === 'missing' || engine.camera === 'no_camera'
      ? 'none'
      : engine.camera === 'error'
        ? 'error'
        : 'ok';
  const cameraKind = sim ? 'ok' : realCamera;
  // Only in the iOS Simulator (its app container), only with no camera: never on a phone.
  const simOffered =
    sim === null &&
    simulatorSampleOffered({
      platform: Platform.OS,
      documentsUri,
      camera: realCamera,
    });
  const showResult =
    result !== null &&
    (state.phase === 'result' ||
      state.phase === 'uploading' ||
      state.phase === 'submitted' ||
      (state.phase === 'failed' && (state.canRetryUpload || state.error === 'no_frames')));

  if (showResult && result) {
    return (
      <Screen>
        <TopBar title={dt(DANCE_COPY.title)} tag={routineDisplayTitle(routine)} />
        <ScrollView contentContainerStyle={styles.resultBody}>
          <ResultCard data={resultFromRound(routine, result)} names={names} me={me} />
          <ResultStatus
            round={state}
            ruling={props.ruling}
            onRetry={() => void upload()}
            onDanceAgain={danceAgain}
          />
        </ScrollView>
      </Screen>
    );
  }

  // Both dancers in position and held there: a countdown they can read from where they stand,
  // and the round starts by itself when it runs out (model/round AUTO_START_MS). They are in
  // front of the camera, not at the phone. Anyone leaving the frame ends the count (the round is
  // back to `framing`) and it starts over once they are both in place again. Start is still
  // there, and a failed start is not retried until the framing is lost and found again.
  const framedAndHeld = state.phase === 'ready';
  const autoNow = useFrameClock(framedAndHeld, 10);
  const autoLeft = autoStartLeftMs(state, autoNow);
  // A face attempt still running when the count runs out gets a little longer to answer, so
  // the names it is about to settle are the ones the round starts with.
  const facesLooking = useLive(engine.store, (v) => v.faces === 'looking');
  const [overtimeFrom, setOvertimeFrom] = useState<number | null>(null);
  const countDone = autoLeft !== null && autoLeft <= 0;
  useEffect(() => {
    setOvertimeFrom(countDone ? nowMs() : null);
  }, [countDone]);
  const overtimeUp = overtimeFrom !== null && autoNow - overtimeFrom >= FACE_OVERTIME_MS;
  const autoDue = countDone && (!facesLooking || overtimeUp);
  const engineStart = useRef(engine.start);
  engineStart.current = engine.start;
  useEffect(() => {
    if (autoDue) engineStart.current();
  }, [autoDue]);
  const autoCount = autoStartNumeral(autoLeft) ?? (countDone && !autoDue ? 1 : null);

  const Pose = pose.status === 'ready' && !sim ? pose.mod.DancePoseView : null;
  // The selfie camera's preview is a mirror image; the sample round has no camera to mirror.
  const mirrored = Pose !== null && previewMirrored(DANCE_CAMERA);
  const camera = Pose ? (
    <Pose
      ref={engine.handleRef}
      style={StyleSheet.absoluteFill}
      active={state.phase !== 'failed'}
      maxFps={30}
      facing={DANCE_CAMERA}
      onPoses={engine.onPoses}
      onStatus={engine.onStatus}
    />
  ) : (
    <View style={[StyleSheet.absoluteFill, styles.noCamera]}>
      {pose.status === 'loading' || sim ? null : (
        <Text style={styles.noCameraText}>{dt(DANCE_COPY.noCamera)}</Text>
      )}
    </View>
  );

  const framing = state.phase === 'framing' || state.phase === 'ready';
  const footer = framing ? (
    <FramingFooter
      round={state}
      store={engine.store}
      camera={cameraKind}
      onStart={() => engine.start()}
      onSample={simOffered ? () => setSim(createSimPoseSource(routine, nowMs)) : undefined}
    />
  ) : state.phase === 'starting' ? (
    <StatusFooter>
      <DotsLabel text={dt(DANCE_COPY.starting)} variant="subtitle" />
    </StatusFooter>
  ) : state.phase === 'countIn' ? (
    <StatusFooter>
      <Text style={styles.statusText}>{dt(DANCE_COPY.getReady)}</Text>
    </StatusFooter>
  ) : state.phase === 'scoring' ? (
    <StatusFooter>
      <DotsLabel text={dt(DANCE_COPY.scoring)} variant="subtitle" />
    </StatusFooter>
  ) : state.phase === 'failed' ? (
    <StatusFooter>
      <AlertLine message={state.error ? dt(ERROR_COPY[state.error]) : null} />
      <PrimaryButton label={dt(DANCE_COPY.tryAgain)} onPress={danceAgain} />
      {props.onLeave ? <TextButton label={dt(DANCE_COPY.leave)} onPress={props.onLeave} /> : null}
    </StatusFooter>
  ) : null;

  return (
    <Screen>
      <TopBar
        title={dt(DANCE_COPY.title)}
        tag={routineDisplayTitle(routine)}
        onBack={framing || state.phase === 'failed' ? props.onLeave : undefined}
      />
      <DanceStage
        routine={routine}
        names={names}
        store={engine.store}
        round={state}
        beatMs={engine.cfg.beatMs}
        startAt={engine.startAt}
        camera={camera}
        mirrored={mirrored}
        cameraOverlay={
          <>
            <FramingGuide
              store={engine.store}
              names={names}
              visible={framing}
              mirrored={mirrored}
            />
            {autoCount !== null ? (
              <View style={styles.autoCount} pointerEvents="none" testID="dance-auto-count">
                <Text style={styles.autoLabel}>{dt(DANCE_COPY.startingIn)}</Text>
                <Text style={styles.autoNumeral} allowFontScaling={false}>
                  {autoCount}
                </Text>
              </View>
            ) : null}
          </>
        }
        debug={settings.debugOverlay}
        syncOffsetMs={settings.syncOffsetMs}
        footer={footer}
        reference={!engine.display}
        mutedUntil={engine.mutedUntil}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------
// Result status: sending → with the judge → the announcer line; or a failure with its action.
// ---------------------------------------------------------------------------------------

function ResultStatus({
  round,
  ruling,
  onRetry,
  onDanceAgain,
}: {
  round: RoundState;
  ruling: { outcome: string; reason: string } | null;
  onRetry: () => void;
  onDanceAgain: () => void;
}) {
  const line = ruling ? safeLine(ruling.reason) : null;
  if (round.phase === 'failed') {
    return (
      <View style={styles.status}>
        <AlertLine message={round.error ? dt(ERROR_COPY[round.error]) : null} />
        {round.canRetryUpload ? (
          <PrimaryButton label={dt(DANCE_COPY.tryAgain)} onPress={onRetry} />
        ) : (
          <PrimaryButton label={dt(DANCE_COPY.danceAgain)} onPress={onDanceAgain} />
        )}
      </View>
    );
  }
  if (ruling) {
    return (
      <View style={styles.status}>
        <Text style={styles.judged}>{dt(DANCE_COPY.judged)}</Text>
        {line ? <Text style={styles.announcer}>{line}</Text> : null}
      </View>
    );
  }
  return (
    <View style={styles.status}>
      <DotsLabel
        text={dt(round.phase === 'submitted' ? DANCE_COPY.withJudge : DANCE_COPY.sending)}
        variant="subtitle"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.x2 },
  footer: { gap: half.x15, paddingHorizontal: half.x05, paddingBottom: space.x1 },
  statusFooter: { alignItems: 'center', minHeight: space.control + space.x4 },
  footerLine: { alignItems: 'center' },
  reason: { ...type.subtitle },
  statusText: { ...type.subtitle },
  holdTrack: {
    height: 2,
    borderRadius: 1,
    backgroundColor: palette.fill,
    overflow: 'hidden',
  },
  holdFill: { height: '100%', backgroundColor: palette.accent },
  centerLine: {
    position: 'absolute',
    top: space.x2,
    bottom: space.x2,
    left: '50%',
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: palette.textTertiary,
  },
  centerLineOk: { backgroundColor: palette.accent },
  guideRow: {
    position: 'absolute',
    top: half.x15,
    left: half.x15,
    right: half.x15,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  guideName: { ...type.heading },
  faces: { ...type.small, color: palette.textSecondary, textAlign: 'center' },
  autoCount: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  autoLabel: { ...type.heading, color: palette.text },
  autoNumeral: {
    ...type.moment,
    fontSize: 132,
    lineHeight: 148,
    letterSpacing: -4,
    color: palette.accent,
  },
  noCamera: { alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface },
  noCameraText: { ...type.labelMedium, color: palette.textSecondary },
  resultBody: { paddingHorizontal: space.page, paddingVertical: space.x3, gap: space.x4 },
  status: { alignItems: 'center', gap: space.x2 },
  judged: { ...type.section },
  announcer: { ...type.statement, textAlign: 'center' },
});
