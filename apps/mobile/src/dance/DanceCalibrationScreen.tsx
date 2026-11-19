// Dance calibration (hidden; Diagnostics → "Dance calibration", DANCE-OFF §6.4). An operator
// screen, loaded lazily (importSafely) so the pose module never rides the boot path.
// - Live: the real round engine on the camera (one dancer is fine: "Solo" scores them as both
//   players), with the debug readout always on: live meters, per-limb similarity, the current
//   best-lag offset, FPS, convention. Every round is saved as a session.
// - Saved sessions (documentDirectory/dance-sessions): replay one through the live scorer in
//   real time (the reference plays alongside), or score it at once, plus a sync sweep that
//   re-scores the same poses at offsets −300..300 ms and names the best one.
// - The A/V sync offset stepper (persisted) and the debug-overlay switch for the live screen.
// - Self test: a routine scored against itself must be 100.0 for both players.
import { getRoutine, ROUTINES, type RoutineData } from '@youre-on/shared/dance/routine';
import {
  createLiveScorer,
  scoreRound,
  type DancePlayerScore,
  type DanceRoundResult,
} from '@youre-on/shared/dance/score';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { PoseFrameEvent } from '../../modules/dance-pose';
import { PrimaryButton, QuietButton, TextButton, ToggleRow } from '../ui/kit';
import { ChoiceChip, Screen, TopBar } from '../ui/parts';
import { half, palette, radius, space, TABULAR, type } from '../ui/tokens';
import { scoreText } from './copy';
import { danceSessions } from './fs';
import { nowMs, useDancePose, useDanceSettings } from './hooks';
import { createLiveStore } from './model/liveStore';
import { bestSyncOffset, replayInputs, selfTestSeries, sweepSyncOffsets } from './model/pipeline';
import { buildSession, type DanceSession, type DanceSessionMeta } from './recordings';
import { SYNC_STEPS_MS } from './settings';
import { DanceStage } from './Stage';
import { useDanceRound, type DanceRoundEngine, type DanceRoundOutput } from './useDanceRound';

const NAMES = { a: 'A', b: 'B' };
const STAGE_HEIGHT = 560;

type Mode = 'live' | 'replay';

// ---------------------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------------------

function PlayerFinal({ label, s }: { label: string; s: DancePlayerScore }) {
  const grades = { PERFECT: 0, GOOD: 0, MISS: 0 };
  for (const m of s.key_moves) grades[m.grade] += 1;
  const rows: [string, string][] = [
    ['score', scoreText(s.score_x10)],
    ['raw', s.raw.toFixed(3)],
    ['key', s.key.toFixed(3)],
    ['continuous', s.continuous.toFixed(3)],
    ['mean sim', s.mean_sim.toFixed(3)],
    ['movement', s.movement.toFixed(3)],
    ['convention', s.convention],
    ['coverage', `${s.coverage_pct}%`],
    ['mean lag', `${s.mean_lag_ms} ms`],
    ['frames', String(s.frames_scored)],
    ['moves', `${grades.PERFECT} P · ${grades.GOOD} G · ${grades.MISS} M`],
  ];
  return (
    <View style={styles.finalCol}>
      <Text style={styles.finalHead}>{label}</Text>
      {rows.map(([k, v]) => (
        <View key={k} style={styles.kv}>
          <Text style={styles.k}>{k}</Text>
          <Text style={styles.v}>{v}</Text>
        </View>
      ))}
      <View style={styles.limbRow}>
        {Object.entries(s.limbs).map(([id, v]) => (
          <Text key={id} style={styles.limbText}>{`${id} ${v.toFixed(2)}`}</Text>
        ))}
      </View>
    </View>
  );
}

