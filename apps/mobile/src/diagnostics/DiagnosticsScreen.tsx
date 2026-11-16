// Diagnostics screen for EAS build #1 (TASKS D0-M2). It runs every check on the D0-M2 list, plus
// a few extra ones, and shows a red/green row for each. The camera panels are lazy-loaded and
// only one is mounted at a time. "Log report" prints a JSON report to the Metro log for
// docs/measurements.md.
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

import { AUTO_CHECKS } from './autoChecks';
import { CHECKS, type CameraPanel, type CheckId } from './catalog';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import {
  buildReport,
  confirmResult,
  runCheck,
  summarize,
  type CheckResult,
  type CheckResults,
} from './runner';

const VisionCameraPanel = lazy(() => import('./VisionCameraPanel'));
const ExpoCameraPanel = lazy(() => import('./ExpoCameraPanel'));
/** Sign-up and face enrollment screens on stand-in APIs, until auth (D0-M4) and navigation exist. */
const EnrollPreview = lazy(() => import('../enroll/EnrollPreview'));

/** The model is 13.6 MB; over a Metro tunnel the first load can take a while. */
const TIMEOUTS_MS: Partial<Record<CheckId, number>> = { 'tflite-warmup': 90_000 };

const COLORS: Record<CheckResult['status'], string> = {
  idle: '#9e9e9e',
  running: '#1e88e5',
  'awaiting-confirm': '#f9a825',
  pass: '#2e7d32',
  fail: '#c62828',
};

export default function DiagnosticsScreen() {
  const [results, setResults] = useState<CheckResults>({});
  const [running, setRunning] = useState(false);
  const [panel, setPanel] = useState<CameraPanel | null>(null);
  const [enroll, setEnroll] = useState<'signup' | 'flow' | 'settings' | null>(null);

  const setResult = useCallback((id: CheckId, result: CheckResult) => {
    setResults((prev) => ({ ...prev, [id]: result }));
  }, []);

  const runAuto = useCallback(async () => {
    setRunning(true);
    // Haptics do nothing while a camera is active (FINDINGS §7), so close any camera panel first.
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
                  : '#333',
            },
          ]}
        >
          Required {summary.requiredPassed}/{summary.requiredTotal} green
          {summary.failed.length ? ` · ${summary.failed.length} failed` : ''}
        </Text>

        <View style={styles.row}>
          <Button
            title={running ? 'Running…' : 'Run checks'}
            disabled={running}
            onPress={() => void runAuto()}
          />
          <Button title="Log report" onPress={logReport} />
        </View>

        <View style={styles.row}>
          <Button
            title="VisionCamera"
            onPress={() => setPanel((p) => (p === 'vision' ? null : 'vision'))}
          />
          <Button
            title="expo-camera"
            onPress={() => setPanel((p) => (p === 'expo' ? null : 'expo'))}
          />
          {panel ? <Button title="Close camera" onPress={() => setPanel(null)} /> : null}
        </View>

        <View style={styles.row}>
          <Button
            title="Sign up"
            onPress={() => {
              setPanel(null);
              setEnroll('signup');
            }}
          />
          <Button
            title="Face enrollment"
            onPress={() => {
              setPanel(null);
              setEnroll('flow');
            }}
          />
          <Button
            title="Face settings"
            onPress={() => {
              setPanel(null);
              setEnroll('settings');
            }}
          />
        </View>

        {panel ? (
          <PanelErrorBoundary
            key={panel}
            name={panel === 'vision' ? 'VisionCamera panel' : 'expo-camera panel'}
            onError={(m) => panelError(panel, m)}
          >
            <Suspense fallback={<ActivityIndicator />}>
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
                      <Text>Felt it</Text>
                    </Pressable>
                    <Pressable style={styles.confirm} onPress={() => confirm(c.id, false)}>
                      <Text>Didn&apos;t</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            </View>
          );
        })}
      </ScrollView>
      <Modal
        visible={enroll !== null}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setEnroll(null)}
      >
        {enroll ? (
          <PanelErrorBoundary name="Face enrollment" onError={() => undefined}>
            <Suspense fallback={<ActivityIndicator />}>
              <EnrollPreview initial={enroll} onClose={() => setEnroll(null)} />
            </Suspense>
          </PanelErrorBoundary>
        ) : null}
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: '700' },
  summary: { fontSize: 16, fontWeight: '600' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  check: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  dot: { width: 14, height: 14, borderRadius: 7, marginTop: 3 },
  checkBody: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontWeight: '600' },
  detail: { fontSize: 12, color: '#555' },
  confirm: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#eee',
  },
});
