// The live rivalry scan's camera: the back camera with two outputs, the ML Kit face detector
// (tracking on, 10-15 Hz, drives the tracker and the overlay) and the photo output (one photo
// per identification job, deleted right after). The engine (src/app/liveScan.ts) decides when to
// take a photo and who to match; this file is the native plumbing plus <RivalryOverlay>.
//
// Degrades cleanly: no camera (the simulator), no camera permission, a detector module missing
// from the build, a detector error, or a detector that never reports anything all call
// `onUnavailable(why)` and render nothing, so the scan screen keeps today's tap-to-scan.
//
// The detector module creates native objects as it loads, so it is imported on first use through
// importSafely (like src/face/native.ts): a build without it fails only this component.
//
// PENDING-PHONE: the photo and detector outputs run together on iOS; the still-to-view pairing
// error is under 0.3 x face width; first stats in under 1 s; no shutter sound; heat over 5 min;
// whether ML Kit calls back with an empty list when no face is in view (DETECTOR_SILENT_MS).
import { File } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  AppState,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import {
  Camera,
  useCameraPermission,
  usePhotoOutput,
  type CameraOutput,
  type CameraRef,
} from 'react-native-vision-camera';
import type { Face } from 'react-native-vision-camera-face-detector';

import { createLiveScanEngine, type LiveScanDeps, type LiveScanEngine } from '../app/liveScan';
import { importSafely } from '../app/importSafely';
import type { ChallengeResult, ScanMatch, ScanMiss } from '../app/scan';
import { useVisionCameraPresence } from '../device/visionCamera';
import type { Box } from '../face/pipeline';
import { overlayItems } from './geometry';
import { DEFAULT_CARD_SIZE, PILL_SIZE, RivalryOverlay } from './RivalryOverlay';
import type { LiveSnapshot, LiveStatus, RawDetection, Size } from './types';

/** Detector frames closer together than this are dropped (~15 Hz is plenty). */
export const MIN_FRAME_MS = 66;
/** No detector callback at all this long after the preview started: treat it as unavailable. */
export const DETECTOR_SILENT_MS = 8_000;
/** Detector errors in a row (no successful frame between) before live scan gives up. ML Kit can
 *  fail one frame (a buffer it could not convert) without the detector being broken. */
export const DETECTOR_MAX_ERRORS = 5;

export type LiveUnavailable =
  | 'no_camera'
  | 'no_permission'
  | 'detector_missing'
  | 'detector_error'
  | 'detector_silent'
  | 'camera_error';

export interface LiveScanCameraProps {
  /** The room's face-match call, the embedder and the server-corrected clock (as for runScan). */
  deps: Pick<LiveScanDeps, 'embedder' | 'faceMatch' | 'now'>;
  /** Off while a sheet covers the camera, the screen is leaving, or a challenge is open. */
  isActive: boolean;
  /** POST /v1/bets with challenge_method 'face' and the ticket (DemoApp challengeByFace). */
  onChallenge(m: ScanMatch): Promise<ChallengeResult>;
  onStatus?(s: LiveStatus): void;
  /** Why a Challenge tap found nobody to address (show SCAN_MISS_COPY[miss]). */
  onMiss?(m: ScanMiss): void;
  /** Live scan cannot run here: show the tap scan instead. */
  onUnavailable?(why: LiveUnavailable): void;
  /** Space the overlay keeps clear at the top (the scan screen's bubble) and bottom. */
  insets?: { top: number; bottom: number };
  testID?: string;
}

const toFileUrl = (path: string) => (path.startsWith('file://') ? path : `file://${path}`);

function deletePhoto(url: string): void {
  try {
    new File(url).delete();
  } catch {
    // best effort: the OS clears the temp directory anyway
  }
}

/** A detector box (camera coordinates, autoMode) -> view points, via the preview. */
function toView(b: Box, cam: Pick<CameraRef, 'convertCameraPointToViewPoint'>): Box {
  const a = cam.convertCameraPointToViewPoint({ x: b.x, y: b.y });
  const c = cam.convertCameraPointToViewPoint({ x: b.x + b.width, y: b.y + b.height });
  const x = Math.min(a.x, c.x);
  const y = Math.min(a.y, c.y);
  return { x, y, width: Math.abs(c.x - a.x), height: Math.abs(c.y - a.y) };
}

