// The slow-mo replay on the projector (slowmo.ts has the rules): a full-screen layer that plays
// the moment's evidence frames at quarter speed with cross-fades and a slow zoom, then holds on
// the judge's decisive frame (or the detector's foul moment) with a ring and a label. A moment
// with a clip plays the <video> at clipPlan's rate and freezes at the moment. Silent.
//
// useSlowMo is App.tsx's whole hook-up: R (toggle), the auto-play after a fresh payout, the frame
// fetches and the "No slow-mo yet" toast. It renders into the App's one overlay slot
// ({kind: 'slowmo', bet_id}), so a 1-6 REPLAY clip replaces it and R replaces a clip.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  clipPlan,
  slowmoFrameAt,
  slowmoTimeline,
  SLOWMO_HOLD_MS,
  type ReplayClip,
  type ReplayFrame,
  type ReplayMoment,
} from '@youre-on/shared/replay';
import {
  attemptOf,
  availableMoment,
  fetchReplay,
  fetchReplayAsset,
  NO_SLOWMO,
  parseSlowmoLaunch,
  playedKey,
  previewMoment,
  resolveFrame,
  shouldAutoPlay,
  slowmoLabels,
  slowmoToggle,
  timecode,
  SLOWMO_CLOSE_AFTER_MS,
  SLOWMO_TOAST_MS,
  SLOWMO_VOICE_WAIT_MS,
  type SlowmoOverlay,
} from './slowmo';
import type { BetView, TickerState } from './ticker';
import './slowmo.css';

const prefersReducedMotion = (): boolean => {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
};

/** ms since mount, every animation frame (or fixed at `freezeAt`). */
function useClock(freezeAt: number | null, running: boolean): number {
  const [t, setT] = useState(freezeAt ?? 0);
  useEffect(() => {
    if (freezeAt !== null || !running || typeof requestAnimationFrame !== 'function') return;
    const start = performance.now() - t;
    let raf = 0;
    const tick = () => {
      setT(performance.now() - start);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // t: only the value at (re)start matters
  }, [freezeAt, running]);
  return freezeAt ?? t;
}

export interface SlowMoProps {
  moment: ReplayMoment;
  names: { A: string; B: string };
  /** An <img> src for a frame, or null while it loads. */
  src: (f: ReplayFrame) => string | null;
  onClose: () => void;
  reduceMotion?: boolean;
  /** Dev / tests: draw the replay frozen at this many ms in. */
  freezeAt?: number | null;
}

export function SlowMo({
  moment,
  names,
  src,
  onClose,
  reduceMotion = false,
  freezeAt = null,
}: SlowMoProps) {
  const [clipFailed, setClipFailed] = useState(false);
  const useClip = moment.clip !== null && !clipFailed;
  const labels = slowmoLabels(moment, names);
  const tone = moment.kind === 'foul' ? 'foul' : 'win';
  return (
    <div
      className={`slowmo ${tone}`}
      role="dialog"
      aria-label={labels.badge.toLowerCase()}
      onClick={onClose}
    >
      <span className="slowmo-badge">{labels.badge}</span>
      {labels.chip && <span className="slowmo-chip">{labels.chip}</span>}
      {useClip ? (
        <ClipView
          clip={moment.clip!}
          labels={labels}
          onClose={onClose}
          freezeAt={freezeAt}
          onFail={() => (moment.frames.length ? setClipFailed(true) : onClose())}
        />
      ) : (
        <FramesView
          moment={moment}
          labels={labels}
          src={src}
          onClose={onClose}
          reduceMotion={reduceMotion}
          freezeAt={freezeAt}
        />
      )}
    </div>
  );
}

function FramesView({
  moment,
  labels,
  src,
  onClose,
  reduceMotion,
  freezeAt,
}: {
  moment: ReplayMoment;
  labels: ReturnType<typeof slowmoLabels>;
  src: SlowMoProps['src'];
  onClose: () => void;
  reduceMotion: boolean;
  freezeAt: number | null;
}) {
  const tl = useMemo(() => slowmoTimeline(moment, { reduceMotion }), [moment, reduceMotion]);
  const t = useClock(freezeAt, true);
  const at = slowmoFrameAt(tl, t);
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    if (freezeAt !== null || t < tl.total_ms + SLOWMO_CLOSE_AFTER_MS) return;
    onClose();
  }, [t, tl.total_ms, freezeAt, onClose]);
  const cur = at.current >= 0 ? moment.frames[at.current] : undefined;
  const progress = tl.total_ms ? Math.min(1, t / tl.total_ms) : 1;
  return (
    <>
      <div className="slowmo-col">
        <figure
          className={`slowmo-frame${at.holding ? ' holding' : ''}`}
          style={aspect ? { aspectRatio: String(aspect) } : undefined}
        >
          {moment.frames.map((f, i) => {
            const s = src(f);
            const st = at.frames[i]!;
            return s ? (
              <img
                key={tl.steps[i]!.key}
                src={s}
                alt={f.idx !== null ? `evidence frame ${f.idx}` : 'detector still'}
                draggable={false}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (!aspect && img.naturalWidth && img.naturalHeight)
                    setAspect(img.naturalWidth / img.naturalHeight);
                }}
                style={{ opacity: st.opacity, transform: `scale(${st.scale})` }}
              />
            ) : null;
          })}
          <div className="slowmo-vignette" aria-hidden="true" />
          {cur && <span className="slowmo-time">{timecode(cur.t_ms)}</span>}
          {at.holding && labels.hold && (
            <figcaption className="slowmo-hold">{labels.hold}</figcaption>
          )}
        </figure>
        <LowerThird labels={labels} />
      </div>
      <div className="slowmo-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${progress})` }} />
      </div>
    </>
  );
}

