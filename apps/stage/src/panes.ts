// Phone panes: the two phones on the projector. The iPhone app is the product, so the stage can
// show what the phones show: each phone is mirrored to this laptop (Reflector / AirServer, the
// macOS AirPlay Receiver, QuickTime's wired capture, or a camera filming the phones) and the page
// puts each feed in a phone-shaped frame inside its own layout, so the projector shows one
// composed screen without OBS (PhonePanes.tsx).
//
// This module is the pure part: the layout mode (P cycles Stage only -> Phones + stage -> Phones
// big), each slot's state machine (empty -> requesting -> live -> ended / error), the per-slot
// crop, the operator panel (O), what the operator chose (kept in localStorage), the party name
// on each slot, which phone "acts" in the bet's current phase, the slim status rail of the
// "Phones big" layout, and acquiring a source with the media APIs injected (tests run in Node).
import type { BetView, PartyKey } from './ticker';
import { usd } from './format';
import { endedEarly, isMarketBet, phaseOf, phaseSteps } from './phase';

// ---- layout ---------------------------------------------------------------------------------

export const LAYOUT_MODES = ['stage', 'flank', 'big'] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const LAYOUT_LABEL: Record<LayoutMode, string> = {
  stage: 'Stage only',
  flank: 'Phones + stage',
  big: 'Phones big',
};

export const isLayout = (v: unknown): v is LayoutMode =>
  typeof v === 'string' && (LAYOUT_MODES as readonly string[]).includes(v);

/** P: Stage only -> Phones + stage -> Phones big -> Stage only. */
export const nextLayout = (m: LayoutMode): LayoutMode =>
  LAYOUT_MODES[(LAYOUT_MODES.indexOf(m) + 1) % LAYOUT_MODES.length]!;

// ---- sources, crop --------------------------------------------------------------------------

export type SlotId = PartyKey;
export const SLOTS: readonly SlotId[] = ['A', 'B'];

/** screen: getDisplayMedia (a mirroring app's window); camera: getUserMedia; test: a canvas. */
export type SourceKind = 'screen' | 'camera' | 'test';
export const SOURCE_LABEL: Record<SourceKind, string> = {
  screen: 'Window or screen',
  camera: 'Camera',
  test: 'Test pattern',
};

/**
 * How the feed sits in the phone frame. fit: the whole picture (letterboxed on black); fill: the
 * frame filled (edges cut); trim-*: the picture enlarged by that much on every side and clipped,
 * for a mirrored window that still shows its title bar and margins.
 */
export const CROPS = ['fit', 'trim-s', 'trim-m', 'trim-l', 'fill'] as const;
export type CropPreset = (typeof CROPS)[number];
export const CROP_LABEL: Record<CropPreset, string> = {
  fit: 'Fit',
  'trim-s': 'Trim 4%',
  'trim-m': 'Trim 8%',
  'trim-l': 'Trim 12%',
  fill: 'Fill',
};
const isCrop = (v: unknown): v is CropPreset =>
  typeof v === 'string' && (CROPS as readonly string[]).includes(v);

/** The video's object-fit, and how far (percent of the frame) it spills past each edge. */
export function cropStyle(c: CropPreset): { fit: 'contain' | 'cover'; insetPct: number } {
  if (c === 'fill') return { fit: 'cover', insetPct: 0 };
  const inset = c === 'trim-s' ? 4 : c === 'trim-m' ? 8 : c === 'trim-l' ? 12 : 0;
  return { fit: 'contain', insetPct: inset };
}

// ---- the slot state machine -----------------------------------------------------------------

export type MediaErrorKind = 'denied' | 'notfound' | 'busy' | 'unsupported' | 'other';

export type SlotSource =
  | { status: 'empty' }
  /** `req`: this request's id; an answer for an older request is dropped. */
  | { status: 'requesting'; kind: SourceKind; req: number }
  | { status: 'live'; kind: SourceKind; req: number; label: string }
  /** The user stopped the share, or the camera was unplugged. */
  | { status: 'ended'; kind: SourceKind }
  | { status: 'error'; kind: SourceKind; error: MediaErrorKind; message: string };