export function LiveScanCamera(props: LiveScanCameraProps) {
  const { isActive, testID } = props;
  const permission = useCameraPermission();
  const presence = useVisionCameraPresence('back');
  const [unavailable, setUnavailable] = useState<LiveUnavailable | null>(null);

  // Latest props, read by long-lived callbacks without re-creating the engine or the outputs.
  const latest = useRef(props);
  latest.current = props;

  // Reported once. The callback runs outside the state updater (updaters must stay pure: React
  // may run them twice).
  const failed = useRef(false);
  const fail = useCallback((why: LiveUnavailable) => {
    if (failed.current) return;
    failed.current = true;
    setUnavailable(why);
    latest.current.onUnavailable?.(why);
  }, []);

  useEffect(() => {
    if (presence === 'none') fail('no_camera');
  }, [presence, fail]);
  useEffect(() => {
    if (!permission.hasPermission && !permission.canRequestPermission) fail('no_permission');
  }, [permission.hasPermission, permission.canRequestPermission, fail]);

  if (unavailable !== null || presence !== 'present' || !permission.hasPermission) {
    return <View style={StyleSheet.absoluteFill} pointerEvents="none" testID={testID} />;
  }
  return <LiveScanSession latest={latest} isActive={isActive} fail={fail} testID={testID} />;
}

