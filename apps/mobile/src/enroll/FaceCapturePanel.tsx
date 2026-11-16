// The camera part of "Register face" (TASKS D3-M3 steps 3-5), in the enroll redesign's style:
// the camera asks for access the moment the step shows; a bubble at the top gives the prompt
// ("Look ahead", "Turn left"…); a tick flashes after each good photo; a bad photo gets a red
// fix-it line and is simply retaken; after the last photo the bubble says "Checking…" while the
// series is checked and sent. Photos are deleted right after they are read: only the averaged
// embedding leaves the phone.
import { File } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Linking, StyleSheet, View } from 'react-native';
import { Camera, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';
import {
  createImageFaceDetector,
  type ImageFaceDetector,
} from 'react-native-vision-camera-face-detector';

import { CheckBadge, Label, QuietButton, ShutterButton, Stage, StageBubble } from '../ui/kit';
import { motion, palette, space } from '../ui/tokens';
import { FaceApiError, type FaceApi } from './api';
import type { FaceEmbedder } from './embedder';
import {
  averageEmbedding,
  buildEnrollmentRequest,
  checkSeries,
  checkShot,
  enrollErrorLabel,
  makePrompts,
  plainEmbedding,
  problemLabel,
  PROMPT_LABEL,
  SERIES_PROBLEM_LABEL,
  SHOTS,
  type FaceConsent,
  type Shot,
} from './flow';

const toFileUrl = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);

/** Camera access: asking (system prompt up), denied (ask again), blocked (settings only). */
type Access = 'granted' | 'asking' | 'denied' | 'blocked';

