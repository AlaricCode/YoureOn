// The Dance Off on the judge-cam phone (DANCE-OFF §6.2, §6.3). It IS the display (HDMI shows it
// through iOS mirroring):
//   1. Framing: live skeletons, "A ← | → B", the framing check's reason; Start unlocks after
//      framing has held for 1 s.
//   2. Start → POST /attempts (onStartAttempt) → the attempt arrives.
//   3. Count-in "3, 2, 1" on the routine's beat (numerals + haptic), then GO.
//   4. GO: startRound and the reference start in the same tick; 15 s of dancing with live meters
//      and PERFECT / GOOD / MISS popups.
//   5. stopRound → the local final score → the result (no network so far).
//   6. Upload (onUpload) → "Sending to judge" → the announcer line once the ruling lands (the bet
//      flow then moves on to the ruling screen).
// The pose module loads lazily (importSafely); without it the camera panel says "No camera".
import { parseDanceTermsRoutine } from '@youre-on/shared/dance/terms';
import type { RoutineData } from '@youre-on/shared/dance/routine';
import type { DanceRoundResult } from '@youre-on/shared/dance/score';
import type { Terms } from '@youre-on/shared/terms';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AlertLine, PrimaryButton, QuietButton, TextButton } from '../ui/kit';
import { DotsLabel, Screen, TopBar } from '../ui/parts';
import { half, palette, space, type } from '../ui/tokens';
import { safeLine } from './DanceResultBreakdown';
import { DANCE_COPY, dt, ERROR_COPY, firstName, FRAMING_COPY } from './copy';
import { readFileBytes } from './fs';
import { useDanceSettings, useDancePose, useFrameClock, useLive } from './hooks';
import type { LiveStore } from './model/liveStore';
import { framingProgress, type RoundState } from './model/round';
import { buildDanceUploadBundle, readSnapshots, type DanceUploadBundle } from './model/upload';
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
  attempt: { attempt_no: number; go_at: string; max_ms: number } | null;
  ruling: { outcome: string; reason: string } | null;
  onStartAttempt: () => Promise<{ ok: true } | { ok: false; message: string }>;
  onUpload: (
    bundle: DanceUploadBundle,
    attemptNo: number,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onLeave?: () => void;
};

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
// Framing guide: "A ← | → B" over the camera panel, the reason under it.
// ---------------------------------------------------------------------------------------

function FramingGuide({
  store,
  names,
  visible,
}: {
  store: LiveStore;
  names: { a: string; b: string };
  visible: boolean;
}) {
  const ok = useLive(store, (v) => v.framing?.ok === true);
  if (!visible) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={[styles.centerLine, ok && styles.centerLineOk]} />
      <View style={styles.guideRow}>
        <Text style={[styles.guideName, { color: PLAYER_TINT.A }]} numberOfLines={1}>
          {`${firstName(names.a)} ←`}
        </Text>
        <Text style={[styles.guideName, { color: PLAYER_TINT.B }]} numberOfLines={1}>
          {`→ ${firstName(names.b)}`}
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
}: {
  round: RoundState;
  store: LiveStore;
  camera: 'ok' | 'none' | 'error';
  onStart: () => void;
}) {
  const now = useFrameClock(round.phase === 'framing' && round.okSince !== null, 30);
  const reason = useLive(store, (v) => v.framing?.reason ?? null);
  const progress = framingProgress(round, now);
  const ready = round.phase === 'ready';
  const line =
    camera === 'none'
      ? dt(DANCE_COPY.noCamera)
      : camera === 'error'
        ? dt(DANCE_COPY.cameraError)
        : ready
          ? dt(DANCE_COPY.ready)
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
      <PrimaryButton
        label={dt(DANCE_COPY.start)}
        onPress={ready ? onStart : undefined}
        disabled={!ready}
        testID="dance-start"
      />
    </View>
  );
}

function StatusFooter({ children }: { children: ReactNode }) {
  return <View style={[styles.footer, styles.statusFooter]}>{children}</View>;
}

// ---------------------------------------------------------------------------------------
// The round
// ---------------------------------------------------------------------------------------