function LowerThird({ labels }: { labels: ReturnType<typeof slowmoLabels> }) {
  if (!labels.lower && !labels.footer) return null;
  return (
    <div className="slowmo-lower">
      {labels.lower && (
        <p className="slowmo-reason">
          {labels.lower}
          {labels.cached && (
            <>
              {' '}
              <span className="replay-badge inline">replay ruling</span>
            </>
          )}
        </p>
      )}
      {labels.footer && <p className="slowmo-footer">{labels.footer}</p>}
    </div>
  );
}

function ClipView({
  clip,
  labels,
  onClose,
  onFail,
  freezeAt,
}: {
  clip: ReplayClip;
  labels: ReturnType<typeof slowmoLabels>;
  onClose: () => void;
  onFail: () => void;
  freezeAt: number | null;
}) {
  const plan = clipPlan(clip);
  const ref = useRef<HTMLVideoElement | null>(null);
  const [frozen, setFrozen] = useState(false);
  useEffect(() => {
    if (!frozen || freezeAt !== null) return;
    const t = setTimeout(onClose, SLOWMO_HOLD_MS + SLOWMO_CLOSE_AFTER_MS);
    return () => clearTimeout(t);
  }, [frozen, freezeAt, onClose]);
  return (
    <div className="slowmo-col">
      <figure className={`slowmo-frame clip${frozen ? ' holding' : ''}`}>
        <video
          ref={ref}
          src={clip.url}
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            v.currentTime = plan.seekMs / 1000;
            v.playbackRate = plan.playbackRate;
            if (freezeAt === null) void v.play().catch(onFail);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            if (!frozen && v.currentTime * 1000 >= plan.freezeAtMs) {
              v.pause();
              v.currentTime = plan.freezeAtMs / 1000;
              setFrozen(true);
            }
          }}
          onEnded={() => setFrozen(true)}
          onError={onFail}
        />
        {frozen && labels.hold && <figcaption className="slowmo-hold">{labels.hold}</figcaption>}
      </figure>
      <LowerThird labels={labels} />
    </div>
  );
}

// ---- the App's hook-up ------------------------------------------------------------------------

interface Loaded {
  moment: ReplayMoment;
  names: { A: string; B: string };
  /** Preview frames (data URLs) by path. */
  images: Record<string, string>;
}

const namesOf = (b: BetView) => ({ A: b.names.A ?? 'Player A', B: b.names.B ?? 'Player B' });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface UseSlowMo {
  /** The R key. */
  toggle: () => void;
  /** The layer (when the overlay slot holds a slow-mo) and the toast. */
  node: ReactNode;
}