export function FaceCapturePanel({
  api,
  embedder,
  consent,
  consentAt,
  saved,
  onSaved,
  onAlert,
}: {
  api: FaceApi;
  embedder: FaceEmbedder;
  consent: FaceConsent;
  consentAt: Date;
  saved: boolean;
  onSaved: () => void;
  /** The red line under the step (owned by the step so it sits above the main button). */
  onAlert: (message: string | null) => void;
}) {
  const permission = useCameraPermission();
  const photoOutput = usePhotoOutput({ containerFormat: 'jpeg', quality: 0.9 });
  const outputs = useMemo(() => [photoOutput], [photoOutput]);
  const [prompts, setPrompts] = useState(() => makePrompts());
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** The system prompt is up. */
  const [requesting, setRequesting] = useState(false);
  /** The person has answered the system prompt at least once (or it can no longer be shown). */
  const [answered, setAnswered] = useState(false);
  const flash = useRef(new Animated.Value(0)).current;

  const detectorRef = useRef<ImageFaceDetector | null>(null);
  const detector = useCallback(() => {
    detectorRef.current ??= createImageFaceDetector({
      performanceMode: 'accurate',
      runLandmarks: true,
      runClassifications: false,
    });
    return detectorRef.current;
  }, []);

  const ask = useCallback(async () => {
    setRequesting(true);
    try {
      await permission.requestPermission();
    } finally {
      setRequesting(false);
      setAnswered(true);
    }
  }, [permission]);

  // Ask right away: the system "Allow camera" prompt shows as soon as this step appears.
  useEffect(() => {
    if (saved || permission.hasPermission || answered || requesting) return;
    if (!permission.canRequestPermission) {
      setAnswered(true);
      return;
    }
    void ask();
  }, [saved, permission.hasPermission, permission.canRequestPermission, answered, requesting, ask]);

  // Back from Settings with access turned on: the hook re-reads it when the app is active.
  const [, setTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setTick((t) => t + 1);
    });
    return () => sub.remove();
  }, []);

  const access: Access = permission.hasPermission
    ? 'granted'
    : requesting || !answered
      ? 'asking'
      : permission.canRequestPermission
        ? 'denied'
        : 'blocked';

  // Red line while access is missing; cleared once it is granted.
  const lastAccess = useRef<Access>(access);
  useEffect(() => {
    if (access === 'denied' || access === 'blocked') onAlert('Camera access needed');
    else if (access === 'granted' && lastAccess.current !== 'granted') onAlert(null);
    lastAccess.current = access;
  }, [access, onAlert]);

  const flashTick = useCallback(() => {
    flash.setValue(1);
    Animated.timing(flash, {
      toValue: 0,
      duration: 700,
      delay: motion.fastMs,
      useNativeDriver: true,
    }).start();
  }, [flash]);

  const restart = useCallback(
    (message: string) => {
      setShots([]);
      setPrompts(makePrompts());
      onAlert(message);
    },
    [onAlert],
  );

  const capture = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    onAlert(null);
    let url: string | null = null;
    try {
      const prompt = prompts[shots.length] ?? 'ahead';
      const photo = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
      url = toFileUrl(photo.filePath);
      const check = checkShot(prompt, detector().detectFaces(url));
      if (!check.ok) {
        // Keep the photos so far; just retake this one.
        onAlert(problemLabel(prompt, check.problem));
        return;
      }
      const shot: Shot = {
        prompt,
        yawAngle: check.face.yawAngle,
        embedding: await embedder.embed(url, check.face),
      };
      const next = [...shots, shot];
      if (next.length < SHOTS) {
        setShots(next);
        flashTick();
        return;
      }
      const problem = checkSeries(next);
      if (problem) {
        restart(SERIES_PROBLEM_LABEL[problem]);
        return;
      }
      setShots(next);
      setChecking(true);
      await api.enroll(
        buildEnrollmentRequest({
          consent,
          consentAt,
          passedAt: new Date(),
          embedding: plainEmbedding(averageEmbedding(next)),
        }),
      );
      onSaved();
    } catch (e) {
      restart(e instanceof FaceApiError ? enrollErrorLabel(e.code) : 'Try again');
    } finally {
      if (url) {
        try {
          new File(url).delete();
        } catch {
          // best effort: the OS clears the temp directory anyway
        }
      }
      setChecking(false);
      setBusy(false);
    }
  }, [
    busy,
    prompts,
    shots,
    photoOutput,
    detector,
    embedder,
    api,
    consent,
    consentAt,
    onSaved,
    onAlert,
    restart,
    flashTick,
  ]);

  if (saved) {
    return (
      <Stage style={styles.center}>
        <CheckBadge size={72} />
        <Label variant="title" style={styles.savedLabel}>
          Face saved
        </Label>
      </Stage>
    );
  }

  if (access !== 'granted') {
    return (
      <Stage style={styles.center}>
        <View style={styles.access}>
          {access === 'asking' ? (
            <Label style={styles.muted}>Allow camera access</Label>
          ) : access === 'denied' ? (
            <QuietButton label="Allow camera" onPress={() => void ask()} />
          ) : (
            <QuietButton label="Open settings" onPress={() => void Linking.openSettings()} />
          )}
        </View>
      </Stage>
    );
  }

  const prompt = prompts[shots.length] ?? 'ahead';
  return (
    <Stage>
      <Camera style={StyleSheet.absoluteFill} device="front" isActive outputs={outputs} />
      <StageBubble prompt={PROMPT_LABEL[prompt]} checking={checking} />
      <Animated.View pointerEvents="none" style={[styles.flash, { opacity: flash }]}>
        <CheckBadge size={56} fill={palette.background} />
      </Animated.View>
      <View style={styles.shutterSlot}>
        <ShutterButton onPress={() => void capture()} disabled={busy} />
      </View>
    </Stage>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  savedLabel: { marginTop: space.x2 },
  access: { alignSelf: 'stretch', paddingHorizontal: space.x3, alignItems: 'stretch' },
  muted: { color: palette.textSecondary, textAlign: 'center' },
  flash: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterSlot: { position: 'absolute', left: 0, right: 0, bottom: space.x2 },
});
