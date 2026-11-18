// Face pipeline smoke test on the phone (TASKS D1-M3; docs/qa-device.md "Face embed"): take a
// still, detect the face, run the real embedder (enroll/embedder.ts createModelEmbedder) and
// show the 112 × 112 crop the model saw, the time it took, and the cosine with the previous
// capture. Same person across captures should score well above 0.30; two people well below.
// Nothing is stored; each photo is deleted after use. Lazy-loaded by the diagnostics screen.
import { File } from 'expo-file-system';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Button, StyleSheet, Switch, Text, View } from 'react-native';
import { NativeNitroImage, type Image } from 'react-native-nitro-image';
import { Camera, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';
import {
  createImageFaceDetector,
  type ImageFaceDetector,
} from 'react-native-vision-camera-face-detector';

import { createModelEmbedder } from '../enroll/embedder';
import { cosine } from '../enroll/flow';
import { l2NormalizeInPlace } from '../face/model';
import { pickScanFace } from '../face/scan';
import { describeError } from './runner';

const toFileUrl = (p: string) => (p.startsWith('file://') ? p : `file://${p}`);

export default function FaceEmbedPanel() {
  const permission = useCameraPermission();
  const photoOutput = usePhotoOutput({ containerFormat: 'jpeg', quality: 0.9 });
  const outputs = useMemo(() => [photoOutput], [photoOutput]);
  const [front, setFront] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [busy, setBusy] = useState(false);
  const [crop, setCrop] = useState<Image | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const previous = useRef<Float32Array | null>(null);

  const detectorRef = useRef<ImageFaceDetector | null>(null);
  const detector = useCallback(() => {
    detectorRef.current ??= createImageFaceDetector({
      performanceMode: 'accurate',
      runLandmarks: true,
      runClassifications: false,
    });
    return detectorRef.current;
  }, []);
  const embedder = useMemo(() => createModelEmbedder({ mirror, onCrop: setCrop }), [mirror]);

  const capture = async () => {
    setBusy(true);
    let url: string | null = null;
    const log = (s: string) => setLines((l) => [s, ...l].slice(0, 6));
    try {
      const photo = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
      url = toFileUrl(photo.filePath);
      const picked = pickScanFace(detector().detectFaces(url));
      if (!picked.ok) {
        log(`no usable face (${picked.problem})`);
        return;
      }
      const t0 = performance.now();
      const v = await embedder.embed(url, picked.face);
      const ms = performance.now() - t0;
      const norm = l2NormalizeInPlace(v);
      const cos = previous.current ? cosine(previous.current, v) : null;
      previous.current = v;
      const line =
        `${front ? 'front' : 'back'}${mirror ? ' mirrored' : ''}: ${ms.toFixed(0)} ms, ` +
        `norm ${norm.toFixed(2)}, yaw ${picked.face.yawAngle.toFixed(0)}°` +
        (cos === null ? '' : `, cos vs previous ${cos.toFixed(3)}`);
      log(line);
      console.log('[face-embed]', JSON.stringify({ ms, norm, cos, front, mirror }));
    } catch (e) {
      log(`failed: ${describeError(e)}`);
    } finally {
      if (url) {
        try {
          new File(url).delete();
        } catch {
          // best effort
        }
      }
      setBusy(false);
    }
  };

  if (!permission.hasPermission) {
    return <Button title="Allow camera" onPress={() => void permission.requestPermission()} />;
  }
  return (
    <View style={styles.box}>
      <Text style={styles.title}>Face embed (D1-M3)</Text>
      <View style={styles.preview}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={front ? 'front' : 'back'}
          isActive
          outputs={outputs}
        />
      </View>
      <View style={styles.row}>
        <Text>Front camera</Text>
        <Switch value={front} onValueChange={setFront} />
        <Text>Mirror crop</Text>
        <Switch value={mirror} onValueChange={setMirror} />
      </View>
      <View style={styles.row}>
        <Button
          title={busy ? 'Embedding…' : 'Capture + embed'}
          disabled={busy}
          onPress={() => void capture()}
        />
        <Button title="Reset" onPress={() => (previous.current = null)} />
      </View>
      <View style={styles.row}>
        {crop ? <NativeNitroImage image={crop} style={styles.crop} /> : null}
        <View style={styles.flex}>
          {lines.map((l, i) => (
            <Text key={i} style={styles.line}>
              {l}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8, padding: 8, borderWidth: 1, borderColor: '#ddd', borderRadius: 8 },
  title: { fontWeight: '600' },
  preview: { height: 280, borderRadius: 8, overflow: 'hidden', backgroundColor: '#000' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  crop: { width: 112, height: 112, backgroundColor: '#eee' },
  flex: { flex: 1 },
  line: { fontSize: 12 },
});
