// Phone panes on the projector (panes.ts has the pure logic). Each phone is mirrored to this Mac
// (Reflector / AirServer: one window per iPhone; the macOS AirPlay Receiver; QuickTime with a
// cable; or a camera filming the phones) and picked here per slot, so the projector shows the
// phones inside the stage's own layout:
//
//   P  Stage only -> Phones + stage (the phones flank the stage, which shrinks to the middle)
//      -> Phones big (the phones as large as the screen allows, a slim status rail between them)
//   O  the operator panel: each slot's source (window / camera / test pattern), crop, swap A/B
//
// ?panes=test starts a test pattern in both slots and ?layout=flank|big opens in that layout
// (rehearsal, screenshots).
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { BetView } from './ticker';
import {
  CROP_LABEL,
  CROPS,
  cropStyle,
  cueText,
  initialPanes,
  LAYOUT_LABEL,
  LAYOUT_MODES,
  loadPrefs,
  localStore,
  PaneMedia,
  panesReducer,
  parsePanesQuery,
  phoneCues,
  prefsOf,
  railSummary,
  retryOf,
  savePrefs,
  slotMessage,
  slotName,
  SLOTS,
  SOURCE_LABEL,
  testPatternLabel,
  type CropPreset,
  type LayoutMode,
  type MediaDeps,
  type PanesState,
  type PhoneCue,
  type Slot,
  type SlotId,
  type SourceKind,
} from './panes';
import { featuredTx, TxQrCard } from './view';

// ---- the browser's media APIs ---------------------------------------------------------------

/** A canvas phone screen that moves (so a frozen feed shows), labelled with the slot. */
function testPatternStream(label: string): MediaStream {
  const c = document.createElement('canvas');
  c.width = 450;
  c.height = 975; // 9 : 19.5
  const g = c.getContext('2d');
  if (!g || typeof c.captureStream !== 'function')
    throw Object.assign(new Error('unsupported'), { name: 'Unsupported' });
  const t0 = performance.now();
  const stream = c.captureStream(24);
  const track = stream.getVideoTracks()[0];
  // Obsidian, monochrome: black, white type, grey hairlines; green only for the moving ring
  const sans = 'Geist, system-ui, sans-serif';
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    const { width: w, height: h } = c;
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    // grid
    g.strokeStyle = '#1c1c1f';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += 45) {
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
    for (let y = 0; y <= h; y += 45) {
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(w, y);
      g.stroke();
    }
    // status bar
    const d = new Date();
    g.fillStyle = '#ffffff';
    g.font = `600 26px ${sans}`;
    g.textAlign = 'left';
    g.fillText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, 44, 58);
    g.textAlign = 'right';
    g.fillText('5G ▮▮▮', w - 40, 58);
    // the moving sweep: a frozen feed stops moving
    const sweep = ((t * 0.35) % 1) * h;
    g.fillStyle = 'rgb(255 255 255 / 0.06)';
    g.fillRect(0, sweep - 30, w, 60);
    // center ring: a grey track and a green arc that turns
    const r = 120 + Math.sin(t * 2) * 10;
    g.lineWidth = 6;
    g.strokeStyle = '#1c1c1f';
    g.beginPath();
    g.arc(w / 2, h * 0.42, r, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = '#00d47a';
    g.lineCap = 'round';
    g.beginPath();
    g.arc(w / 2, h * 0.42, r, t * 2, t * 2 + Math.PI * 1.2);
    g.stroke();
    g.lineCap = 'butt';
    // label
    const [slot, name] = label.split(' · ');
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.font = `600 64px ${sans}`;
    g.fillText(slot ?? label, w / 2, h * 0.68);
    if (name) {
      g.font = `500 40px ${sans}`;
      g.fillStyle = '#8d8d93';
      g.fillText(name, w / 2, h * 0.68 + 56);
    }
    g.font = `500 22px ${sans}`;
    g.fillStyle = '#8d8d93';
    g.fillText(`Test pattern · ${t.toFixed(1)}s`, w / 2, h - 70);
    // home indicator
    g.fillStyle = 'rgb(255 255 255 / 0.8)';
    g.beginPath();
    g.roundRect(w / 2 - 70, h - 26, 140, 8, 4);
    g.fill();
  };
  draw();
  const timer = setInterval(() => {
    if (!track || track.readyState === 'ended') clearInterval(timer);
    else draw();
  }, 1000 / 24);
  return stream;
}

interface FocusController {
  setFocusBehavior(b: 'no-focus-change' | 'focus-captured-surface'): void;
}

