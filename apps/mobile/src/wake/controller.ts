// "Jarvis" listening, as a controller: owns the native recognizer's lifecycle (load, permissions,
// start/stop), runs ./detector over its transcripts, and reports wake / utterance / status.
// Pure TS: the native module, the clock and the timers are injected, so it is tested in node
// (./__tests__/controller.test.ts); ./useWakeWord binds it to React and AppState.
//
// Guarantees:
//   - one native start at a time: start/stop run one after another (a reconcile loop), never
//     overlapping, and only when what is wanted (enabled + foreground + armed) differs from what
//     is running
//   - permissions are asked once per controller; a denial sticks ('denied')
//   - onWake fires the moment the wake word is heard (the rainbow loop shows at once)
//   - onUtterance fires only after native stop() resolved: the mic and the audio session are
//     released, so the ElevenLabs/LiveKit session can take the mic right away
//   - after an utterance the controller stays off ('heard') until resume() or enabled goes
//     false -> true: the judge session owns the mic from there
//   - a capture that ends any other way (disabled, backgrounded, interrupted, native error)
//     calls onCancel, so the loop can hide
//   - nothing is called after dispose()
import {
  createWakeDetector,
  type TranscriptInput,
  type WakeDetector,
  type WakeEvent,
  type WakeTiming,
} from './detector';
import { WAKE_WORD } from './phrase';

export type PermissionState = 'granted' | 'denied' | 'restricted' | 'undetermined';

export interface WakePermissions {
  readonly speech: PermissionState;
  readonly mic: PermissionState;
}

export interface WakeStartOptions {
  readonly locale?: string;
  readonly contextualStrings?: string[];
  readonly onDevice?: boolean;
}

export interface WakeStartResult {
  readonly ok: boolean;
  readonly onDevice: boolean;
  readonly reason?: string;
}

export type NativeWakeState = 'listening' | 'stopped' | 'restarting' | 'error' | 'interrupted';

export interface NativeStateEvent {
  readonly state: NativeWakeState;
  readonly message?: string;
}

export interface Subscription {
  remove(): void;
}

/**
 * The native 'WakeWord' module, as the controller uses it (modules/wake-word). There is no
 * isAvailable() here on purpose: SFSpeechRecognizer availability changes over time (offline
 * without the on-device model, Dictation toggled), so a one-off check at load would strand the
 * controller in 'unavailable'. An unavailable recognizer shows up as start() failing with
 * 'recognizer-unavailable' instead, which is retried on foreground, resume() and re-enable.
 */
export interface WakeNative {
  requestPermissions(): Promise<WakePermissions>;
  start(options: WakeStartOptions): Promise<WakeStartResult>;
  stop(): Promise<void>;
  addTranscriptListener(fn: (e: TranscriptInput) => void): Subscription;
  addStateListener(fn: (e: NativeStateEvent) => void): Subscription;
}

export type WakeStatus =
  | 'off' // not listening (disabled, backgrounded, starting, loading)
  | 'unavailable' // no native module in this binary
  | 'denied' // speech or mic permission refused
  | 'listening' // the mic is live, waiting for "Jarvis"
  | 'capturing' // "Jarvis" heard, taking the challenge
  | 'heard' // the challenge was delivered; mic released until resume()
  | 'error'; // the recognizer failed to start or stopped on its own

export interface WakeCallbacks {
  onWake(): void;
  /** The challenge after "Jarvis" ('' if they only said "Jarvis"). The mic is already released. */
  onUtterance(text: string): void;
  /** A capture ended without an utterance (disabled, backgrounded, interrupted, error). */
  onCancel?(): void;
  onError?(message: string): void;
  onStatus?(status: WakeStatus): void;
  /** The native module loaded (or not): whether wake listening can work in this binary. */
  onAvailable?(available: boolean): void;
}

export interface WakeClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WakeControllerOptions {
  /** Loads the native module; null (or a rejection) means unavailable. Called once. */
  load(): Promise<WakeNative | null>;
  callbacks: WakeCallbacks;
  timing?: Partial<WakeTiming>;
  clock?: WakeClock;
  /** Detector tick period while listening. */
  tickMs?: number;
  locale?: string;
}