function LiveScanSession({
  latest,
  isActive,
  fail,
  testID,
}: {
  latest: { readonly current: LiveScanCameraProps };
  isActive: boolean;
  fail: (why: LiveUnavailable) => void;
  testID: string | undefined;
}) {
  const cameraRef = useRef<CameraRef>(null);
  // Speed over quality: one photo per identification job, and time to first stats is the point.
  const photoOutput = usePhotoOutput({
    containerFormat: 'jpeg',
    quality: 0.9,
    qualityPrioritization: 'speed',
  });
  const [detectorOutput, setDetectorOutput] = useState<CameraOutput | null>(null);
  const [view, setView] = useState<Size | null>(null);
  const viewRef = useRef<Size | null>(null);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [cardSize, setCardSize] = useState<Size>(DEFAULT_CARD_SIZE);
  const [challengingKey, setChallengingKey] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const lastFrameAt = useRef(-Infinity);
  const sawDetector = useRef(false);
  const detectorErrors = useRef(0);
  /** A Challenge is running (a ref, so a double tap before the re-render can't start two). */
  const challengingRef = useRef(false);

  // The engine, once per mount; deps read the latest props.
  const engine: LiveScanEngine = useMemo(
    () =>
      createLiveScanEngine({
        captureStill: async () => {
          const photo = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
          return toFileUrl(photo.filePath);
        },
        embedder: {
          get preview() {
            return latest.current.deps.embedder.preview;
          },
          open: (url) => latest.current.deps.embedder.open(url),
        },
        faceMatch: (req) => latest.current.deps.faceMatch(req),
        deletePhoto,
        now: () => latest.current.deps.now(),
        setTimer: (fn, ms) => {
          const id = setTimeout(fn, ms);
          return () => clearTimeout(id);
        },
      }),
    [latest, photoOutput],
  );

  useEffect(() => engine.subscribe(setSnap), [engine]);
  useEffect(() => () => engine.stop(), [engine]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((on) => {
        if (live) setReduceMotion(on);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  // The detector output: created once, on first use (see the header).
  useEffect(() => {
    let live = true;
    importSafely(() => import('react-native-vision-camera-face-detector'))
      .then(({ createFaceDetectorOutput }) => {
        if (!live) return;
        const output = createFaceDetectorOutput({
          performanceMode: 'fast',
          trackingEnabled: true,
          runLandmarks: false,
          runContours: false, // ML Kit turns tracking off when contours are on
          runClassifications: false,
          minFaceSize: 0.1,
          autoMode: true,
          cameraFacing: 'back',
          outputResolution: 'preview',
          onFacesDetected: (faces: Face[]) => onFaces.current(faces),
          onError: () => {
            detectorErrors.current += 1;
            if (detectorErrors.current >= DETECTOR_MAX_ERRORS) fail('detector_error');
          },
        });
        setDetectorOutput(output);
      })
      .catch(() => fail('detector_missing'));
    return () => {
      live = false;
    };
  }, [fail]);

  const onFaces = useRef<(faces: Face[]) => void>(() => undefined);
  onFaces.current = (faces) => {
    sawDetector.current = true;
    detectorErrors.current = 0;
    const cam = cameraRef.current;
    const v = viewRef.current;
    if (!cam || !v) return;
    const now = latest.current.deps.now();
    if (now - lastFrameAt.current < MIN_FRAME_MS) return;
    lastFrameAt.current = now;
    // Copy out of the lazy native objects right away.
    const dets: RawDetection[] = [];
    try {
      for (const f of faces) {
        dets.push({
          trackingId: f.trackingId,
          bounds: toView(
            { x: f.bounds.x, y: f.bounds.y, width: f.bounds.width, height: f.bounds.height },
            cam,
          ),
          yawAngle: f.yawAngle,
        });
      }
    } catch {
      return; // the preview is not ready yet
    }
    engine.ingest(dets, v, now);
  };

  const running = isActive && appActive && detectorOutput !== null && view !== null;
  const cameraActive = useRef(false);
  cameraActive.current = isActive && appActive;
  useEffect(() => {
    if (running) engine.start();
    else engine.stop();
  }, [running, engine]);

  // A detector that never calls back at all: fall back to the tap scan. ML Kit calls back with an
  // empty list when nobody is in view, so silence means it is not running. Only while the camera
  // is still active: a sheet or the app going to the background within the window stops the
  // frames, which is not a broken detector (the next preview start arms it again).
  const silentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onPreviewStarted = useCallback(() => {
    if (silentTimer.current !== null || sawDetector.current) return;
    silentTimer.current = setTimeout(() => {
      silentTimer.current = null;
      if (!sawDetector.current && cameraActive.current) fail('detector_silent');
    }, DETECTOR_SILENT_MS);
  }, [fail]);
  useEffect(
    () => () => {
      if (silentTimer.current !== null) clearTimeout(silentTimer.current);
    },
    [],
  );

  const lastStatus = useRef<LiveStatus | null>(null);
  useEffect(() => {
    const s = snap?.status ?? null;
    if (s === null || s === lastStatus.current) return;
    lastStatus.current = s;
    latest.current.onStatus?.(s);
  }, [snap, latest]);

  const challenge = useCallback(
    async (key: string) => {
      if (challengingRef.current) return;
      challengingRef.current = true;
      setChallengingKey(key);
      try {
        const target = await engine.challengeTarget(key);
        if (typeof target === 'string') {
          latest.current.onMiss?.(target);
          return;
        }
        const r = await latest.current.onChallenge(target);
        if (r === 'expired') engine.markStale(key);
        if (r !== 'ok') latest.current.onMiss?.(r);
      } catch {
        latest.current.onMiss?.('failed');
      } finally {
        challengingRef.current = false;
        setChallengingKey(null);
      }
    },
    [engine, latest],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const v = { width, height };
    viewRef.current = v;
    setView(v);
  };

  const outputs = useMemo(
    () => (detectorOutput ? [photoOutput, detectorOutput] : [photoOutput]),
    [photoOutput, detectorOutput],
  );
  const items = snap
    ? overlayItems(snap, { card: cardSize, pill: PILL_SIZE }, latest.current.insets)
    : [];

  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout} testID={testID}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device="back"
        isActive={isActive && appActive}
        outputs={outputs}
        onPreviewStarted={onPreviewStarted}
        onError={() => fail('camera_error')}
      />
      <RivalryOverlay
        items={items}
        status={snap?.status ?? 'idle'}
        challengingKey={challengingKey}
        onChallenge={(key) => void challenge(key)}
        onCardSize={(s) =>
          setCardSize((cur) => (cur.width === s.width && cur.height === s.height ? cur : s))
        }
        reduceMotion={reduceMotion}
      />
    </View>
  );
}