export interface Slot {
  source: SlotSource;
  crop: CropPreset;
  /** The camera picked for this slot (remembered across visits). */
  deviceId: string | null;
}

export interface PanesState {
  layout: LayoutMode;
  /** The operator panel (O): hidden by default, never part of the projected layout. */
  operator: boolean;
  slots: Record<SlotId, Slot>;
}

export type PanesAction =
  | { type: 'cycle' }
  | { type: 'layout'; mode: LayoutMode }
  | { type: 'operator'; open?: boolean }
  /** `req`: a fresh id from the caller (PhonePanes.tsx keeps the counter). */
  | { type: 'request'; slot: SlotId; kind: SourceKind; req: number; deviceId?: string | null }
  | { type: 'granted'; req: number; label: string }
  | { type: 'failed'; req: number; error: MediaErrorKind; message: string }
  | { type: 'ended'; req: number }
  | { type: 'stop'; slot: SlotId }
  | { type: 'crop'; slot: SlotId; crop: CropPreset }
  | { type: 'device'; slot: SlotId; deviceId: string | null }
  | { type: 'swap' };

const emptySlot = (): Slot => ({ source: { status: 'empty' }, crop: 'fit', deviceId: null });

export function initialPanes(prefs: Partial<PanesPrefs> = {}): PanesState {
  const slot = (s: SlotId): Slot => ({
    ...emptySlot(),
    crop: prefs.crop?.[s] ?? 'fit',
    deviceId: prefs.deviceId?.[s] ?? null,
  });
  return {
    layout: prefs.layout ?? 'stage',
    operator: false,
    slots: { A: slot('A'), B: slot('B') },
  };
}

/** The slot whose current request is `req` (requesting or live), if any. */
export function slotOfReq(s: PanesState, req: number): SlotId | null {
  for (const id of SLOTS) {
    const src = s.slots[id].source;
    if ((src.status === 'requesting' || src.status === 'live') && src.req === req) return id;
  }
  return null;
}

const withSlot = (s: PanesState, id: SlotId, patch: Partial<Slot>): PanesState => ({
  ...s,
  slots: { ...s.slots, [id]: { ...s.slots[id], ...patch } },
});

export function panesReducer(s: PanesState, a: PanesAction): PanesState {
  switch (a.type) {
    case 'cycle':
      return { ...s, layout: nextLayout(s.layout) };
    case 'layout':
      return s.layout === a.mode ? s : { ...s, layout: a.mode };
    case 'operator': {
      const open = a.open ?? !s.operator;
      return open === s.operator ? s : { ...s, operator: open };
    }
    case 'request':
      return withSlot(s, a.slot, {
        source: { status: 'requesting', kind: a.kind, req: a.req },
        ...(a.kind === 'camera' && a.deviceId !== undefined ? { deviceId: a.deviceId } : {}),
      });
    case 'granted': {
      const id = slotOfReq(s, a.req);
      const src = id ? s.slots[id].source : null;
      if (!id || src?.status !== 'requesting') return s; // a superseded request
      return withSlot(s, id, {
        source: { status: 'live', kind: src.kind, req: a.req, label: a.label },
      });
    }
    case 'failed': {
      const id = slotOfReq(s, a.req);
      if (!id) return s;
      const kind = (s.slots[id].source as { kind: SourceKind }).kind;
      return withSlot(s, id, {
        source: { status: 'error', kind, error: a.error, message: a.message },
      });
    }
    case 'ended': {
      const id = slotOfReq(s, a.req);
      if (!id) return s;
      const kind = (s.slots[id].source as { kind: SourceKind }).kind;
      return withSlot(s, id, { source: { status: 'ended', kind } });
    }
    case 'stop':
      return s.slots[a.slot].source.status === 'empty'
        ? s
        : withSlot(s, a.slot, { source: { status: 'empty' } });
    case 'crop':
      return s.slots[a.slot].crop === a.crop ? s : withSlot(s, a.slot, { crop: a.crop });
    case 'device':
      return withSlot(s, a.slot, { deviceId: a.deviceId });
    case 'swap':
      return { ...s, slots: { A: s.slots.B, B: s.slots.A } };
  }
}

