// Face enrollment screens (TASKS D3-M3), in the enroll redesign's style and order:
//
//   FaceEnrollFlow   1 Your consent  → "I consent" checkbox; Continue lights up once ticked;
//                                       "Skip for now" (enrollment is opt-in, BRIEF 5e)
//                    2 Register face → the camera opens right away; prompts; "Face saved";
//                                       then Done
//   FaceSettings     "Face saved", a Face matching on/off toggle (PATCH), and a red
//                    "Delete face data" with a Yes/No confirmation (DELETE)
//
// Every step has a back arrow: Face → Consent → onExit (the screen before enrollment).
// Consent comes first: nothing is captured until it is ticked, and unticking it after a save is
// not offered (delete from FaceSettings instead).
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, ScrollView, StyleSheet, View } from 'react-native';

import { importSafely } from '../app/importSafely';
import { PanelErrorBoundary } from '../diagnostics/PanelErrorBoundary';

import {
  BodyText,
  CheckBadge,
  CheckRow,
  ConfirmSheet,
  DangerButton,
  Hairline,
  Label,
  PrimaryButton,
  QuietButton,
  SavedRow,
  StepHeader,
  StepScaffold,
  TextButton,
  ToggleRow,
} from '../ui/kit';
import { Screen } from '../ui/parts';
import { half, palette, space } from '../ui/tokens';
import { FaceApiError, type FaceApi, type FaceStatus } from './api';
import type { FaceEmbedder } from './embedder';
import { ENROLL_COPY } from './copy';
import { enrollErrorLabel, type FaceConsent } from './flow';

// The capture panel pulls in the MLKit face detector, which simulator builds leave out
// (react-native.config.js). Loaded lazily, so a build without it loses this step only.
const FaceCapturePanel = lazy(() =>
  importSafely(() => import('./FaceCapturePanel')).then((m) => ({ default: m.FaceCapturePanel })),
);

type Step = 'consent' | 'face';
const STEPS: readonly Step[] = ['consent', 'face'];

export function FaceEnrollFlow({
  api,
  embedder,
  now,
  onDone,
  onSkip,
  onExit,
  showPreviewTag = true,
}: {
  api: FaceApi;
  embedder: FaceEmbedder;
  /**
   * Tag the steps "Preview" when the embedder is a stand-in (default). The design preview turns
   * it off: its own Preview bar already says so.
   */
  showPreviewTag?: boolean;
  /** The server-corrected clock (ms; rt.clock.now) for consent_at and passed_at: the server
   *  refuses either one more than 60 s ahead of its own time. */
  now: () => number;
  /** Face saved and Done tapped. */
  onDone: () => void;
  /** "Skip for now" on the consent step. */
  onSkip: () => void;
  /** Back from the first step. */
  onExit: () => void;
}) {
  const [step, setStep] = useState<Step>('consent');
  const [consent, setConsent] = useState<FaceConsent | null>(null);
  const [consentAt, setConsentAt] = useState<Date | null>(null);
  const [saved, setSaved] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);

  const loadConsent = useCallback(() => {
    setAlert(null);
    api
      .getConsent()
      .then(setConsent)
      .catch(() => setAlert('Try again'));
  }, [api]);
  useEffect(loadConsent, [loadConsent]);

  const go = useCallback((s: Step) => {
    setAlert(null);
    setStep(s);
  }, []);

  const back = useCallback(() => {
    if (step === 'face') go('consent');
    else onExit();
  }, [step, go, onExit]);

  // Android's back button follows the arrow (iOS has no hardware back).
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back();
      return true;
    });
    return () => sub.remove();
  }, [back]);

  const checked = consentAt !== null;
  const tag = embedder.preview && showPreviewTag ? ENROLL_COPY.previewTag : undefined;

  return (
    <Screen>
      <StepHeader step={STEPS.indexOf(step)} count={STEPS.length} onBack={back} tag={tag} />
      {step === 'consent' ? (
        <StepScaffold
          title={ENROLL_COPY.consentTitle}
          alert={alert}
          action={
            <PrimaryButton
              testID="enroll-continue"
              label={ENROLL_COPY.continue}
              disabled={!checked || consent === null}
              onPress={() => go('face')}
            />
          }
          secondary={
            saved ? undefined : (
              // A plain text action, so the disabled "Continue" pill above reads as disabled.
              <TextButton
                tone="plain"
                testID="enroll-skip"
                label={ENROLL_COPY.skip}
                onPress={onSkip}
              />
            )
          }
        >
          {consent === null ? (
            alert ? (
              <QuietButton label="Try again" onPress={loadConsent} />
            ) : (
              <ActivityIndicator color={palette.textSecondary} />
            )
          ) : (
            <>
              {/* The consent text sits straight on black between two hairlines and scrolls
                  inside them: no boxed card. */}
              <Hairline />
              <ScrollView style={styles.flex} contentContainerStyle={styles.consentInner}>
                <BodyText>{consent.text}</BodyText>
              </ScrollView>
              <Hairline />
              <View style={styles.consentCheck}>
                <CheckRow
                  testID="enroll-consent"
                  label={ENROLL_COPY.consentCheck}
                  checked={checked}
                  onToggle={
                    saved ? undefined : () => setConsentAt(checked ? null : new Date(now()))
                  }
                />
              </View>
            </>
          )}
        </StepScaffold>
      ) : (
        <StepScaffold
          title={ENROLL_COPY.faceTitle}
          body={ENROLL_COPY.faceBody}
          alert={alert}
          action={
            <PrimaryButton
              testID="enroll-done"
              label={ENROLL_COPY.done}
              disabled={!saved}
              onPress={onDone}
            />
          }
        >
          {consent && consentAt ? (
            <PanelErrorBoundary name="Face camera" onError={() => undefined}>
              <Suspense fallback={<ActivityIndicator color={palette.textSecondary} />}>
                <FaceCapturePanel
                  api={api}
                  embedder={embedder}
                  consent={consent}
                  consentAt={consentAt}
                  now={now}
                  saved={saved}
                  onSaved={() => setSaved(true)}
                  onAlert={setAlert}
                />
              </Suspense>
            </PanelErrorBoundary>
          ) : null}
        </StepScaffold>
      )}
    </Screen>
  );
}

