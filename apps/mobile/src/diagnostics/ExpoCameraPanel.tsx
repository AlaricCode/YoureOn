// expo-camera panel: records 2 s with the judge-cam settings (avc1, 720p,
// ~5 Mbps), checks the file, then (extra check) pulls 2 frames with expo-video and hashes the clip
// with expo-crypto, the same path the judge cam uses for client_clip_hash. Loaded lazily, and
// never mounted together with the VisionCamera panel (two camera stacks are not opened at once).
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { useCallback, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';

import { palette, radius, type } from '../ui/tokens';
import type { PanelProps } from './panelTypes';
import { runCheck } from './runner';

const RECORD_MS = 2_000;
/** recordAsync resolves after stopRecording(); anything much shorter means it stopped early. */
const MIN_RECORD_MS = 1_800;
/** Safety net in case stopRecording() is never delivered. */
const MAX_DURATION_S = 5;
const VIDEO_BITRATE = 5_000_000;
const FRAME_TIMES_S = [0.5, 1.5];

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function waitForReady(player: VideoPlayer, timeoutMs = 5_000): Promise<void> {
  if (player.status === 'readyToPlay') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.remove();
      reject(new Error(`player not ready after ${timeoutMs} ms (status ${player.status})`));
    }, timeoutMs);
    const sub = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'readyToPlay') {
        clearTimeout(timer);
        sub.remove();
        resolve();
      } else if (status === 'error') {
        clearTimeout(timer);
        sub.remove();
        reject(new Error(`player error: ${error?.message ?? 'unknown'}`));
      }
    });
  });
}

export default function ExpoCameraPanel({ onResult }: PanelProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const record = useCallback(async () => {
    const camera = cameraRef.current;
    if (!camera) return;
    setBusy(true);
    onResult('expo-camera-record', { status: 'running', detail: 'recording 2 s…' });
    let clipUri: string | null = null;
    const recorded = await runCheck(
      async () => {
        const t0 = performance.now();
        const pending = camera.recordAsync({ codec: 'avc1', maxDuration: MAX_DURATION_S });
        const stopTimer = setTimeout(() => camera.stopRecording(), RECORD_MS);
        let out: { uri: string } | undefined;
        try {
          out = await pending;
        } finally {
          clearTimeout(stopTimer);
        }
        const t1 = performance.now();
        if (!out?.uri) throw new Error('recordAsync resolved without a uri');
        // The check is "records 2 s": a recording that ended early (interrupted session, a stop
        // before the start) is a failure even if it left a file behind.
        if (t1 - t0 < MIN_RECORD_MS) {
          throw new Error(
            `recording ended after ${(t1 - t0).toFixed(0)} ms, expected ~${RECORD_MS}`,
          );
        }
        const file = new File(out.uri);
        if (!file.exists) throw new Error(`no file at ${out.uri}`);
        const size = file.size ?? 0;
        if (size <= 0) throw new Error('recorded file is empty');
        clipUri = out.uri;
        return `${(size / 1024).toFixed(0)} KB in ${(t1 - t0).toFixed(0)} ms (avc1, 720p)`;
      },
      { timeoutMs: 15_000 },
    );
    onResult('expo-camera-record', recorded);

    if (clipUri !== null) {
      const uri: string = clipUri;
      onResult('expo-video-frames', { status: 'running', detail: 'extracting frames…' });
      const frames = await runCheck(
        async () => {
          const player = createVideoPlayer(uri);
          try {
            await waitForReady(player);
            const thumbs = await player.generateThumbnailsAsync(FRAME_TIMES_S, {
              maxWidth: 512,
              maxHeight: 512,
            });
            if (thumbs.length !== FRAME_TIMES_S.length) {
              throw new Error(`got ${thumbs.length} frames, expected ${FRAME_TIMES_S.length}`);
            }
            const bytes = await new File(uri).arrayBuffer();
            const digest = toHex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
            const first = thumbs[0];
            return `${thumbs.length} frames ${first?.width ?? 0}x${first?.height ?? 0}; sha256 ${digest.slice(0, 12)}…`;
          } finally {
            player.release();
          }
        },
        { timeoutMs: 15_000 },
      );
      onResult('expo-video-frames', frames);
      try {
        new File(uri).delete();
      } catch {
        // best effort
      }
      setNote(`${recorded.detail}\n${frames.detail}`);
    } else {
      setNote(recorded.detail);
    }
    setBusy(false);
  }, [onResult]);

  if (!permission) return <Text style={styles.text}>Checking camera permission…</Text>;
  if (!permission.granted) {
    return (
      <View style={styles.panel}>
        <Text style={styles.text}>Camera permission: {permission.status}</Text>
        <Button
          color={palette.accent}
          title="Grant camera access"
          onPress={() => void requestPermission()}
        />
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <CameraView
        ref={cameraRef}
        style={styles.preview}
        facing="back"
        mode="video"
        mute
        videoQuality="720p"
        videoBitrate={VIDEO_BITRATE}
        onCameraReady={() => setReady(true)}
        onMountError={(e) =>
          onResult('expo-camera-record', {
            status: 'fail',
            detail: `mount error: ${e.message}`,
            at: new Date().toISOString(),
          })
        }
      />
      <Button
        color={palette.accent}
        title={busy ? 'Recording…' : ready ? 'Record 2 s' : 'Waiting for camera…'}
        disabled={!ready || busy}
        onPress={() => void record()}
      />
      {note ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 8 },
  preview: { width: '100%', aspectRatio: 16 / 9, borderRadius: radius.lg, overflow: 'hidden' },
  text: { ...type.label },
  note: { ...type.small },
});