/** What clicking a slot that is not live does: pick the same kind of source again. */
export function retryOf(slot: Slot): { kind: SourceKind; deviceId: string | null } | null {
  const src = slot.source;
  if (src.status !== 'ended' && src.status !== 'error') return null;
  return { kind: src.kind, deviceId: src.kind === 'camera' ? slot.deviceId : null };
}

/** The slot's line under the frame (or across it when there is no picture). */
export function slotMessage(slot: Slot): string | null {
  const src = slot.source;
  switch (src.status) {
    case 'empty':
      return null;
    case 'requesting':
      return src.kind === 'screen'
        ? 'Pick the phone’s window…'
        : src.kind === 'camera'
          ? 'Starting the camera…'
          : 'Starting…';
    case 'live':
      return null;
    case 'ended':
      return src.kind === 'camera'
        ? 'Camera disconnected — click to pick again'
        : 'Source ended — click to pick again';
    case 'error':
      return `${src.message} — click to try again`;
  }
}

// ---- media errors ---------------------------------------------------------------------------

/** A getDisplayMedia / getUserMedia rejection, as the operator should read it. */
export function classifyMediaError(
  err: unknown,
  kind: SourceKind,
): { error: MediaErrorKind; message: string } {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return {
      error: 'denied',
      message:
        kind === 'screen'
          ? 'Not shared (cancelled, or Screen Recording is off for this browser)'
          : 'Camera not allowed for this page',
    };
  if (
    name === 'NotFoundError' ||
    name === 'OverconstrainedError' ||
    name === 'DevicesNotFoundError'
  )
    return {
      error: 'notfound',
      message: kind === 'camera' ? 'That camera is not connected' : 'Nothing to capture',
    };
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
    return { error: 'busy', message: 'The source is busy (another app has it?)' };
  if (name === 'Unsupported')
    return {
      error: 'unsupported',
      message:
        kind === 'screen'
          ? 'This browser cannot capture a window here (https or localhost only)'
          : 'This browser cannot use a camera here (https or localhost only)',
    };
  const msg = err instanceof Error ? err.message : String(err);
  return { error: 'other', message: msg || 'Could not start the source' };
}

// ---- acquiring a source (media APIs injected) ------------------------------------------------

export interface MediaTrackLike {
  readonly kind: string;
  readonly label: string;
  readonly readyState: string;
  stop(): void;
  addEventListener(type: 'ended', fn: () => void): void;
  removeEventListener(type: 'ended', fn: () => void): void;
}
export interface MediaStreamLike {
  getVideoTracks(): MediaTrackLike[];
  getTracks(): MediaTrackLike[];
}

export interface MediaDeps<S extends MediaStreamLike = MediaStreamLike> {
  getDisplayMedia?: (c: Record<string, unknown>) => Promise<S>;
  getUserMedia?: (c: Record<string, unknown>) => Promise<S>;
  /** A live test-pattern stream labelled `label` (a canvas's captureStream in the browser). */
  testPattern?: (label: string) => S;
}

const unsupported = () => Object.assign(new Error('unsupported'), { name: 'Unsupported' });

/** The constraints for each kind: video only, the cursor hidden where the browser supports it. */
export function constraintsFor(kind: 'screen' | 'camera', deviceId: string | null) {
  if (kind === 'screen')
    return {
      video: { cursor: 'never', displaySurface: 'window', frameRate: { ideal: 30 } },
      audio: false,
      // the picker leads with windows (Reflector / AirPlay / QuickTime), never this tab
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    };
  return {
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  };
}