/** A CaptureController set to keep the focus here, where the browser has one (Chrome 109+). */
function captureController(): FocusController | null {
  const C = (globalThis as { CaptureController?: new () => FocusController }).CaptureController;
  if (typeof C !== 'function') return null;
  try {
    const ctl = new C();
    keepFocus(ctl); // allowed before the call in newer Chrome; repeated once the share starts
    return ctl;
  } catch {
    return null;
  }
}

function keepFocus(ctl: FocusController) {
  try {
    ctl.setFocusBehavior('no-focus-change');
  } catch {
    // too early (before the share) or too late, or a screen (not a window): nothing to keep
  }
}

function browserDeps(): MediaDeps<MediaStream> {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return {
    getDisplayMedia:
      md && typeof md.getDisplayMedia === 'function'
        ? (c) => {
            // Chrome brings a captured window to the front by default, which would cover the
            // projector with Reflector / QuickTime: ask it to keep the focus on this page
            const ctl = captureController();
            const p = md.getDisplayMedia({
              ...(c as DisplayMediaStreamOptions),
              ...(ctl ? { controller: ctl } : {}),
            } as DisplayMediaStreamOptions);
            return ctl ? p.then((s) => (keepFocus(ctl), s)) : p;
          }
        : undefined,
    getUserMedia:
      md && typeof md.getUserMedia === 'function'
        ? (c) => md.getUserMedia(c as MediaStreamConstraints)
        : undefined,
    testPattern: typeof document !== 'undefined' ? testPatternStream : undefined,
  };
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

async function listCameras(): Promise<CameraDevice[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'videoinput' && d.deviceId)
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch {
    return [];
  }
}

// ---- the hook -------------------------------------------------------------------------------

export interface PhonePanes {
  state: PanesState;
  /** Live streams by request id. */
  streams: ReadonlyMap<number, MediaStream>;
  cameras: CameraDevice[];
  canScreen: boolean;
  canCamera: boolean;
  pick(slot: SlotId, kind: SourceKind, deviceId?: string | null): void;
  stop(slot: SlotId): void;
  swap(): void;
  cycle(): void;
  setLayout(mode: LayoutMode): void;
  setCrop(slot: SlotId, crop: CropPreset): void;
  toggleOperator(open?: boolean): void;
  /** A click on a pane: picks the same source again after it ended, else opens the panel. */
  clickSlot(slot: SlotId): void;
}

/** The panes' state and media. `bet`: the bet on screen (names the test patterns). */
export function usePhonePanes(bet: BetView | null, search = ''): PhonePanes {
  const [query] = useState(() => parsePanesQuery(search));
  const [state, dispatch] = useReducer(panesReducer, undefined, () => {
    const s = initialPanes(loadPrefs(localStore()));
    return query.layout ? { ...s, layout: query.layout } : s;
  });
  const [streams, setStreams] = useState<ReadonlyMap<number, MediaStream>>(() => new Map());
  const [cameras, setCameras] = useState<CameraDevice[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const betRef = useRef(bet);
  betRef.current = bet;

  const deps = useRef<MediaDeps<MediaStream> | null>(null);
  deps.current ??= browserDeps();
  const canScreen = !!deps.current.getDisplayMedia;
  const canCamera = !!deps.current.getUserMedia;

  const prefs = JSON.stringify(prefsOf(state));
  useEffect(() => savePrefs(localStore(), JSON.parse(prefs)), [prefs]);

  const refreshCameras = useCallback(() => {
    if (!canCamera) return;
    void listCameras().then(setCameras);
  }, [canCamera]);
  const refreshRef = useRef(refreshCameras);
  refreshRef.current = refreshCameras;

  // who holds which capture (panes.ts PaneMedia: every stream is stopped exactly once)
  const media = useRef<PaneMedia<MediaStream> | null>(null);
  media.current ??= new PaneMedia(deps.current, {
    dispatch,
    onStreams: setStreams,
    onLive: (kind) => {
      if (kind === 'camera') refreshRef.current(); // labels appear once allowed
    },
  });
  const m = media.current;

  const pick = useCallback(
    (slot: SlotId, kind: SourceKind, deviceId?: string | null) => {
      const dev = kind === 'camera' ? (deviceId ?? stateRef.current.slots[slot].deviceId) : null;
      void m.pick(slot, kind, dev, testPatternLabel(betRef.current, slot));
    },
    [m],
  );
  const stop = useCallback((slot: SlotId) => m.stop(slot), [m]);
  const swap = useCallback(() => m.swap(), [m]);

  // leaving the page stops every capture (the mirroring app's share indicator goes off) and
  // drops answers still on the way; declared before the ?panes=test effect so a StrictMode
  // remount re-picks after the dispose
  useEffect(() => () => m.dispose(), [m]);

  const cycle = useCallback(() => dispatch({ type: 'cycle' }), []);
  const setLayout = useCallback((mode: LayoutMode) => dispatch({ type: 'layout', mode }), []);
  const setCrop = useCallback(
    (slot: SlotId, crop: CropPreset) => dispatch({ type: 'crop', slot, crop }),
    [],
  );
  const toggleOperator = useCallback((open?: boolean) => dispatch({ type: 'operator', open }), []);

  const clickSlot = useCallback(
    (slot: SlotId) => {
      const again = retryOf(stateRef.current.slots[slot]);
      if (again) pick(slot, again.kind, again.deviceId);
      else if (stateRef.current.slots[slot].source.status === 'empty') toggleOperator(true);
    },
    [pick, toggleOperator],
  );

  // cameras: listed once and on every plug / unplug
  useEffect(() => {
    if (!canCamera) return;
    refreshCameras();
    const md = navigator.mediaDevices;
    md.addEventListener?.('devicechange', refreshCameras);
    return () => md.removeEventListener?.('devicechange', refreshCameras);
  }, [canCamera, refreshCameras]);

  // ?panes=test: a test pattern in both slots
  useEffect(() => {
    for (const s of SLOTS) {
      const kind = query.sources[s];
      if (kind) pick(s, kind);
    }
  }, [query, pick]);

  return {
    state,
    streams,
    cameras,
    canScreen,
    canCamera,
    pick,
    stop,
    swap,
    cycle,
    setLayout,
    setCrop,
    toggleOperator,
    clickSlot,
  };
}

// ---- the phone frame ------------------------------------------------------------------------

function Feed({ stream, crop }: { stream: MediaStream; crop: CropPreset }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    void v.play().catch(() => undefined);
  }, [stream]);
  const { fit, insetPct: p } = cropStyle(crop);
  const style: CSSProperties = {
    objectFit: fit,
    top: `-${p}%`,
    left: `-${p}%`,
    width: `${100 + 2 * p}%`,
    height: `${100 + 2 * p}%`,
  };
  return <video ref={ref} muted autoPlay playsInline style={style} />;
}

