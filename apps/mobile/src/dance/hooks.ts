// React glue for the Dance Off: the persisted settings, the live store subscription, a frame
// clock for the moving parts, and the lazy pose module. The pose module (a native view) is only
// ever reached through importSafely, so a binary without it (or a failing one) costs the dance
// screen its camera, not the app (app/__tests__/bootImports).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type * as DancePose from '../../modules/dance-pose';
import { importSafely } from '../app/importSafely';
import { danceSettings } from './fs';
import type { LiveStore, LiveView } from './model/liveStore';
import type { DanceSettings } from './settings';

export type DancePoseModule = typeof DancePose;

/** One monotonic clock for the round: count-in, t0, the reference and the meters. */
export const nowMs = (): number => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
};

export function useDanceSettings(): [DanceSettings, (patch: Partial<DanceSettings>) => void] {
  const value = useSyncExternalStore(danceSettings.subscribe, danceSettings.get);
  useEffect(() => {
    void danceSettings.load();
  }, []);
  return [value, (patch) => void danceSettings.set(patch)];
}

/** A slice of the live view, re-rendering only when the store notifies (~15 Hz). */
export function useLive<T>(store: LiveStore, pick: (v: LiveView) => T): T {
  const view = useSyncExternalStore(store.subscribe, store.get);
  return pick(view);
}

/**
 * Re-renders at ~`fps` while `active` (requestAnimationFrame, skipping frames above the rate) and
 * returns the clock; stops when inactive.
 */
export function useFrameClock(active: boolean, fps = 30): number {
  const [now, setNow] = useState(nowMs);
  const last = useRef(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let live = true;
    const minGap = 1000 / fps - 2;
    const step = () => {
      if (!live) return;
      const t = nowMs();
      if (t - last.current >= minGap) {
        last.current = t;
        setNow(t);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
    };
  }, [active, fps]);
  return now;
}

let posePromise: Promise<DancePoseModule | null> | null = null;

/** The pose module, loaded once; null when it fails to load. */
export function loadDancePose(): Promise<DancePoseModule | null> {
  posePromise ??= importSafely(() => import('../../modules/dance-pose')).then(
    (m) => m,
    () => null,
  );
  return posePromise;
}

export type PoseModuleState =
  | { status: 'loading'; mod: null }
  | { status: 'ready'; mod: DancePoseModule }
  /** Not in this binary (an old build, the module failed to load): offer the debug replay. */
  | { status: 'missing'; mod: DancePoseModule | null };

export function useDancePose(): PoseModuleState {
  const [state, setState] = useState<PoseModuleState>({ status: 'loading', mod: null });
  useEffect(() => {
    let live = true;
    void loadDancePose().then((mod) => {
      if (!live) return;
      if (mod && mod.isDancePoseAvailable()) setState({ status: 'ready', mod });
      else setState({ status: 'missing', mod });
    });
    return () => {
      live = false;
    };
  }, []);
  return state;
}
