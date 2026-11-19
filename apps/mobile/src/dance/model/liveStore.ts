// The live display state (skeletons, meters, popups, debug numbers), outside React. Pose frames
// arrive at up to 30 Hz; writing them into React state would re-render the whole dance screen
// every frame. Instead the screen writes here on every frame and the small display components
// subscribe (useSyncExternalStore): listeners are called at most once per `minIntervalMs`
// (~15 Hz), with the latest values. Pure (the timer is injected), tested.
import type { FramingResult } from '@youre-on/shared/dance/track';
import type { KeyMoveGrade, LivePlayerState, LiveUpdate } from '@youre-on/shared/dance/score';

/** A PERFECT / GOOD / MISS popup on the camera panel. */
export interface Popup {
  id: number;
  player: 'A' | 'B';
  grade: KeyMoveGrade;
  name: string;
  /** When it was added (store clock). */
  at: number;
}

export interface LiveView {
  /** Image size of the last frame (the overlay maps into it). */
  w: number;
  h: number;
  /** Every person in the last frame (raw floats). */
  people: number[][];
  /**
   * The tracked players in the last frame. While framing: the face-identified players when
   * `byFace`, else the framing check's left (A) / right (B).
   */
  a: number[] | null;
  b: number[] | null;
  /** A and B were identified by face (DANCE-OFF §3): their tags carry the face icon. */
  byFace: boolean;
  framing: FramingResult | null;
  /** 0..100 live match scores (the name tags show them). */
  meterA: number;
  meterB: number;
  popups: Popup[];
  /** Pose rate the native view measures. */
  fps: number;
  /** Frames in the series so far. */
  frames: number;
  /** The live scorer's per-player state (the debug overlay). */
  liveA: LivePlayerState | null;
  liveB: LivePlayerState | null;
  /** Bumped on every write (a cheap change token). */
  version: number;
}

/** A popup stays this long. */
export const POPUP_TTL_MS = 1_100;
/** At most this many popups per player at once (a burst of key moves stacks, then drops). */
export const POPUPS_PER_PLAYER = 2;
/** Listener rate: ~15 Hz. */
export const LIVE_MIN_INTERVAL_MS = 66;

export const emptyLiveView = (): LiveView => ({
  w: 720,
  h: 1280,
  people: [],
  a: null,
  b: null,
  byFace: false,
  framing: null,
  meterA: 0,
  meterB: 0,
  popups: [],
  fps: 0,
  frames: 0,
  liveA: null,
  liveB: null,
  version: 0,
});

export interface LiveStore {
  get(): LiveView;
  /** Merge a patch (or compute one from the current view); listeners fire throttled. */
  update(patch: Partial<LiveView> | ((v: LiveView) => Partial<LiveView>)): void;
  /** Fold a live-scorer update in: meters, debug state, and a popup per key-move event. */
  applyLive(u: LiveUpdate): void;
  /** Back to empty (a new round). */
  reset(): void;
  subscribe(listener: () => void): () => void;
  /** Call listeners now if anything is pending. */
  flush(): void;
}

export interface StoreTimer {
  now(): number;
  schedule(fn: () => void, ms: number): () => void;
}

const defaultTimer: StoreTimer = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** Drops expired popups and keeps the newest POPUPS_PER_PLAYER per player. */
export function prunePopups(popups: readonly Popup[], now: number): Popup[] {
  const live = popups.filter((p) => now - p.at < POPUP_TTL_MS);
  const keep = (player: 'A' | 'B') =>
    live.filter((p) => p.player === player).slice(-POPUPS_PER_PLAYER);
  return [...keep('A'), ...keep('B')].sort((x, y) => x.id - y.id);
}

export function createLiveStore(
  opts: { minIntervalMs?: number; timer?: StoreTimer } = {},
): LiveStore {
  const interval = opts.minIntervalMs ?? LIVE_MIN_INTERVAL_MS;
  const timer = opts.timer ?? defaultTimer;
  let view = emptyLiveView();
  let lastEmit = Number.NEGATIVE_INFINITY;
  let pending = false;
  let cancel: (() => void) | null = null;
  let nextPopup = 1;
  const listeners = new Set<() => void>();

  const emit = () => {
    cancel = null;
    pending = false;
    lastEmit = timer.now();
    view = { ...view, popups: prunePopups(view.popups, lastEmit) };
    for (const l of [...listeners]) l();
  };

  const schedule = () => {
    pending = true;
    if (cancel) return;
    const wait = Math.max(0, interval - (timer.now() - lastEmit));
    cancel = timer.schedule(emit, wait);
  };

  const store: LiveStore = {
    get: () => view,
    update(patch) {
      const p = typeof patch === 'function' ? patch(view) : patch;
      view = { ...view, ...p, version: view.version + 1 };
      schedule();
    },
    applyLive(u) {
      const now = timer.now();
      const added: Popup[] = u.events.map((e) => ({
        id: nextPopup++,
        player: e.player,
        grade: e.grade,
        name: e.name,
        at: now,
      }));
      store.update((v) => ({
        meterA: u.a.meter,
        meterB: u.b.meter,
        liveA: u.a,
        liveB: u.b,
        popups: added.length > 0 ? prunePopups([...v.popups, ...added], now) : v.popups,
      }));
    },
    reset() {
      cancel?.();
      cancel = null;
      view = { ...emptyLiveView(), version: view.version + 1 };
      pending = true;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    flush() {
      if (!pending) return;
      cancel?.();
      emit();
    },
  };
  return store;
}
