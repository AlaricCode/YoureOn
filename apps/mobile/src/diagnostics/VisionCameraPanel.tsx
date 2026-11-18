// VisionCamera 5 panel: the preview check (first frame) and the ML Kit still-image check
// (capture a photo to a file, then run the still-image face detector with landmarks in
// 'accurate' mode, which only takes effect on iOS with patches/react-native-vision-camera-face-
// detector+2.1.0.patch). Loaded lazily by the diagnostics screen, so a missing native module
// fails this panel only.
import { File } from 'expo-file-system';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';
import {
  createImageFaceDetector,
  type ImageFaceDetector,
} from 'react-native-vision-camera-face-detector';

import { useVisionCameraPresence } from '../device/visionCamera';
import type { PanelProps } from './panelTypes';
import { describeError, runCheck } from './runner';

/** VisionCamera returns plain paths; the still detector wants a file:// URL. */
export function toFileUrl(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export default function VisionCameraPanel({ onResult }: PanelProps) {
  const permission = useCameraPermission();
  const presence = useVisionCameraPresence('front');
  useEffect(() => {
    if (presence !== 'none') return;
    onResult('vision-camera-preview', {
      status: 'fail',
      detail: 'no camera device on this phone',
      at: new Date().toISOString(),
    });
  }, [presence, onResult]);
  const photoOutput = usePhotoOutput({ containerFormat: 'jpeg', quality: 0.9 });
  const outputs = useMemo(() => [photoOutput], [photoOutput]);
  const previewReported = useRef(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  // The face detector's hooks re-create the detector on every render (FINDINGS §7), so create
  // one ourselves, lazily, and keep it for the panel's lifetime.
  const detectorRef = useRef<ImageFaceDetector | null>(null);
  const getDetector = useCallback(() => {
    detectorRef.current ??= createImageFaceDetector({
      performanceMode: 'accurate',
      runLandmarks: true,
      runClassifications: true,
    });
    return detectorRef.current;
  }, []);

  const onPreviewStarted = useCallback(() => {
    if (previewReported.current) return;
    previewReported.current = true;
    onResult('vision-camera-preview', {
      status: 'pass',
      detail: 'first preview frame received (front camera)',
      at: new Date().toISOString(),
    });
  }, [onResult]);

  const onError = useCallback(
    (error: Error) => {
      onResult('vision-camera-preview', {
        status: 'fail',
        detail: `camera error: ${describeError(error)}`,
        at: new Date().toISOString(),
      });
    },
    [onResult],
  );

  const captureAndDetect = useCallback(async () => {
    setBusy(true);
    onResult('mlkit-still-face', { status: 'running', detail: 'capturing…' });
    const result = await runCheck(async () => {
      const t0 = performance.now();
      const photo = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
      const t1 = performance.now();
      const url = toFileUrl(photo.filePath);
      try {
        const faces = getDetector().detectFaces(url);
        const t2 = performance.now();
        const first = faces[0];
        if (!first) {
          throw new Error(
            `no face found in ${photo.width}x${photo.height} still (capture ${(t1 - t0).toFixed(0)} ms)`,
          );
        }
        const lm = first.landmarks;
        const hasEyesMouth = Boolean(
          lm?.LEFT_EYE && lm.RIGHT_EYE && lm.MOUTH_LEFT && lm.MOUTH_RIGHT,
        );
        return (
          `${faces.length} face(s) in ${photo.width}x${photo.height}; ` +
          `eyes+mouth landmarks=${hasEyesMouth}; yaw ${first.yawAngle.toFixed(1)}; ` +
          `capture ${(t1 - t0).toFixed(0)} ms, detect ${(t2 - t1).toFixed(0)} ms`
        );
      } finally {
        try {
          new File(url).delete();
        } catch {
          // best effort: the OS clears the temp directory anyway
        }
      }
    });
    onResult('mlkit-still-face', result);
    setNote(result.detail);
    setBusy(false);
  }, [getDetector, onResult, photoOutput]);

  if (!permission.hasPermission) {
    return (
      <View style={styles.panel}>
        <Text>Camera permission: {permission.status}</Text>
        <Button
          title={permission.canRequestPermission ? 'Grant camera access' : 'Open Settings to allow'}
          onPress={() => {
            void permission.requestPermission().then((granted) => {
              if (!granted) {
                onResult('vision-camera-preview', {
                  status: 'fail',
                  detail: `camera permission ${permission.status}`,
                  at: new Date().toISOString(),
                });
              }
            });
          }}
        />
      </View>
    );
  }

  // No camera (the simulator): <Camera> would throw on the missing accelerometer.
  if (presence !== 'present') {
    return (
      <View style={styles.panel}>
        <Text style={styles.note}>
          {presence === 'none' ? 'No camera device on this phone' : 'Looking for the camera…'}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <Camera
        style={styles.preview}
        device="front"
        isActive
        outputs={outputs}
        onPreviewStarted={onPreviewStarted}
        onError={onError}
      />
      <Button
        title={busy ? 'Detecting…' : 'Capture still + detect face'}
        disabled={busy}
        onPress={() => void captureAndDetect()}
      />
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  preview: { width: '100%', aspectRatio: 3 / 4, borderRadius: 8, overflow: 'hidden' },
  note: { fontSize: 12, color: '#444' },
});