export function PhoneFrame({
  slot,
  state,
  stream,
  name,
  cue,
  cueLabel = null,
  onClick,
}: {
  slot: SlotId;
  state: Slot;
  stream: MediaStream | null;
  name: string;
  cue: PhoneCue | null;
  /** The cue's badge text (panes.ts cueText). */
  cueLabel?: string | null;
  onClick?: () => void;
}) {
  const src = state.source;
  const msg = slotMessage(state);
  const live = src.status === 'live' && stream;
  const generic = name === `Phone ${slot}`;
  return (
    <figure
      className={`phone phone-${slot.toLowerCase()} src-${src.status}${cue ? ` cue-${cue}` : ''}`}
      aria-label={`${name}'s phone`}
    >
      <div className="phone-body" onClick={onClick} role={onClick ? 'button' : undefined}>
        <div className="phone-screen">
          {live ? (
            <Feed stream={stream} crop={state.crop} />
          ) : (
            <div className="phone-empty">
              <span className="phone-letter">{slot}</span>
              {msg ? (
                <span
                  className={`phone-msg${src.status === 'ended' || src.status === 'error' ? ' bad' : ''}`}
                >
                  {msg}
                </span>
              ) : (
                <span className="phone-msg muted">No feed</span>
              )}
            </div>
          )}
        </div>
      </div>
      <figcaption className="phone-name">
        {!generic && <span className="label">Phone {slot}</span>}
        <span className="who">{name}</span>
        {cue && <span className={`phone-cue ${cue}`}>{cueLabel ?? cue}</span>}
      </figcaption>
    </figure>
  );
}

// ---- the "Phones big" status rail -------------------------------------------------------------

export function StatusRail({
  bet,
  badge,
}: {
  bet: BetView | null;
  badge: { text: string; cls: string };
}) {
  const r = railSummary(bet);
  const tx = bet ? featuredTx(bet) : null;
  const caption = bet?.caption?.text.trim() ? bet.caption : null;
  return (
    <aside className="status-rail" aria-label="bet status">
      <header>
        <h1>
          You&apos;re <span className="on">On</span>
        </h1>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </header>
      <span className="rail-phase">{r.phase}</span>
      {r.matchup && <p className="rail-matchup">{r.matchup}</p>}
      {r.claim && <p className="rail-claim">“{r.claim}”</p>}
      {r.amount && <p className="rail-amount">{r.amount}</p>}
      <p className={`rail-status ${r.tone}`}>{r.status}</p>
      {caption && (
        <p className="rail-caption">
          <span className="label">
            {caption.speaker === 'judge' ? 'Judge' : slotName(bet, caption.speaker)}
          </span>{' '}
          {caption.text}
        </p>
      )}
      {tx && <TxQrCard tx={tx} />}
    </aside>
  );
}