function FinalReadout({ title, result }: { title: string; result: DanceRoundResult }) {
  const verdict = result.failed
    ? `failed: ${result.failed}`
    : result.too_close
      ? 'too close'
      : `winner ${result.winner ?? '–'}`;
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{`${title} · ${verdict}`}</Text>
      <View style={styles.finalRow}>
        <PlayerFinal label="A" s={result.a} />
        <PlayerFinal label="B" s={result.b} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Live (the real engine)
// ---------------------------------------------------------------------------------------

function LivePane({
  routine,
  syncOffsetMs,
  onSaved,
}: {
  routine: RoutineData;
  syncOffsetMs: number;
  onSaved: (s: DanceSession, r: DanceRoundResult) => void;
}) {
  const pose = useDancePose();
  const [solo, setSolo] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const engineRef = useRef<DanceRoundEngine | null>(null);
  const onFinished = useCallback(
    (out: DanceRoundOutput) => {
      engineRef.current?.dispatch({ type: 'scored', ok: true });
      const session = buildSession({
        at: new Date(),
        routineId: routine.id,
        series: out.series,
        clientScores: { a: out.result.a.score_x10, b: out.result.b.score_x10 },
        fps: out.fps,
      });
      danceSessions.save(session).then(
        () => setNote(`saved ${session.id}`),
        (e: unknown) => setNote(`save failed: ${String(e)}`),
      );
      onSaved(session, out.result);
    },
    [routine.id, onSaved],
  );
  const engine = useDanceRound({
    routine,
    pose: pose.mod,
    syncOffsetMs,
    snapshots: false,
    onFinished,
  });
  engineRef.current = engine;
  const { state } = engine;
  const soloRef = useRef(solo);
  soloRef.current = solo;
  const onPoses = engine.onPoses;
  // Solo: one dancer counts as both players (the tracker needs two people to start).
  const feed = useCallback(
    (e: { nativeEvent: PoseFrameEvent }) => {
      const ev = e.nativeEvent;
      if (soloRef.current && Array.isArray(ev?.people) && ev.people.length === 1) {
        const p = ev.people[0]!;
        onPoses({ nativeEvent: { ...ev, people: [p, { k: [...p.k] }] } });
      } else onPoses(e);
    },
    [onPoses],
  );

  const busy = state.phase === 'countIn' || state.phase === 'dancing' || state.phase === 'scoring';
  const Pose = pose.status === 'ready' ? pose.mod.DancePoseView : null;
  return (
    <View style={styles.pane}>
      <View style={[styles.stageBox, { height: STAGE_HEIGHT }]}>
        <DanceStage
          routine={routine}
          names={NAMES}
          store={engine.store}
          round={state}
          beatMs={engine.cfg.beatMs}
          startAt={engine.startAt}
          camera={
            Pose ? (
              <Pose
                ref={engine.handleRef}
                style={StyleSheet.absoluteFill}
                active
                maxFps={30}
                onPoses={feed}
                onStatus={engine.onStatus}
              />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.black]}>
                <Text style={styles.dim}>{pose.status === 'loading' ? '' : 'No pose module'}</Text>
              </View>
            )
          }
          debug
          syncOffsetMs={syncOffsetMs}
        />
      </View>
      <Text style={styles.mono}>
        {`camera ${engine.camera} · phase ${state.phase} · framing ${state.framingReason ?? '–'}` +
          (state.message ? ` · ${state.message}` : '')}
      </Text>
      <ToggleRow label="Solo dancer" value={solo} onChange={setSolo} />
      <View style={styles.row}>
        {state.phase === 'framing' || state.phase === 'ready' ? (
          <PrimaryButton
            label="Record round"
            onPress={() => {
              engine.start(true);
              // No server here: the "attempt" opens at once.
              engine.beginCountIn(0);
            }}
          />
        ) : busy ? (
          <QuietButton label="Recording" busy />
        ) : (
          <PrimaryButton label="Again" onPress={engine.reset} />
        )}
      </View>
      {note ? <Text style={styles.mono}>{note}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Replay (a saved session, through the live scorer in real time)
// ---------------------------------------------------------------------------------------

function ReplayPane({
  routine,
  session,
  onDone,
}: {
  routine: RoutineData;
  session: DanceSession;
  onDone: (r: DanceRoundResult) => void;
}) {
  const store = useMemo(() => createLiveStore(), []);
  const [startAt, setStartAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const play = useCallback(() => {
    const s = session.series;
    const inputs = replayInputs(s);
    const scorer = createLiveScorer(routine, {
      syncOffsetMs: s.sync_offset_ms,
      w: s.w,
      h: s.h,
      fpsCap: s.fps_cap,
    });
    store.reset();
    const firstT = inputs[0]?.t ?? 0;
    const t0 = nowMs() + Math.max(0, -firstT);
    setStartAt(t0);
    setRunning(true);
    let i = 0;
    let frames = 0;
    const id = setInterval(() => {
      const elapsed = nowMs() - t0;
      while (i < inputs.length && inputs[i]!.t <= elapsed) {
        const f = inputs[i]!;
        const u = scorer.push(f);
        store.applyLive(u);
        frames += 1;
        const people = [f.a, f.b].filter((k): k is number[] => k !== null);
        store.update({ w: s.w, h: s.h, people, a: f.a, b: f.b, frames, fps: s.fps_cap });
        i += 1;
      }
      if (i >= inputs.length) {
        clearInterval(id);
        setRunning(false);
        onDoneRef.current(scorer.final().result);
      }
    }, 16);
    return () => clearInterval(id);
  }, [routine, session, store]);

  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  return (
    <View style={styles.pane}>
      <View style={[styles.stageBox, { height: STAGE_HEIGHT }]}>
        <DanceStage
          routine={routine}
          names={NAMES}
          store={store}
          round={{ phase: running ? 'dancing' : 'framing', countInAt: null, goAt: startAt }}
          beatMs={60_000 / routine.bpm}
          startAt={running ? startAt : null}
          camera={<View style={[StyleSheet.absoluteFill, styles.black]} />}
          debug
          syncOffsetMs={session.series.sync_offset_ms}
        />
      </View>
      <View style={styles.row}>
        {running ? (
          <QuietButton
            label="Stop"
            onPress={() => {
              stopRef.current?.();
              stopRef.current = null;
              setRunning(false);
            }}
          />
        ) : (
          <PrimaryButton
            label="Replay real time"
            onPress={() => {
              stopRef.current = play();
            }}
          />
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------

export default function DanceCalibrationScreen({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useDanceSettings();
  const [routineId, setRoutineId] = useState(ROUTINES[0]!.id);
  const [mode, setMode] = useState<Mode>('live');
  const [sessions, setSessions] = useState<DanceSessionMeta[]>([]);
  const [session, setSession] = useState<DanceSession | null>(null);
  const [final, setFinal] = useState<{ title: string; result: DanceRoundResult } | null>(null);
  const [selfTest, setSelfTest] = useState<string | null>(null);
  const [sweep, setSweep] = useState<string | null>(null);

  const routine = getRoutine(session?.routine_id ?? routineId) ?? ROUTINES[0]!;

  const refresh = useCallback(() => {
    void danceSessions.list().then(setSessions);
  }, []);
  useEffect(refresh, [refresh]);

  const open = async (meta: DanceSessionMeta, then: 'replay' | 'fast') => {
    const s = await danceSessions.load(meta.id);
    if (!s) {
      setSweep(`could not read ${meta.id}`);
      return;
    }
    const r = getRoutine(s.routine_id);
    if (!r) {
      setSweep(`unknown routine ${s.routine_id}`);
      return;
    }
    setSession(s);
    if (then === 'replay') {
      setMode('replay');
      return;
    }
    const saved = scoreRound(r, s.series);
    const current = scoreRound(r, { ...s.series, sync_offset_ms: settings.syncOffsetMs });
    setFinal({ title: `${meta.id} at ${settings.syncOffsetMs} ms`, result: current });
    const rows = sweepSyncOffsets(r, s.series);
    const best = bestSyncOffset(rows);
    setSweep(
      `saved offset ${s.series.sync_offset_ms} ms: A ${scoreText(saved.a.score_x10)} B ` +
        `${scoreText(saved.b.score_x10)}\n` +
        rows.map((x) => `${x.offsetMs} ms  A ${scoreText(x.a)}  B ${scoreText(x.b)}`).join('\n') +
        `\nbest ${best ?? '–'} ms`,
    );
  };

  const runSelfTest = () => {
    const t = nowMs();
    const r = scoreRound(routine, selfTestSeries(routine));
    const ms = Math.round(nowMs() - t);
    const perfect = r.a.key_moves.filter((m) => m.grade === 'PERFECT').length;
    const pass = r.a.score_x10 === 1000 && r.b.score_x10 === 1000;
    setSelfTest(
      `${pass ? 'PASS' : 'FAIL'} ${routine.id}: A ${scoreText(r.a.score_x10)} B ` +
        `${scoreText(r.b.score_x10)} · ${perfect}/${r.a.key_moves.length} perfect · ` +
        `${r.a.convention} · ${ms} ms`,
    );
  };

  const onSaved = useCallback(
    (s: DanceSession, r: DanceRoundResult) => {
      setFinal({ title: s.id, result: r });
      setTimeout(refresh, 300);
    },
    [refresh],
  );

  return (
    <Screen>
      <TopBar title="Dance calibration" onBack={onClose} />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.section}>Routine</Text>
        <View style={styles.row} accessibilityRole="radiogroup">
          {ROUTINES.map((r) => (
            <ChoiceChip
              key={r.id}
              label={r.title}
              selected={routine.id === r.id}
              onPress={() => {
                setSession(null);
                setRoutineId(r.id);
                setMode('live');
              }}
            />
          ))}
        </View>

        <View style={styles.row}>
          <ChoiceChip label="Live" selected={mode === 'live'} onPress={() => setMode('live')} />
          <ChoiceChip
            label="Replay"
            selected={mode === 'replay'}
            disabled={session === null}
            onPress={() => setMode('replay')}
          />
        </View>

        {mode === 'replay' && session ? (
          <ReplayPane
            key={session.id}
            routine={routine}
            session={session}
            onDone={(r) => setFinal({ title: `${session.id} replay`, result: r })}
          />
        ) : (
          <LivePane
            key={routine.id}
            routine={routine}
            syncOffsetMs={settings.syncOffsetMs}
            onSaved={onSaved}
          />
        )}

        {final ? <FinalReadout title={final.title} result={final.result} /> : null}

        <Text style={styles.section}>Sync offset</Text>
        <View style={styles.row}>
          {SYNC_STEPS_MS.slice(0, 2).map((d) => (
            <QuietButton
              key={d}
              small
              label={`${d}`}
              onPress={() => setSettings({ syncOffsetMs: settings.syncOffsetMs + d })}
            />
          ))}
          <Text style={styles.offset}>{`${settings.syncOffsetMs} ms`}</Text>
          {SYNC_STEPS_MS.slice(2).map((d) => (
            <QuietButton
              key={d}
              small
              label={`+${d}`}
              onPress={() => setSettings({ syncOffsetMs: settings.syncOffsetMs + d })}
            />
          ))}
          <TextButton small label="Zero" onPress={() => setSettings({ syncOffsetMs: 0 })} />
        </View>
        <ToggleRow
          label="Debug overlay"
          value={settings.debugOverlay}
          onChange={(v) => setSettings({ debugOverlay: v })}
        />

        <Text style={styles.section}>Self test</Text>
        <View style={styles.row}>
          <QuietButton label={`Score ${routine.title}`} onPress={runSelfTest} />
        </View>
        {selfTest ? <Text style={styles.mono}>{selfTest}</Text> : null}

        <Text style={styles.section}>Saved sessions</Text>
        {sessions.length === 0 ? <Text style={styles.dim}>None yet</Text> : null}
        {sessions.map((m) => (
          <View key={m.id} style={styles.sessionRow}>
            <View style={styles.sessionText}>
              <Text style={styles.sessionLabel}>{m.label}</Text>
              <Text style={styles.dim}>{m.routine_id}</Text>
            </View>
            <TextButton small label="Replay" onPress={() => void open(m, 'replay')} />
            <TextButton small label="Score" onPress={() => void open(m, 'fast')} />
            <TextButton
              small
              tone="danger"
              label="Delete"
              onPress={() => {
                if (session?.id === m.id) {
                  setSession(null);
                  setMode('live');
                }
                void danceSessions.remove(m.id).then(refresh, refresh);
              }}
            />
          </View>
        ))}
        {sweep ? <Text style={styles.mono}>{sweep}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.page, paddingVertical: space.x2, gap: half.x15 },
  pane: { gap: half.x15 },
  stageBox: { borderRadius: radius.lg, overflow: 'hidden' },
  black: { backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.x1 },
  section: { ...type.section, marginTop: space.x2 },
  dim: { ...type.small },
  mono: { ...type.small, color: palette.text, fontVariant: TABULAR },
  offset: { ...type.amount, minWidth: 88, textAlign: 'center' },
  card: {
    backgroundColor: palette.surface,
    borderRadius: radius.lg,
    padding: space.x2,
    gap: space.x1,
  },
  cardTitle: { ...type.labelStrong },
  finalRow: { flexDirection: 'row', gap: space.x2 },
  finalCol: { flex: 1, gap: 2 },
  finalHead: { ...type.heading },
  kv: { flexDirection: 'row', justifyContent: 'space-between' },
  k: { ...type.small },
  v: { ...type.small, color: palette.text, fontVariant: TABULAR },
  limbRow: { flexDirection: 'row', flexWrap: 'wrap', gap: half.x05, marginTop: half.x05 },
  limbText: { ...type.small, fontVariant: TABULAR },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  sessionText: { flex: 1 },
  sessionLabel: { ...type.label, fontVariant: TABULAR },
});