/** Starts a source. Rejects as the media API does; a missing API rejects with name Unsupported. */
export async function acquire<S extends MediaStreamLike>(
  kind: SourceKind,
  opts: { deviceId?: string | null; label: string },
  deps: MediaDeps<S>,
): Promise<S> {
  if (kind === 'test') {
    if (!deps.testPattern) throw unsupported();
    return deps.testPattern(opts.label);
  }
  const get = kind === 'screen' ? deps.getDisplayMedia : deps.getUserMedia;
  if (!get) throw unsupported();
  const stream = await get(constraintsFor(kind, opts.deviceId ?? null));
  if (!stream.getVideoTracks().length) {
    for (const t of stream.getTracks()) t.stop();
    throw Object.assign(new Error('no video in that source'), { name: 'NotFoundError' });
  }
  return stream;
}

/** Calls onEnd once when the stream's video ends (share stopped, camera unplugged). */
export function watchEnded(stream: MediaStreamLike, onEnd: () => void): () => void {
  const tracks = stream.getVideoTracks();
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    onEnd();
  };
  if (!tracks.some((t) => t.readyState !== 'ended')) {
    queueMicrotask(fire);
    return () => {
      done = true;
    };
  }
  for (const t of tracks) t.addEventListener('ended', fire);
  return () => {
    done = true;
    for (const t of tracks) t.removeEventListener('ended', fire);
  };
}

export const stopStream = (s: MediaStreamLike | null | undefined) => {
  for (const t of s?.getTracks() ?? []) {
    try {
      t.stop();
    } catch {
      // already stopped
    }
  }
};

/** The name a live source shows in the operator panel. */
export function sourceLabel(kind: SourceKind, stream: MediaStreamLike): string {
  if (kind === 'test') return SOURCE_LABEL.test; // a canvas track's label is a random id
  const l = stream.getVideoTracks()[0]?.label?.trim();
  return l || SOURCE_LABEL[kind];
}

export interface PaneMediaHooks<S> {
  /** The reducer's dispatch: request / granted / failed / ended / stop / swap. */
  dispatch(a: PanesAction): void;
  /** The live streams by request id changed (a new map each time). */
  onStreams(streams: ReadonlyMap<number, S>): void;
  /** A source went live (PhonePanes.tsx relists the cameras: labels appear once allowed). */
  onLive?(kind: SourceKind): void;
}

/**
 * Who holds which capture. Every stream it is handed is stopped exactly once: when its slot
 * picks again or stops, when the source ends by itself, when the answer comes back for a request
 * the slot no longer wants (superseded, stopped, or the page left), and on dispose.
 */
export class PaneMedia<S extends MediaStreamLike> {
  private counter = 0;
  /** The request each slot wants now: an answer for any other request is stopped on arrival. */
  private wanted: Record<SlotId, number | null> = { A: null, B: null };
  private held = new Map<number, { stream: S; unwatch: () => void }>();
  private live: ReadonlyMap<number, S> = new Map();

  constructor(
    private readonly deps: MediaDeps<S>,
    private readonly hooks: PaneMediaHooks<S>,
  ) {}

  get streams(): ReadonlyMap<number, S> {
    return this.live;
  }

  /** How many captures are running (tests, and a leak check). */
  get running(): number {
    return this.held.size;
  }

  private publish() {
    this.live = new Map([...this.held].map(([req, h]) => [req, h.stream]));
    this.hooks.onStreams(this.live);
  }

  private release(req: number | null) {
    if (req === null) return;
    const h = this.held.get(req);
    if (!h) return;
    this.held.delete(req);
    h.unwatch();
    stopStream(h.stream);
    this.publish();
  }