// ---- the layouts ----------------------------------------------------------------------------

/**
 * The projected screen in the current layout: `stage` alone, the phones flanking it, or the
 * phones big around the status rail.
 */
export function PhoneStage({
  panes,
  bet,
  badge,
  stage,
}: {
  panes: Pick<PhonePanes, 'state' | 'streams' | 'clickSlot'>;
  bet: BetView | null;
  badge: { text: string; cls: string };
  stage: ReactNode;
}) {
  const { layout, slots } = panes.state;
  if (layout === 'stage') return <>{stage}</>;
  const cues = phoneCues(bet);
  const phone = (s: SlotId) => {
    const src = slots[s].source;
    return (
      <PhoneFrame
        slot={s}
        state={slots[s]}
        stream={src.status === 'live' ? (panes.streams.get(src.req) ?? null) : null}
        name={slotName(bet, s)}
        cue={cues[s]}
        cueLabel={cues[s] ? cueText(bet, cues[s]) : null}
        onClick={() => panes.clickSlot(s)}
      />
    );
  };
  return (
    <div className={`phones-shell ${layout}`}>
      {phone('A')}
      {layout === 'flank' ? (
        <div className="phones-center">{stage}</div>
      ) : (
        <StatusRail bet={bet} badge={badge} />
      )}
      {phone('B')}
    </div>
  );
}

// ---- the operator panel (O) -----------------------------------------------------------------

function SlotControls({
  panes,
  slot,
  bet,
}: {
  panes: PhonePanes;
  slot: SlotId;
  bet: BetView | null;
}) {
  const s = panes.state.slots[slot];
  const src = s.source;
  const status =
    src.status === 'live'
      ? `● ${src.label}`
      : src.status === 'empty'
        ? 'No source'
        : (slotMessage(s) ?? '');
  const kinds: SourceKind[] = ['screen', 'camera', 'test'];
  const active = src.status === 'live' || src.status === 'requesting' ? src.kind : null;
  return (
    <section className="op-slot">
      <h3>
        Phone {slot} <span className="muted">· {slotName(bet, slot)}</span>
      </h3>
      <p className={`op-status ${src.status}`}>{status}</p>
      <div className="op-row">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            className={active === k ? 'on' : undefined}
            disabled={(k === 'screen' && !panes.canScreen) || (k === 'camera' && !panes.canCamera)}
            onClick={() => panes.pick(slot, k)}
          >
            {SOURCE_LABEL[k]}
          </button>
        ))}
        <button type="button" onClick={() => panes.stop(slot)} disabled={src.status === 'empty'}>
          Stop
        </button>
      </div>
      {panes.canCamera && (
        <label className="op-row">
          <span className="muted">Camera</span>
          <select
            value={s.deviceId ?? ''}
            onChange={(e) => panes.pick(slot, 'camera', e.target.value || null)}
          >
            <option value="">Default camera</option>
            {panes.cameras.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label}
              </option>
            ))}
            {s.deviceId && !panes.cameras.some((c) => c.deviceId === s.deviceId) && (
              <option value={s.deviceId}>Saved camera (not connected)</option>
            )}
          </select>
        </label>
      )}
      <div className="op-row">
        <span className="muted">Crop</span>
        {CROPS.map((c) => (
          <button
            key={c}
            type="button"
            className={s.crop === c ? 'on' : undefined}
            onClick={() => panes.setCrop(slot, c)}
          >
            {CROP_LABEL[c]}
          </button>
        ))}
      </div>
    </section>
  );
}

export function OperatorPanel({ panes, bet }: { panes: PhonePanes; bet: BetView | null }) {
  return (
    <div className="operator" role="dialog" aria-label="phone panes">
      <header>
        <h2>Phones on the projector</h2>
        <div className="op-row">
          {LAYOUT_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={panes.state.layout === m ? 'on' : undefined}
              onClick={() => panes.setLayout(m)}
            >
              {LAYOUT_LABEL[m]}
            </button>
          ))}
          <button type="button" onClick={panes.swap}>
            Swap A ⇄ B
          </button>
          <button type="button" className="close" onClick={() => panes.toggleOperator(false)}>
            Close (O)
          </button>
        </div>
      </header>
      <div className="op-slots">
        <SlotControls panes={panes} slot="A" bet={bet} />
        <SlotControls panes={panes} slot="B" bet={bet} />
      </div>
      <p className="muted op-tip">
        Mirror each iPhone to this Mac (Reflector / AirServer, AirPlay Receiver, or QuickTime with a
        cable), then pick its window with “Window or screen”. Or point a camera at the phones. Trim
        cuts a mirrored window&apos;s title bar.
      </p>
    </div>
  );
}