function DanceOffRound(props: DanceOffScreenProps & { routine: RoutineData }) {
  const { routine, names, me } = props;
  const [settings] = useDanceSettings();
  const pose = useDancePose();
  const [result, setResult] = useState<DanceRoundResult | null>(null);
  const bundle = useRef<DanceUploadBundle | null>(null);
  /** While waiting for the attempt: the attempt key we already had (undefined = not waiting). */
  const waitingFrom = useRef<string | null | undefined>(undefined);
  const usedAttempts = useRef(new Set<number>());
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
        const snaps = await readSnapshots(out.stop.snapshots, readFileBytes);
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
    pose: pose.mod,
    syncOffsetMs: settings.syncOffsetMs,
    snapshots: true,
    onFinished,
  });
  engineRef.current = engine;
  const { state } = engine;

  // 2. Start → the attempt. An attempt already open (and not danced) is used as is; otherwise
  // POST /attempts and wait for a NEW attempt to arrive (not the one we already had).
  const attemptKey = props.attempt ? `${props.attempt.attempt_no}|${props.attempt.go_at}` : null;
  const attemptKeyRef = useRef(attemptKey);
  attemptKeyRef.current = attemptKey;
  useEffect(() => {
    if (state.phase !== 'starting') return;
    const a = propsRef.current.attempt;
    if (a && !usedAttempts.current.has(a.attempt_no)) {
      usedAttempts.current.add(a.attempt_no);
      engineRef.current?.beginCountIn(a.attempt_no);
      return;
    }
    waitingFrom.current = attemptKeyRef.current;
    let live = true;
    const failed = (message: string) => {
      if (!live) return;
      waitingFrom.current = undefined;
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
    };
  }, [state.phase, state.run]);

  useEffect(() => {
    if (state.phase !== 'starting' || waitingFrom.current === undefined) return;
    const a = propsRef.current.attempt;
    if (!a || attemptKey === null || attemptKey === waitingFrom.current) return;
    waitingFrom.current = undefined;
    usedAttempts.current.add(a.attempt_no);
    engineRef.current?.beginCountIn(a.attempt_no);
  }, [state.phase, attemptKey]);

  const danceAgain = () => {
    bundle.current = null;
    waitingFrom.current = undefined;
    setResult(null);
    engine.reset();
  };

  const cameraKind: 'ok' | 'none' | 'error' =
    pose.status === 'missing' || engine.camera === 'no_camera'
      ? 'none'
      : engine.camera === 'error'
        ? 'error'
        : 'ok';
  const showResult =
    result !== null &&
    (state.phase === 'result' ||
      state.phase === 'uploading' ||
      state.phase === 'submitted' ||
      (state.phase === 'failed' && (state.canRetryUpload || state.error === 'no_frames')));

  if (showResult && result) {
    return (
      <Screen>
        <TopBar title={dt(DANCE_COPY.title)} tag={routine.title} />
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

  const Pose = pose.status === 'ready' ? pose.mod.DancePoseView : null;
  const camera = Pose ? (
    <Pose
      ref={engine.handleRef}
      style={StyleSheet.absoluteFill}
      active={state.phase !== 'failed'}
      maxFps={30}
      onPoses={engine.onPoses}
      onStatus={engine.onStatus}
    />
  ) : (
    <View style={[StyleSheet.absoluteFill, styles.noCamera]}>
      {pose.status === 'loading' ? null : (
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
        tag={routine.title}
        onBack={framing || state.phase === 'failed' ? props.onLeave : undefined}
      />
      <DanceStage
        routine={routine}
        names={names}
        me={me}
        store={engine.store}
        round={state}
        beatMs={engine.cfg.beatMs}
        startAt={engine.startAt}
        camera={camera}
        cameraOverlay={<FramingGuide store={engine.store} names={names} visible={framing} />}
        debug={settings.debugOverlay}
        syncOffsetMs={settings.syncOffsetMs}
        footer={footer}
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
  noCamera: { alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface },
  noCameraText: { ...type.labelMedium, color: palette.textSecondary },
  resultBody: { paddingHorizontal: space.page, paddingVertical: space.x3, gap: space.x4 },
  status: { alignItems: 'center', gap: space.x2 },
  judged: { ...type.section },
  announcer: { ...type.statement, textAlign: 'center' },
});
