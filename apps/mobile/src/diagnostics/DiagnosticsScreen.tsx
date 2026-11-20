// Diagnostics screen for EAS build #1 (TASKS D0-M2). It runs every check on the D0-M2 list, plus
// a few extra ones, and shows a red/green row for each. The camera panels are lazy-loaded and
// only one is mounted at a time. "Log report" prints a JSON report to the Metro log for
// docs/measurements.md.
import { StatusBar } from 'expo-status-bar';
import { lazy, Suspense, useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { importSafely } from '../app/importSafely';
import { AUTO_CHECKS } from './autoChecks';
import { CHECKS, type CameraPanel, type CheckId } from './catalog';
import { half, palette, radius, space, type } from '../ui/tokens';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import {
  buildReport,
  confirmResult,
  runCheck,
  summarize,
  type CheckResult,
  type CheckResults,
} from './runner';

const VisionCameraPanel = lazy(() => importSafely(() => import('./VisionCameraPanel')));
const ExpoCameraPanel = lazy(() => importSafely(() => import('./ExpoCameraPanel')));
/** Every app screen on stand-in data, until auth (D0-M4), realtime and navigation exist. */
const PreviewApp = lazy(() => importSafely(() => import('../preview/PreviewApp')));
/** Dance Off calibration (DANCE-OFF §6.4): live pose readout, sessions, sync offset, self test. */
const DanceCalibrationScreen = lazy(() =>
  importSafely(() => import('../dance/DanceCalibrationScreen')),
);

/**
 * The model is 13.6 MB; over a Metro tunnel the first load can take a while. The Face ID check
 * waits for a person (and, without Face ID, for the passcode to be typed).
 */
const TIMEOUTS_MS: Partial<Record<CheckId, number>> = {
  'tflite-warmup': 90_000,
  'faceid-gate': 60_000,
};

const COLORS: Record<CheckResult['status'], string> = {
  idle: palette.dim,
  running: palette.text,
  'awaiting-confirm': palette.accent,
  pass: palette.success,
  fail: palette.danger,
};
/** The system Button's tint (iOS draws its title in this colour). */
const BUTTON_TINT = palette.accent;

export default function DiagnosticsScreen({ onClose }: { onClose?: () => void } = {}) {
  const [results, setResults] = useState<CheckResults>({});
  const [running, setRunning] = useState(false);
  const [panel, setPanel] = useState<CameraPanel | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [danceOpen, setDanceOpen] = useState(false);

  const setResult = useCallback((id: CheckId, result: CheckResult) => {
    setResults((prev) => ({ ...prev, [id]: result }));
  }, []);

  const runAuto = useCallback(async () => {
    setRunning(true);
    // Haptics do nothing while a camera is active, so close any camera panel first.
    setPanel(null);
    // One at a time: the mic prompt and the haptics need the person's attention.
    for (const check of CHECKS) {
      const body = AUTO_CHECKS[check.id];
      if (!body) continue;
      setResult(check.id, { status: 'running', detail: '…' });
      const timeoutMs = TIMEOUTS_MS[check.id];
      const result = await runCheck(body, timeoutMs === undefined ? {} : { timeoutMs });
      setResult(check.id, result);
    }
    setRunning(false);
  }, [setResult]);

  const confirm = useCallback((id: CheckId, ok: boolean) => {
    setResults((prev) => {
      const r = prev[id];
      return r ? { ...prev, [id]: confirmResult(r, ok) } : prev;
    });
  }, []);

  const panelError = useCallback(
    (which: CameraPanel, message: string) => {
      for (const c of CHECKS) {
        if ('panel' in c && c.panel === which) {
          setResult(c.id, {
            status: 'fail',
            detail: `panel failed to load: ${message}`,
            at: new Date().toISOString(),
          });
        }
      }
    },
    [setResult],
  );

  const logReport = useCallback(() => {
    const report = buildReport(results, { os: `${Platform.OS} ${String(Platform.Version)}` });
    console.log(`[diagnostics] ${JSON.stringify(report)}`);
  }, [results]);

  const summary = summarize(results);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      {/* Black background: light status bar (mounted after the root's, so it wins). */}
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Build diagnostics</Text>
        <Text
          style={[
            styles.summary,
            {
              color: summary.allRequiredGreen
                ? COLORS.pass
                : summary.failed.length
                  ? COLORS.fail
                  : palette.text,
            },
          ]}
        >
          Required {summary.requiredPassed}/{summary.requiredTotal} green
          {summary.failed.length ? ` · ${summary.failed.length} failed` : ''}
        </Text>

        <View style={styles.row}>
          <Button
            color={BUTTON_TINT}
            title={running ? 'Running…' : 'Run checks'}
            disabled={running}
            onPress={() => void runAuto()}
          />
          <Button color={BUTTON_TINT} title="Log report" onPress={logReport} />
        </View>

        <View style={styles.row}>
          <Button
            color={BUTTON_TINT}
            title="VisionCamera"
            onPress={() => setPanel((p) => (p === 'vision' ? null : 'vision'))}
          />
          <Button
            color={BUTTON_TINT}
            title="expo-camera"
            onPress={() => setPanel((p) => (p === 'expo' ? null : 'expo'))}
          />
          {panel ? (
            <Button color={BUTTON_TINT} title="Close camera" onPress={() => setPanel(null)} />
          ) : null}
        </View>

        <View style={styles.row}>
          <Button
            color={BUTTON_TINT}
            title="App preview"
            onPress={() => {
              setPanel(null);
              setPreviewOpen(true);
            }}
          />
          <Button
            color={BUTTON_TINT}
            title="Dance calibration"
            onPress={() => {
              setPanel(null);
              setDanceOpen(true);
            }}
          />
          {onClose ? (
            <Button
              color={BUTTON_TINT}
              title="Back to app"
              onPress={() => {
                setPanel(null);
                onClose();
              }}
            />
          ) : null}
        </View>

        {panel ? (
          <PanelErrorBoundary
            key={panel}
            name={panel === 'vision' ? 'VisionCamera panel' : 'expo-camera panel'}
            onError={(m) => panelError(panel, m)}
          >
            <Suspense fallback={<ActivityIndicator color={palette.accent} />}>
              {panel === 'vision' ? (
                <VisionCameraPanel onResult={setResult} />
              ) : (
                <ExpoCameraPanel onResult={setResult} />
              )}
            </Suspense>
          </PanelErrorBoundary>
        ) : null}

        {CHECKS.map((c) => {
          const r = results[c.id];
          const status = r?.status ?? 'idle';
          return (
            <View key={c.id} style={styles.check}>
              <View style={[styles.dot, { backgroundColor: COLORS[status] }]} />
              <View style={styles.checkBody}>
                <Text style={styles.label}>
                  {c.label}
                  {c.required ? '' : '  (extra)'}
                </Text>
                <Text style={styles.detail}>
                  {r ? r.detail : c.hint}
                  {r?.ms !== undefined ? `  [${r.ms.toFixed(0)} ms]` : ''}
                </Text>
                {status === 'awaiting-confirm' ? (
                  <View style={styles.row}>
                    <Pressable style={styles.confirm} onPress={() => confirm(c.id, true)}>
                      <Text style={styles.confirmText}>Felt it</Text>
                    </Pressable>
                    <Pressable style={styles.confirm} onPress={() => confirm(c.id, false)}>
                      <Text style={styles.confirmText}>Didn&apos;t</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            </View>
          );
        })}
      </ScrollView>
      <Modal
        visible={previewOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setPreviewOpen(false)}
      >
        {previewOpen ? (
          <PanelErrorBoundary name="App preview" onError={() => undefined}>
            <Suspense fallback={<ActivityIndicator color={palette.accent} />}>
              <PreviewApp onClose={() => setPreviewOpen(false)} />
            </Suspense>
          </PanelErrorBoundary>
        ) : null}
      </Modal>
      <Modal
        visible={danceOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setDanceOpen(false)}
      >
        {danceOpen ? (
          <PanelErrorBoundary name="Dance calibration" onError={() => undefined}>
            <Suspense fallback={<ActivityIndicator color={palette.accent} />}>
              <DanceCalibrationScreen onClose={() => setDanceOpen(false)} />
            </Suspense>
          </PanelErrorBoundary>
        ) : null}
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  content: { paddingHorizontal: space.page, paddingVertical: space.x2, gap: half.x15 },
  title: { ...type.title },
  summary: { ...type.heading },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x1, alignItems: 'center' },
  check: { flexDirection: 'row', gap: half.x15, alignItems: 'flex-start' },
  dot: { width: 14, height: 14, borderRadius: 7, marginTop: half.x05 },
  checkBody: { flex: 1, gap: 2 },
  label: { ...type.labelStrong },
  detail: { ...type.small },
  confirm: {
    paddingHorizontal: half.x15,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: palette.fill,
  },
  confirmText: { ...type.labelMedium },
});