export function useSlowMo(o: {
  /** The focused bet (the big card). */
  bet: BetView | null;
  /** The shown clock (server-corrected; the preview's clock in a preview). */
  now: number;
  conn: { serverUrl: string; token: string } | null;
  preview: boolean;
  frameBlobs: TickerState['frameBlobs'];
  overlay: { kind: string } | null;
  setOverlay: (o: SlowmoOverlay | null) => void;
  /** The operator panel (O, on the stage branch) is open: no auto-play. */
  operatorOpen?: boolean;
  /** The stage voice has no line on: auto-play waits for it (at most SLOWMO_VOICE_WAIT_MS). */
  voiceIdle: () => boolean;
}): UseSlowMo {
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [launch] = useState(() =>
    o.preview ? parseSlowmoLaunch(globalThis.location?.search ?? '') : { open: null, at: null },
  );
  const [reduceMotion] = useState(prefersReducedMotion);
  /** Frames fetched for the slow-mo (object URLs by path); `assetsVersion` re-renders. */
  const assets = useRef(new Map<string, string>());
  const [, setAssetsVersion] = useState(0);
  const played = useRef(new Set<string>());
  const asked = useRef(new Set<string>());
  const paidSeen = useRef(new Map<string, number>());
  const latest = useRef(o);
  latest.current = o;

  useEffect(
    () => () => {
      for (const u of assets.current.values()) URL.revokeObjectURL(u);
    },
    [],
  );

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );
  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), SLOWMO_TOAST_MS);
  }, []);

  /** The bet's moment (a fresh GET each time: a foul can arrive later), its frames fetched. */
  const load = useCallback(
    async (bet: BetView): Promise<Loaded | null> => {
      const cur = latest.current;
      let l: Loaded | null = null;
      if (cur.preview) {
        const p = previewMoment(bet, launch.open === 'foul' ? 'foul' : 'win');
        if (p) l = { moment: p.moment, names: namesOf(bet), images: p.images };
      } else if (cur.conn) {
        const r = await fetchReplay(cur.conn.serverUrl, cur.conn.token, bet.bet_id).catch(
          () => null,
        );
        if (r?.replay) l = { moment: r.replay, names: namesOf(bet), images: {} };
      }
      if (!l) return null;
      const m = l.moment;
      if (cur.conn) {
        const conn = cur.conn;
        const missing = m.frames.filter(
          (f) =>
            !l.images[f.path] && !resolveFrame(m, f, latest.current.frameBlobs, assets.current),
        );
        // the frames are small (≤ 200 KB); wait for them up to 3 s, the rest fill in as they land
        await Promise.race([
          Promise.all(
            missing.map((f) =>
              fetchReplayAsset(conn.serverUrl, conn.token, f).then(
                (u) => {
                  assets.current.set(f.path, u);
                  setAssetsVersion((v) => v + 1);
                },
                () => undefined,
              ),
            ),
          ),
          wait(3_000),
        ]);
      }
      // the frames that did not arrive are left out (no black step, no label on the wrong frame)
      const has = (f: ReplayFrame) =>
        !!l.images[f.path] || !!resolveFrame(m, f, latest.current.frameBlobs, assets.current);
      const avail = availableMoment(m, has);
      if (!avail) return null;
      const out: Loaded = { ...l, moment: avail };
      setLoaded((s) => ({ ...s, [m.bet_id]: out }));
      return out;
    },
    [launch.open],
  );

  const open = useCallback(
    async (bet: BetView, auto: boolean) => {
      const l = await load(bet);
      if (!l) {
        if (!auto) showToast(NO_SLOWMO);
        return;
      }
      const key = playedKey(l.moment.bet_id, l.moment.attempt_no, l.moment.kind);
      if (auto && played.current.has(key)) return;
      played.current.add(key); // R counts too: no auto-play after the operator showed it
      if (auto) {
        // the judge's line first (the player is silent)
        for (let w = 0; w < SLOWMO_VOICE_WAIT_MS && !latest.current.voiceIdle(); w += 200)
          await wait(200);
        const now = latest.current;
        if (now.overlay !== null || now.operatorOpen) return;
      }
      latest.current.setOverlay({ kind: 'slowmo', bet_id: bet.bet_id });
    },
    [load, showToast],
  );

  const toggle = useCallback(() => {
    const cur = latest.current;
    if (slowmoToggle(cur.overlay) === 'close') return cur.setOverlay(null);
    if (!cur.bet || !cur.bet.ruling) return showToast(NO_SLOWMO);
    void open(cur.bet, false);
  }, [open, showToast]);

  // Auto-play once after a fresh payout (slowmo.ts shouldAutoPlay).
  const bet = o.bet;
  const payKey = bet?.paid_at ? `${bet.bet_id}|${bet.paid_at}` : null;
  if (payKey && !paidSeen.current.has(payKey)) paidSeen.current.set(payKey, o.now);
  const due = shouldAutoPlay({
    bet,
    paidSeenAt: payKey ? (paidSeen.current.get(payKey) ?? null) : null,
    now: o.now,
    overlayOpen: o.overlay !== null,
    operatorOpen: o.operatorOpen === true,
    played: played.current,
  });
  useEffect(() => {
    if (!due || !bet) return;
    // asked once per (bet, attempt): the next ticks do not fetch again (open() keys the kind)
    const ask = `${bet.bet_id}:${attemptOf(bet)}`;
    if (asked.current.has(ask)) return;
    asked.current.add(ask);
    void open(bet, true);
  }, [due, bet, open]);

  // ?preview&slowmo: open on the sample bet once it has a ruling (layout checks, screenshots).
  const launched = useRef(false);
  useEffect(() => {
    if (!launch.open || launched.current || !bet?.ruling || !bet.evidence) return;
    if (bet.ruling.outcome !== 'A_WINS' && bet.ruling.outcome !== 'B_WINS') return;
    launched.current = true;
    void open(bet, false);
  }, [launch.open, bet, open]);

  const slot = o.overlay?.kind === 'slowmo' ? (o.overlay as SlowmoOverlay) : null;
  const shown = slot ? loaded[slot.bet_id] : undefined;
  const close = useCallback(() => latest.current.setOverlay(null), []);
  const node = (
    <>
      {shown && (
        <SlowMo
          key={`${shown.moment.bet_id}:${shown.moment.attempt_no}:${shown.moment.kind}`}
          moment={shown.moment}
          names={shown.names}
          src={(f) =>
            shown.images[f.path] ?? resolveFrame(shown.moment, f, o.frameBlobs, assets.current)
          }
          onClose={close}
          reduceMotion={reduceMotion}
          freezeAt={launch.at}
        />
      )}
      {toast && (
        <div className="slowmo-toast" role="status">
          {toast}
        </div>
      )}
    </>
  );
  return { toggle, node };
}
