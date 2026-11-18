// The live rivalry scan with no camera: a dark camera-like backdrop with placeholder heads moving
// as in src/rivalry/previewScript (a pan across Jake, Priya, a stranger and Sam), the REAL engine
// fed by the script's fake camera, embedder and server, and the REAL <RivalryOverlay>. For the
// offline preview app (a `scan-live` route) and screenshots.
//
// `frozenAtMs` replays the script up to that time on a fake clock (simulateTo) and holds that
// frame, so screenshots are deterministic: 2500 (Jake), 6500 (Priya: streak, rivals), 9500 (Sam:
// first bet, plus the stranger's ring). The replay resolves in a few milliseconds after mount.
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { createLiveScanEngine, type LiveScanEngine } from '../app/liveScan';
import type { ChallengeResult, ScanMatch } from '../app/scan';
import { palette } from '../ui/tokens';
import { overlayItems } from './geometry';
import {
  createFakeClock,
  createPreviewLiveDeps,
  panDetections,
  PREVIEW_FRAME_MS,
  PREVIEW_LOOP_MS,
  simulateTo,
  type PreviewDetection,
} from './previewScript';
import { DEFAULT_CARD_SIZE, PILL_SIZE, RivalryOverlay } from './RivalryOverlay';
import type { LiveSnapshot, Size } from './types';

export interface RivalryPreviewProps {
  /** The stage size; measured from layout when absent. */
  view?: Size;
  /** Length of one pass of the script (default 12 s). */
  loopMs?: number;
  /** Hold this frame of the script (deterministic screenshots). */
  frozenAtMs?: number;
  /** The Challenge tap; resolves 'ok' after a moment when absent. */
  onChallenge?(m: ScanMatch): Promise<ChallengeResult>;
}

const fakeChallenge = () =>
  new Promise<ChallengeResult>((resolve) => setTimeout(() => resolve('ok'), 500));

export function RivalryPreview({
  view: fixedView,
  loopMs = PREVIEW_LOOP_MS,
  frozenAtMs,
  onChallenge,
}: RivalryPreviewProps) {
  const [measured, setMeasured] = useState<Size | null>(null);
  const view = fixedView ?? measured;
  const [heads, setHeads] = useState<readonly PreviewDetection[]>([]);
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [engine, setEngine] = useState<LiveScanEngine | null>(null);
  const [cardSize, setCardSize] = useState<Size>(DEFAULT_CARD_SIZE);
  const [challengingKey, setChallengingKey] = useState<string | null>(null);
  const vw = view?.width;
  const vh = view?.height;
  const stableView = useMemo(
    () => (vw !== undefined && vh !== undefined ? { width: vw, height: vh } : null),
    [vw, vh],
  );

  useEffect(() => {
    if (!stableView) return;
    if (frozenAtMs !== undefined) {
      // A fixed frame: replay the script on a fake clock up to frozenAtMs.
      const clock = createFakeClock(0);
      const e = createLiveScanEngine(
        createPreviewLiveDeps(stableView, { timing: clock, startMs: 0, loopMs }),
      );
      let live = true;
      e.start();
      setEngine(e);
      void simulateTo(e, clock, stableView, frozenAtMs, { loopMs }).then(() => {
        if (!live) return;
        setHeads(panDetections(frozenAtMs, stableView, loopMs));
        setSnap(e.snapshot());
      });
      return () => {
        live = false;
        e.stop();
      };
    }
    // Live: the script plays in real time, looping.
    const start = Date.now();
    const e = createLiveScanEngine(createPreviewLiveDeps(stableView, { startMs: start, loopMs }));
    const unsubscribe = e.subscribe(setSnap);
    e.start();
    setEngine(e);
    const id = setInterval(() => {
      const now = Date.now();
      const dets = panDetections(now - start, stableView, loopMs);
      setHeads(dets);
      e.ingest(dets, stableView, now);
    }, PREVIEW_FRAME_MS);
    return () => {
      clearInterval(id);
      unsubscribe();
      e.stop();
    };
  }, [stableView, frozenAtMs, loopMs]);

  const challenge = async (key: string) => {
    if (!engine || challengingKey !== null) return;
    setChallengingKey(key);
    try {
      const target = await engine.challengeTarget(key);
      if (typeof target !== 'string') await (onChallenge ?? fakeChallenge)(target);
    } finally {
      setChallengingKey(null);
    }
  };

  const onLayout = (e: LayoutChangeEvent) => {
    if (fixedView) return;
    const { width, height } = e.nativeEvent.layout;
    setMeasured((cur) =>
      cur && cur.width === width && cur.height === height ? cur : { width, height },
    );
  };

  const items = snap ? overlayItems(snap, { card: cardSize, pill: PILL_SIZE }) : [];
  return (
    <View
      style={[
        styles.stage,
        fixedView ? { width: fixedView.width, height: fixedView.height } : null,
      ]}
      onLayout={onLayout}
      testID="rivalry-preview"
    >
      {heads.map((d) => (
        <Head key={d.trackingId} d={d} />
      ))}
      <RivalryOverlay
        items={items}
        status={snap?.status ?? 'idle'}
        challengingKey={challengingKey}
        onChallenge={(key) => void challenge(key)}
        onCardSize={(s) =>
          setCardSize((cur) => (cur.width === s.width && cur.height === s.height ? cur : s))
        }
        reduceMotion={frozenAtMs !== undefined}
      />
    </View>
  );
}

/** A placeholder person: a head where the detector box is, shoulders under it. */
function Head({ d }: { d: PreviewDetection }) {
  const { x, y, width, height } = d.bounds;
  return (
    <View pointerEvents="none">
      <View
        style={[
          styles.shoulders,
          {
            left: x - width * 0.45,
            top: y + height * 0.92,
            width: width * 1.9,
            height: height * 1.2,
            borderTopLeftRadius: width,
            borderTopRightRadius: width,
          },
        ]}
      />
      <View
        style={[
          styles.head,
          { left: x, top: y, width, height, borderRadius: Math.min(width, height) / 2 },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, overflow: 'hidden', backgroundColor: palette.background },
  head: { position: 'absolute', backgroundColor: palette.hairline },
  shoulders: { position: 'absolute', backgroundColor: palette.surface },
});