export function FaceSettings({
  api,
  onBack,
  onSetUp,
}: {
  api: FaceApi;
  onBack: () => void;
  /** "Set up face" when nothing is saved: opens FaceEnrollFlow. */
  onSetUp: () => void;
}) {
  const [status, setStatus] = useState<FaceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);

  useEffect(() => {
    api
      .getStatus()
      .then(setStatus)
      .catch(() => setAlert('Try again'));
  }, [api]);

  const run = useCallback(async (f: () => Promise<void>) => {
    setBusy(true);
    setAlert(null);
    try {
      await f();
    } catch (e) {
      setAlert(e instanceof FaceApiError ? enrollErrorLabel(e.code) : 'Try again');
    } finally {
      setBusy(false);
    }
  }, []);

  const toggle = (on: boolean) =>
    void run(async () => {
      await api.setStatus(on ? 'active' : 'disabled');
      setStatus(on ? 'active' : 'disabled');
    });

  const remove = () =>
    void run(async () => {
      await api.remove();
      setConfirming(false);
      setStatus('none');
    });

  const enrolled = status === 'active' || status === 'disabled';

  return (
    <Screen>
      <View style={styles.titleBar}>
        <StepHeader step={0} count={0} onBack={onBack} />
      </View>
      <View style={styles.settings}>
        <Label variant="title">{ENROLL_COPY.settingsTitle}</Label>
        {status === null ? (
          <ActivityIndicator style={styles.spinner} color={palette.textSecondary} />
        ) : enrolled ? (
          <>
            <View style={styles.savedHead}>
              <CheckBadge size={40} />
              <Label variant="subtitle">{ENROLL_COPY.savedTitle}</Label>
            </View>
            <BodyText style={styles.gap}>{ENROLL_COPY.savedBody}</BodyText>
            <View style={styles.rows}>
              <Hairline />
              {status === 'active' ? (
                <SavedRow label={ENROLL_COPY.faceRow} value={ENROLL_COPY.savedValue} />
              ) : (
                <SavedRow label={ENROLL_COPY.faceRow} value={ENROLL_COPY.offValue} />
              )}
              <Hairline />
              <ToggleRow
                testID="face-matching"
                label={ENROLL_COPY.matchingToggle}
                value={status === 'active'}
                disabled={busy}
                onChange={toggle}
              />
              <Hairline />
            </View>
          </>
        ) : (
          <>
            {/* 17/500 white, not a second bold heading under "Face matching". */}
            <Label variant="rowMedium" style={styles.gapLarge}>
              {ENROLL_COPY.noneTitle}
            </Label>
            <BodyText style={styles.gap}>{ENROLL_COPY.noneBody}</BodyText>
          </>
        )}
        <View style={styles.flex} />
        {/* Generic errors stay in the text color; red is for destructive actions only. */}
        <View style={styles.alertSlot}>{alert ? <Label>{alert}</Label> : null}</View>
        {enrolled ? (
          <DangerButton
            testID="face-delete"
            label={ENROLL_COPY.deleteButton}
            disabled={busy}
            onPress={() => setConfirming(true)}
          />
        ) : status === 'none' ? (
          <PrimaryButton label={ENROLL_COPY.setUp} onPress={onSetUp} />
        ) : null}
      </View>
      <ConfirmSheet
        visible={confirming}
        title={ENROLL_COPY.deleteTitle}
        body={ENROLL_COPY.deleteBody}
        confirmLabel={ENROLL_COPY.deleteYes}
        cancelLabel={ENROLL_COPY.deleteNo}
        busy={busy}
        onConfirm={remove}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Text on the 20 pt page margin (no inset), breathing room above and below the hairlines.
  consentInner: { paddingVertical: space.x2 + half.x05 },
  consentCheck: { marginTop: space.x1 },
  titleBar: { marginBottom: space.x1 },
  settings: {
    flex: 1,
    paddingHorizontal: space.page,
    paddingBottom: space.x2,
    paddingTop: space.x1,
  },
  spinner: { marginTop: space.x4 },
  savedHead: { flexDirection: 'row', alignItems: 'center', gap: half.x15, marginTop: space.x4 },
  gap: { marginTop: half.x15 },
  gapLarge: { marginTop: space.x4 },
  // Saved + toggle as plain rows on black, a hairline above, between and below.
  rows: { marginTop: space.x4 },
  alertSlot: { height: space.x4, alignItems: 'center', justifyContent: 'center' },
});