export interface WakeController {
  setEnabled(enabled: boolean): void;
  setForeground(foreground: boolean): void;
  /** Listen again after 'heard' or 'error' (no-op otherwise). */
  resume(): void;
  /** Stops the recognizer (fire and forget) and silences every callback. */
  dispose(): void;
  readonly status: WakeStatus;
  readonly available: boolean;
}

export const DEFAULT_TICK_MS = 200;

const defaultClock: WakeClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createWakeController(opts: WakeControllerOptions): WakeController {
  const cb = opts.callbacks;
  const clock = opts.clock ?? defaultClock;
  const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  const detector: WakeDetector = createWakeDetector(opts.timing);

  let native: WakeNative | null = null;
  let loaded = false; // load() settled
  let available = false;
  let subs: Subscription[] = [];

  let enabled = false;
  let foreground = true;
  let heard = false; // an utterance was delivered; wait for resume()
  let failed = false; // start failed / native died; wait for resume() or a re-enable
  let denied = false;
  let permissionsAsked = false;
  let disposed = false;

  let running = false; // native start() resolved ok and stop() not yet called
  let stopping = false; // inside our own stop()
  let busy = false; // the reconcile loop is running
  let dirty = false;
  let ticker: unknown = null;
  let pendingUtterance: string | null = null;

  let status: WakeStatus = 'off';
  const setStatus = (s: WakeStatus) => {
    if (disposed || s === status) return;
    status = s;
    cb.onStatus?.(s);
  };

  /** Status when not capturing, from the flags. */
  const restingStatus = (): WakeStatus => {
    if (loaded && !available) return 'unavailable';
    if (denied) return 'denied';
    if (failed) return 'error';
    if (heard) return 'heard';
    return running ? 'listening' : 'off';
  };

  const wanted = () =>
    !disposed && enabled && foreground && !heard && !failed && !denied && (!loaded || available);

  /** Ends a capture in progress without an utterance. */
  const cancelCapture = (skipCurrentSegment: boolean) => {
    if (detector.phase !== 'capturing') return;
    if (skipCurrentSegment) detector.reset({ skipThroughSegment: detector.lastSegment });
    else detector.reset();
    if (!disposed) cb.onCancel?.();
  };

  const stopTicker = () => {
    if (ticker !== null) clock.clearInterval(ticker);
    ticker = null;
  };

  const handle = (events: WakeEvent[]) => {
    for (const e of events) {
      if (disposed) return;
      if (e.type === 'wake') {
        setStatus('capturing');
        cb.onWake();
      } else {
        // Release the mic first; onUtterance follows in doStop.
        pendingUtterance = e.text;
        heard = true;
        reconcile();
      }
    }
  };

  const onTranscript = (e: TranscriptInput) => {
    if (disposed || !running || stopping) return;
    handle(detector.feed(e, clock.now()));
  };

  const onNativeState = (e: NativeStateEvent) => {
    if (disposed || !running || stopping) return;
    switch (e.state) {
      case 'listening':
      case 'restarting':
        if (detector.phase !== 'capturing') setStatus('listening');
        return;
      case 'interrupted':
        // A call, Siri, another app's audio. The native side restarts when it ends.
        cancelCapture(true);
        setStatus('off');
        return;
      case 'error':
      case 'stopped':
        // The recognizer gave up on its own (its own restarts are 'restarting'). `running` stays
        // true so reconcile() still calls stop(): the audio session is released either way.
        stopTicker();
        cancelCapture(false);
        failed = true;
        setStatus('error');
        cb.onError?.(e.message ?? e.state);
        reconcile();
        return;
    }
  };

  const ensureLoaded = async () => {
    if (loaded) return;
    try {
      native = await opts.load();
    } catch {
      native = null;
    }
    if (disposed) {
      loaded = true;
      return;
    }
    // Only "is the module in this binary". Whether the recognizer can run right now is start()'s
    // answer ('recognizer-unavailable' -> 'error'), so it is re-checked on every retry.
    available = native !== null;
    loaded = true;
    if (native) {
      subs = [native.addTranscriptListener(onTranscript), native.addStateListener(onNativeState)];
    }
    cb.onAvailable?.(available);
    if (!available) setStatus('unavailable');
  };

  const doStart = async () => {
    await ensureLoaded();
    const n = native;
    if (!wanted() || !n) return;
    if (!permissionsAsked) {
      permissionsAsked = true;
      try {
        const p = await n.requestPermissions();
        denied = p.speech !== 'granted' || p.mic !== 'granted';
      } catch {
        denied = true;
      }
      if (denied) {
        setStatus('denied');
        return;
      }
      if (!wanted()) return;
    }
    detector.reset();
    let res: WakeStartResult;
    try {
      res = await n.start({
        locale: opts.locale ?? 'en-US',
        contextualStrings: [WAKE_WORD],
        onDevice: true,
      });
    } catch (e) {
      res = { ok: false, onDevice: false, reason: message(e) };
    }
    if (disposed) {
      // Disposed while starting: nobody will stop it later.
      if (res.ok) void n.stop().catch(() => undefined);
      return;
    }
    if (!res.ok) {
      failed = true;
      setStatus('error');
      cb.onError?.(res.reason ?? 'start failed');
      return;
    }
    running = true;
    stopTicker();
    ticker = clock.setInterval(() => {
      if (!disposed && running && !stopping) handle(detector.tick(clock.now()));
    }, tickMs);
    setStatus('listening');
  };

  const doStop = async () => {
    stopTicker();
    stopping = true;
    try {
      if (native) await native.stop();
    } catch {
      // A failed stop still means we are not listening; nothing to retry.
    } finally {
      stopping = false;
      running = false;
    }
    const text = pendingUtterance;
    pendingUtterance = null;
    if (text !== null) {
      if (!disposed && enabled && foreground) {
        setStatus('heard');
        cb.onUtterance(text);
      } else {
        // Disabled or backgrounded while the mic was being released: drop it.
        heard = false;
        if (!disposed) cb.onCancel?.();
      }
    } else {
      cancelCapture(false);
    }
    setStatus(restingStatus());
  };

  /** Brings the native recognizer to what wanted() says, one start/stop at a time. */
  function reconcile(): void {
    if (busy) {
      dirty = true;
      return;
    }
    busy = true;
    void (async () => {
      try {
        do {
          dirty = false;
          const want = wanted();
          if (want && !running) await doStart();
          else if (!want && (running || pendingUtterance !== null)) await doStop();
          else if (!running && detector.phase === 'capturing') cancelCapture(false);
        } while (dirty);
      } catch {
        // Only a throwing callback lands here; the flags are already consistent.
      } finally {
        busy = false;
      }
      if (!disposed) setStatus(detector.phase === 'capturing' ? 'capturing' : restingStatus());
    })();
  }

  // Load at once (cheap, no mic) so `available` is known before the first enable.
  busy = true;
  void ensureLoaded()
    .catch(() => undefined)
    .finally(() => {
      busy = false;
      reconcile();
    });

  return {
    get status() {
      return status;
    },
    get available() {
      return available;
    },
    setEnabled(next) {
      if (disposed || next === enabled) return;
      enabled = next;
      if (next) {
        heard = false;
        failed = false;
      }
      reconcile();
    },
    setForeground(next) {
      if (disposed || next === foreground) return;
      foreground = next;
      // Back in front: a start that failed (e.g. another app held the audio session) may work now.
      if (next && failed) failed = false;
      reconcile();
    },
    resume() {
      if (disposed || (!heard && !failed)) return;
      heard = false;
      failed = false;
      reconcile();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopTicker();
      for (const s of subs) s.remove();
      subs = [];
      if (running && native && !stopping) {
        running = false;
        void native.stop().catch(() => undefined);
      }
    },
  };
}