  /**
   * Starts `kind` in `slot`, stopping what the slot had. The media API is called synchronously,
   * so a 'screen' pick must come straight from a click (getDisplayMedia needs the user gesture).
   */
  pick(slot: SlotId, kind: SourceKind, deviceId: string | null, label: string): Promise<void> {
    this.release(this.wanted[slot]);
    const req = ++this.counter;
    this.wanted[slot] = req;
    const dev = kind === 'camera' ? deviceId : null;
    this.hooks.dispatch({ type: 'request', slot, kind, req, deviceId: dev });
    const current = () => this.wanted.A === req || this.wanted.B === req;
    let p: Promise<S>;
    try {
      p = acquire(kind, { deviceId: dev, label }, this.deps);
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.then(
      (stream) => {
        if (!current()) {
          stopStream(stream);
          return;
        }
        const unwatch = watchEnded(stream, () => {
          this.hooks.dispatch({ type: 'ended', req });
          this.release(req);
        });
        this.held.set(req, { stream, unwatch });
        this.publish();
        this.hooks.dispatch({ type: 'granted', req, label: sourceLabel(kind, stream) });
        this.hooks.onLive?.(kind);
      },
      (err: unknown) => {
        if (current())
          this.hooks.dispatch({ type: 'failed', req, ...classifyMediaError(err, kind) });
      },
    );
  }

  stop(slot: SlotId) {
    this.release(this.wanted[slot]);
    this.wanted[slot] = null;
    this.hooks.dispatch({ type: 'stop', slot });
  }

  swap() {
    this.wanted = { A: this.wanted.B, B: this.wanted.A };
    this.hooks.dispatch({ type: 'swap' });
  }

  /** The page is leaving: stops every capture and drops the answers still on the way. */
  dispose() {
    this.wanted = { A: null, B: null };
    for (const req of [...this.held.keys()]) this.release(req);
  }
}

// ---- persistence ----------------------------------------------------------------------------

export const PANES_KEY = 'youre-on.stage.panes';

/** What survives a reload: the layout, each slot's crop and camera. Sources need a click again. */
export interface PanesPrefs {
  layout: LayoutMode;
  crop: Record<SlotId, CropPreset>;
  deviceId: Record<SlotId, string | null>;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** localStorage, or null where it is blocked (a private window, a sandbox). */
export function localStore(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function prefsOf(s: PanesState): PanesPrefs {
  return {
    layout: s.layout,
    crop: { A: s.slots.A.crop, B: s.slots.B.crop },
    deviceId: { A: s.slots.A.deviceId, B: s.slots.B.deviceId },
  };
}

/** The saved prefs, each field checked (anything odd falls back to the default). */
export function loadPrefs(store: StorageLike | null): Partial<PanesPrefs> {
  let raw: unknown;
  try {
    const text = store?.getItem(PANES_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<PanesPrefs> = {};
  if (isLayout(r.layout)) out.layout = r.layout;
  const crop = r.crop as Record<string, unknown> | undefined;
  if (crop && typeof crop === 'object')
    out.crop = { A: isCrop(crop.A) ? crop.A : 'fit', B: isCrop(crop.B) ? crop.B : 'fit' };
  const dev = r.deviceId as Record<string, unknown> | undefined;
  if (dev && typeof dev === 'object') {
    const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length < 512 ? v : null);
    out.deviceId = { A: id(dev.A), B: id(dev.B) };
  }
  return out;
}

export function savePrefs(store: StorageLike | null, prefs: PanesPrefs): void {
  try {
    store?.setItem(PANES_KEY, JSON.stringify(prefs));
  } catch {
    // storage full or blocked: the choice lasts until the reload
  }
}

/**
 * Launch options (not secret, for rehearsal and screenshots): ?panes=test puts a test pattern in
 * both slots; ?layout=stage|flank|big (or phones, an alias of big) opens in that layout.
 */
export function parsePanesQuery(search: string): {
  test: boolean;
  layout: LayoutMode | null;
  sources: Partial<Record<SlotId, SourceKind>>;
} {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    return { test: false, layout: null, sources: {} };
  }
  const panes = (q.get('panes') ?? '').trim().toLowerCase();
  const l = (q.get('layout') ?? '').trim().toLowerCase();
  const layout = l === 'phones' ? 'big' : isLayout(l) ? l : null;
  const test = panes === 'test';
  const sources: Partial<Record<SlotId, SourceKind>> = test ? { A: 'test', B: 'test' } : {};
  return { test, layout, sources };
}

// ---- the bet on screen ----------------------------------------------------------------------

/** The slot's caption: the party's display name when a bet is on screen, else "Phone A". */
export function slotName(bet: BetView | null, slot: SlotId): string {
  const n = bet?.names[slot]?.trim();
  return n || `Phone ${slot}`;
}

/** The test pattern's text: "Phone A", or "Phone A · Jake". */
export function testPatternLabel(bet: BetView | null, slot: SlotId): string {
  const n = bet?.names[slot]?.trim();
  return n ? `Phone ${slot} · ${n}` : `Phone ${slot}`;
}

/** act: that phone has the move now; win / lose: the ruling (or payout) went that way. */
export type PhoneCue = 'act' | 'win' | 'lose';

const other = (p: PartyKey): PartyKey => (p === 'A' ? 'B' : 'A');

function winner(b: BetView): PartyKey | null {
  const o = b.appeal_result?.final_outcome ?? b.ruling?.outcome;
  return o === 'A_WINS' ? 'A' : o === 'B_WINS' ? 'B' : null;
}

/**
 * Which phone glows in the bet's current phase, from the state the stage already folds:
 * the challenged phone (B) while the challenge waits; each phone that still has to confirm in
 * the lock; the filming phone (the non-performer's: it records the attempt) in a skill bet's
 * attempt; the winner and the loser once it is ruled. Nothing for a Gemini bet's market wait,
 * a redo, a void, or a bet that ended early.
 */
export function phoneCues(bet: BetView | null): Record<SlotId, PhoneCue | null> {
  const none = { A: null, B: null };
  if (!bet || endedEarly(bet)) return none;
  const phase = phaseOf(bet);
  if (phase === 'ruling' || phase === 'paid') {
    const w = winner(bet);
    if (!w) return none;
    return { [w]: 'win', [other(w)]: 'lose' } as Record<SlotId, PhoneCue>;
  }
  if (phase === 'challenge') return bet.invite === null ? { A: null, B: 'act' } : none;
  if (phase === 'lock') {
    if (bet.lock || bet.declined) return none;
    return { A: bet.auth.A ? null : 'act', B: bet.auth.B ? null : 'act' };
  }
  if (phase === 'play') {
    if (isMarketBet(bet) || bet.evidence) return none;
    const redoPending =
      bet.ruling?.outcome === 'REDO' && (bet.attempt_no ?? 0) <= (bet.ruling.attempt_no ?? 0);
    if (redoPending) return none;
    const performer = bet.performer ?? bet.envelope?.terms.performer ?? null;
    if (!performer) return none;
    return { [other(performer)]: 'act', [performer]: null } as Record<SlotId, PhoneCue | null>;
  }
  return none;
}

/** The badge under a phone that has a cue: what it is doing, in the bet's current phase. */
export function cueText(bet: BetView | null, cue: PhoneCue): string {
  if (cue === 'win') return 'WINNER';
  if (cue === 'lose') return 'GG';
  const phase = bet ? phaseOf(bet) : null;
  return phase === 'challenge'
    ? 'challenged'
    : phase === 'lock'
      ? 'confirm'
      : phase === 'play'
        ? 'filming'
        : 'their move';
}

/** The "Phones big" status rail: the key facts of the bet on screen, as short lines. */
export interface RailSummary {
  /** The phase rail's current step ("Lock", "Ruling", …), or "Waiting". */
  phase: string;
  /** "Jake vs Maya", or null with no bet. */
  matchup: string | null;
  claim: string | null;
  /** "$10 pot" once the terms set the stakes. */
  amount: string | null;
  /** The one line the audience needs now. */
  status: string;
  tone: 'idle' | 'live' | 'good' | 'bad';
}

export function railSummary(bet: BetView | null): RailSummary {
  if (!bet)
    return {
      phase: 'Waiting',
      matchup: null,
      claim: null,
      amount: null,
      status: 'Waiting for a challenge…',
      tone: 'idle',
    };
  const a = slotName(bet, 'A');
  const b = slotName(bet, 'B');
  const steps = phaseSteps(bet);
  const step = steps.find((s) => s.status === 'current' || s.status === 'failed') ?? steps.at(-1)!;
  const t = bet.envelope?.terms;
  const amount = t ? `${usd((BigInt(t.stakes.a) + BigInt(t.stakes.b)).toString())} pot` : null;
  const base = { phase: step.label, matchup: `${a} vs ${b}`, claim: t?.claim ?? null, amount };
  const ended = endedEarly(bet);
  if (ended)
    return { ...base, status: ended === 'cancelled' ? 'Cancelled' : 'Expired', tone: 'bad' };
  const phase = phaseOf(bet);
  if (phase === 'paid' && bet.payout) {
    const p = bet.payout;
    const w = p.to_a !== '0' && p.to_b === '0' ? a : p.to_b !== '0' && p.to_a === '0' ? b : null;
    const total = usd((BigInt(p.to_a) + BigInt(p.to_b)).toString());
    return {
      ...base,
      status: w ? `PAID ${total} → ${w}` : `Refunded · ${a} ${usd(p.to_a)} · ${b} ${usd(p.to_b)}`,
      tone: 'good',
    };
  }
  if (phase === 'ruling' || phase === 'paid') {
    const o = bet.appeal_result?.final_outcome ?? bet.ruling?.outcome;
    if (bet.appealed && !bet.appeal_result)
      return { ...base, status: 'Appealed · the panel is voting', tone: 'live' };
    if (o === 'A_WINS' || o === 'B_WINS')
      return { ...base, status: `${o === 'A_WINS' ? a : b} wins`, tone: 'good' };
    if (o === 'VOID') return { ...base, status: 'Void · stakes refunded', tone: 'bad' };
    if (bet.hearing) return { ...base, status: 'Hearing · each side argues', tone: 'live' };
    return { ...base, status: 'The judge is ruling…', tone: 'live' };
  }
  if (phase === 'play') {
    if (bet.ruling?.outcome === 'REDO') return { ...base, status: 'Redo · go again', tone: 'live' };
    if (isMarketBet(bet)) return { ...base, status: 'Locked · waiting on Gemini', tone: 'live' };
    if (bet.evidence) return { ...base, status: 'The judge is watching…', tone: 'live' };
    const who = bet.performer ?? t?.performer ?? null;
    if (bet.attempt_no !== null)
      return {
        ...base,
        status: `${bet.attempt_no > 1 ? `Attempt ${bet.attempt_no}` : 'Attempt'}${who ? ` · ${slotName(bet, who)} is up` : ''}`,
        tone: 'live',
      };
    return { ...base, status: 'Locked in escrow', tone: 'good' };
  }
  if (phase === 'lock') {
    if (bet.lock?.status === 'failed') return { ...base, status: 'The lock failed', tone: 'bad' };
    if (bet.lock) return { ...base, status: 'Locking both stakes…', tone: 'live' };
    const n = (bet.auth.A ? 1 : 0) + (bet.auth.B ? 1 : 0);
    return { ...base, status: `${n} of 2 confirmed`, tone: 'live' };
  }
  if (phase === 'terms')
    return {
      ...base,
      status: bet.envelope ? 'Terms set · both confirm' : 'Setting the terms…',
      tone: 'live',
    };
  return {
    ...base,
    status: bet.invite === 'declined' ? `${b} declined` : `${a} challenged ${b}`,
    tone: bet.invite === 'declined' ? 'bad' : 'live',
  };
}
