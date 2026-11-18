// Stage view (TASKS D1-J5, D2-J3, D3-J4, D5-J1; ARCHITECTURE §8.2): the laptop on the projector.
// Served by the API server at /stage (apps/server/src/stage/static.ts), so it talks to its own
// origin: POST /v1/stage/session (STAGE_KEY + room code -> stage token), then one /v1/ws socket
// for the room. Opening
//
//   https://<app>.fly.dev/stage/?room=ABC234#key=<STAGE_KEY>&demo=<DEMO_ADMIN_TOKEN>
//
// connects with no typing (config.ts); ?preview plays a sample bet with no server (preview.ts),
// ?preview=gemini walks one Gemini bet (Beat 6) through its clock to Gemini's result
// (preview-market.ts). A ruled Gemini bet's evidence chain is fetched and re-checked here
// (verify.ts), and the projector says whether it verified.
// Keys: 1-6 REPLAY clips, Esc closes, F full screen, Q big Explorer QR, H help.
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { WS_CLOSE } from '@youre-on/shared/api';
import { applyFrame, deadlineRefetches, initialTicker, type BetView } from './ticker';
import {
  fetchBetSnapshot,
  fetchFrame,
  fetchMarket,
  fetchSettlement,
  openStageSession,
  StageConnection,
  wsUrlFor,
  type StageConfig,
} from './connection';
import {
  CONFIG_KEY,
  foreignServer,
  isUuid,
  roomLabelOf,
  loadSession,
  parseLaunch,
  readJson,
  rememberBets,
  resolveServer,
  scrubbedHref,
  serverOverrideAllowed,
  SESSION_KEY,
  writeJson,
  type LaunchParams,
  type SavedSession,
} from './config';
import { seedBet } from './seed';
import { fetchDemoHealth, HEALTH_POLL_MS, type DemoHealth } from './health';
import { PREVIEW_HEALTH, previewAt } from './preview';
import { MARKET_PREVIEW, MARKET_PREVIEW_SLOT_MS, previewMarketState } from './preview-market';
import { freshSounds, isSfx, StageAudio, type Sfx } from './sound';
import { settlementFetches, verifyEvidence, type Verification } from './verify';
import {
  initialReplays,
  liveBetInProgress,
  preloadReplays,
  replayProgress,
  replaySrc,
  REPLAY_BEATS,
  type ReplayStatus,
} from './replays';
import {
  featuredTx,
  HelpOverlay,
  normalizeSigner,
  PaidMoment,
  QrOverlay,
  ReplayOverlay,
  StageView,
  type LockSigner,
} from './view';

export {
  BetCard,
  MarketPanel,
  OddsWidget,
  PaidMoment,
  QrCode,
  ReplayOverlay,
  StageView,
  Ticker,
  HealthStrip,
  PhaseRail,
} from './view';
export { clock, shortSig } from './format';
export { REPLAY_BEATS } from './replays';
export { verifiedChain, verifyEvidence, type Verification } from './verify';

/** How long the PAID moment stays up, and how fresh a payout must be to trigger it. */
export const PAID_MOMENT_MS = 7_000;
export const PAID_FRESH_MS = 20_000;

interface FormState extends StageConfig {
  demoKey?: string;
}

interface Live {
  token: string;
  serverUrl: string;
  roomId: string;
  roomLabel: string;
  demoKey: string | null;
  lockSigner: LockSigner;
}

/** What start() connects with. */
interface StartParams {
  /** As typed or saved: '' is this page's origin (resolveServer; throws on a bad URL). */
  serverUrl: string;
  token: string;
  roomId: string;
  roomLabel: string;
  /** ?bet= / the form's bet id: shown first and pinned while it is live. */
  betId: string | null;
  demoKey: string | null;
  /** From the stage session (null with a pasted token: then the demo health's, if any). */
  lockSigner: LockSigner;
  /** A reloaded tab: the card it showed and the other bets it knew. */
  resume?: { focus: string | null; bets: string[] };
}

function useNow(offsetMs: number | null, everyMs = 250): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), everyMs);
    return () => clearInterval(i);
  }, [everyMs]);
  return t + (offsetMs ?? 0);
}

const origin = () => {
  try {
    return globalThis.location?.origin ?? 'http://localhost:8080';
  } catch {
    return 'http://localhost:8080';
  }
};

function readLaunch(): LaunchParams {
  try {
    const loc = globalThis.location;
    return parseLaunch(loc?.search ?? '', loc?.hash ?? '', {
      allowServer: serverOverrideAllowed(loc?.hostname ?? '', import.meta.env.DEV === true),
    });
  } catch {
    return parseLaunch('', '');
  }
}

function initialForm(l: LaunchParams): FormState {
  const saved = readJson<Partial<FormState>>('local', CONFIG_KEY) ?? {};
  return {
    serverUrl: l.server ?? saved.serverUrl ?? '',
    roomId: l.room ?? saved.roomId ?? '',
    // a bet id is for one bet (and pins the focus): it is not remembered across visits
    betId: l.bet ?? '',
    stageKey: l.key ?? '',
    token: l.token ?? '',
    demoKey: l.demo ?? '',
  };
}

/** The PAID moment: true for PAID_MOMENT_MS after a fresh payout of the focused bet appears. */
function usePaidMoment(bet: BetView | null, now: number): boolean {
  const [shown, setShown] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const key = bet?.paid_at ? `${bet.bet_id}:${bet.paid_at}` : null;
  useEffect(() => {
    if (!key || seen.current.has(key)) return;
    seen.current.add(key);
    if (now - Date.parse(bet!.paid_at!) > PAID_FRESH_MS) return; // an old payout (cold start)
    setShown(key);
    const t = setTimeout(() => setShown((s) => (s === key ? null : s)), PAID_MOMENT_MS);
    return () => clearTimeout(t);
    // deps: once per payout key, not on every clock tick
  }, [key]);
  return shown !== null && shown === key;
}

/** `hold.current`: a live beat is on, so the downloads wait (and one in flight is aborted). */
function useReplays(enabled: boolean, hold: { readonly current: boolean }): ReplayStatus {
  const [s, setS] = useState<ReplayStatus>(initialReplays);
  useEffect(() => {
    if (!enabled || typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function')
      return;
    let cancelled = false;
    const urls: string[] = [];
    // after the page settles, so the bundle and the socket go first
    const t = setTimeout(() => {
      void preloadReplays({
        fetch: (u, init) => fetch(u, init), // the signal: a pause aborts the download
        createObjectURL: (b) => {
          const u = URL.createObjectURL(b);
          urls.push(u);
          return u;
        },
        cancelled: () => cancelled,
        paused: () => hold.current,
        onChange: (beat, state, url) =>
          setS((prev) => ({
            clips: { ...prev.clips, [beat]: state },
            urls: url ? { ...prev.urls, [beat]: url } : prev.urls,
          })),
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(t);
      for (const u of urls) URL.revokeObjectURL(u);
    };
    // hold is a ref: reading it does not restart the download
  }, [enabled]);
  return s;
}

function useDemoHealth(live: Live | null) {
  const [health, setHealth] = useState<DemoHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!live?.demoKey) {
      setHealth(null);
      setError(null);
      return;
    }
    let stop = false;
    const poll = () =>
      fetchDemoHealth(live.serverUrl, live.demoKey!).then(
        (h) => {
          if (stop) return;
          setHealth(h);
          setError(null);
        },
        (err: unknown) => !stop && setError(err instanceof Error ? err.message : String(err)),
      );
    void poll();
    const i = setInterval(poll, HEALTH_POLL_MS);
    return () => {
      stop = true;
      clearInterval(i);
    };
  }, [live]);
  return { health, error };
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  } catch {
    // fullscreen not allowed (iframe / old browser)
  }
}

/** The connect form's REPLAY line: how many clips are in memory yet. */
export function ReplayLine({ replays, off }: { replays: ReplayStatus; off: boolean }) {
  const p = replayProgress(replays);
  if (off) return <p className="muted small">REPLAY clips: not preloaded (?nopreload)</p>;
  if (p.state === 'done' && p.present === 0)
    return <p className="warn small">REPLAY clips: none on this server (replay/beat1-6.mp4)</p>;
  return (
    <p className={`small ${p.state === 'done' && p.ready === p.present ? 'good' : 'muted'}`}>
      REPLAY clips: {p.ready}/{p.present} in memory
      {p.state === 'loading' ? ' · downloading…' : p.state === 'done' ? '' : ' · waiting…'}
    </p>
  );
}

export function App() {
  const [launch] = useState(readLaunch);
  const [form, setForm] = useState<FormState>(() => initialForm(launch));
  const [state, dispatch] = useReducer(applyFrame, initialTicker);
  const [overlay, setOverlay] = useState<
    { kind: 'replay'; beat: number } | { kind: 'qr' | 'help' } | null
  >(null);
  const [live, setLive] = useState<Live | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conn = useRef<StageConnection | null>(null);
  /** Bumped by every start(): answers for an older connection are dropped. */
  const generation = useRef(0);
  const seeded = useRef(new Set<string>());
  /** Bets re-fetched once for their appeal deadline. */
  const refetched = useRef(new Set<string>());
  /** Evidence frames already requested (`bet|attempt|count`), and their object URLs. */
  const framesAsked = useRef(new Set<string>());
  const frameUrls = useRef<string[]>([]);
  /** Gemini bets whose evidence chain was asked for: bet id -> the bet's state when asked. */
  const settlementAsked = useRef(new Map<string, string>());
  /** Gemini bets' evidence re-checks (verifyEvidence), by bet id. */
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const verificationsRef = useRef(verifications);
  verificationsRef.current = verifications;
  const stateRef = useRef(state);
  stateRef.current = state;
  const now = useNow(state.clockOffsetMs);
  // the REPLAY downloads hold while a live bet is on (the hotspot is the phones' first)
  const holdReplays = useRef(false);
  holdReplays.current = liveBetInProgress(state, now - (state.clockOffsetMs ?? 0));
  const replays = useReplays(!launch.noPreload, holdReplays);
  const { health, error: healthError } = useDemoHealth(live);
  const [previewStart] = useState(() => Date.now());

  // ?preview=gemini: the Beat 6 sample, rebuilt once per slot (it replays every tick so far)
  const marketPreview = launch.preview === MARKET_PREVIEW;
  const marketSlot = marketPreview ? Math.floor(now / MARKET_PREVIEW_SLOT_MS) : 0;
  const marketPv = useMemo(
    () =>
      marketPreview ? previewMarketState(previewStart, marketSlot * MARKET_PREVIEW_SLOT_MS) : null,
    [marketPreview, previewStart, marketSlot],
  );
  const pv = useMemo(
    () =>
      launch.preview === null
        ? null
        : marketPv
          ? { state: marketPv, now }
          : previewAt(previewStart, now, launch.preview || null),
    [launch.preview, marketPv, previewStart, now],
  );
  const shown = pv ? pv.state : state;
  const shownNow = pv ? pv.now : now;
  const focus = shown.focusBetId ? (shown.bets[shown.focusBetId] ?? null) : null;
  const paidMoment = usePaidMoment(focus, shownNow);

  // Secrets never stay in the address bar (or the browser history) on a projector.
  useEffect(() => {
    try {
      const clean = scrubbedHref(globalThis.location.href);
      if (clean) globalThis.history.replaceState(null, '', clean);
    } catch {
      // not a browser
    }
  }, []);

  useEffect(() => () => conn.current?.stop(), []);

  const disconnect = useCallback(() => {
    generation.current++;
    conn.current?.stop();
    conn.current = null;
    seeded.current = new Set();
    setLive(null);
    writeJson('session', SESSION_KEY, null);
  }, []);

  /** Connects to a room. Throws (before touching anything) on a server that is not a URL. */
  const start = useCallback((s: StartParams) => {
    const serverUrl = resolveServer(s.serverUrl, origin());
    const wsUrl = wsUrlFor(serverUrl);
    const gen = ++generation.current;
    conn.current?.stop();
    seeded.current = new Set();
    refetched.current = new Set();
    framesAsked.current = new Set();
    settlementAsked.current = new Map();
    setVerifications({});
    for (const u of frameUrls.current.splice(0)) URL.revokeObjectURL(u);
    dispatch({ kind: 'reset' }); // a different room must not inherit the last one's bets
    // ?bet= / the form's bet id keeps the focus until that bet is over; a reload comes back to
    // the card it showed
    if (s.betId) dispatch({ kind: 'focus', bet_id: s.betId, pin: true });
    else if (s.resume?.focus) dispatch({ kind: 'focus', bet_id: s.resume.focus });
    const c = new StageConnection({ wsUrl, token: s.token, roomId: s.roomId, onAction: dispatch });
    conn.current = c;
    c.start();
    setLive({
      token: s.token,
      serverUrl,
      roomId: s.roomId,
      roomLabel: s.roomLabel,
      demoKey: s.demoKey,
      lockSigner: s.lockSigner,
    });
    fetchMarket(serverUrl, s.token).then(
      (snapshot) =>
        gen === generation.current &&
        dispatch({ kind: 'market', snapshot, receivedAt: Date.now() }),
      () => undefined, // the feed may be off; stage.market frames fill it later
    );
    // Bets the page was told about load their snapshot first, then subscribe (seed.ts).
    const told = [
      ...(s.betId ? [s.betId] : []),
      ...(s.resume?.focus ? [s.resume.focus] : []),
      ...(s.resume?.bets ?? []),
    ].filter((id, i, all) => isUuid(id) && all.indexOf(id) === i);
    for (const id of told) {
      seeded.current.add(id);
      void seedBet(
        id,
        {
          fetchSnapshot: (bet) => fetchBetSnapshot(serverUrl, s.token, bet),
          dispatch,
          subscribe: (bet) => c.subscribe(bet, 0),
          current: () => gen === generation.current,
          failed: (bet) => seeded.current.delete(bet), // the room may show it again later
        },
        { quiet: id !== s.betId },
      );
    }
  }, []);

  const connect = useCallback(
    async (f: FormState) => {
      setConnectError(null);
      setBusy(true);
      const room = f.roomId.trim();
      const betId = f.betId?.trim() || null;
      const demoKey = f.demoKey?.trim() || null;
      try {
        const serverUrl = resolveServer(f.serverUrl, origin());
        if (!room) throw new Error('Enter the room code from phone A.');
        if (betId && !isUuid(betId)) throw new Error('The bet id is a uuid (or leave it empty).');
        dispatch({ kind: 'status', status: 'authorizing' });
        let token = f.token?.trim() ?? '';
        let roomId = room;
        let expiresAt: string | null = null;
        let lockSigner: LockSigner = null;
        if (!token) {
          if (!f.stageKey?.trim()) throw new Error('Enter the stage key.');
          const s = await openStageSession({
            serverUrl,
            roomId: room,
            stageKey: f.stageKey.trim(),
          });
          token = s.token;
          roomId = s.room_id;
          expiresAt = s.expires_at;
          lockSigner = s.lock_signer;
        } else if (!isUuid(room)) {
          throw new Error('With a pasted stage token, give the room id (uuid), not its code.');
        }
        const roomLabel = roomLabelOf(room);
        // connect first: only a session that started is saved (a reload resumes it)
        start({ serverUrl: f.serverUrl, token, roomId, roomLabel, betId, demoKey, lockSigner });
        const saved: SavedSession = {
          serverUrl: f.serverUrl.trim(),
          roomId,
          token,
          demoKey,
          betId,
          expiresAt,
          roomLabel,
          lockSigner,
        };
        writeJson('session', SESSION_KEY, saved);
        writeJson('local', CONFIG_KEY, { serverUrl: f.serverUrl.trim(), roomId: room });
      } catch (err) {
        dispatch({ kind: 'status', status: 'closed' });
        setConnectError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [start],
  );

  // Launch: a key / token in the URL connects at once; else a saved session of this tab resumes.
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current || launch.preview !== null) return;
    launched.current = true;
    if (launch.key || launch.token) {
      void connect(initialForm(launch));
      return;
    }
    const s = loadSession(Date.now());
    if (!s) return;
    try {
      start({
        serverUrl: s.serverUrl,
        token: s.token,
        roomId: s.roomId,
        roomLabel: s.roomLabel ?? roomLabelOf(s.roomId),
        betId: s.betId,
        demoKey: s.demoKey,
        lockSigner: normalizeSigner(s.lockSigner),
        resume: { focus: s.focusBetId ?? null, bets: s.bets ?? [] },
      });
    } catch (err) {
      // a saved session that cannot start must not blank the page on every reload
      writeJson('session', SESSION_KEY, null);
      setConnectError(`Could not resume: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [connect, launch, start]);

  // A rejected token / wrong room is final: back to the form with the reason.
  useEffect(() => {
    if (!live) return;
    if (state.closeCode === WS_CLOSE.UNAUTHORIZED || state.closeCode === WS_CLOSE.FORBIDDEN) {
      setConnectError(state.errors.at(-1) ?? `closed ${state.closeCode}`);
      disconnect();
    }
  }, [state.closeCode, state.errors, live, disconnect]);

  // Every bet seen for the first time: subscribe from seq 0 (replays what happened before the
  // stage connected; duplicates are dropped by (bet_id, seq)) and seed its card from
  // GET /v1/bets/:id.
  const betIds = Object.keys(state.bets).join(',');
  useEffect(() => {
    if (!live) return;
    const gen = generation.current;
    for (const id of betIds ? betIds.split(',') : []) {
      if (seeded.current.has(id)) continue;
      seeded.current.add(id);
      conn.current?.subscribe(id, 0);
      fetchBetSnapshot(live.serverUrl, live.token, id).then(
        (bet) =>
          gen === generation.current && dispatch({ kind: 'snapshot', bet, receivedAt: Date.now() }),
        (err: unknown) =>
          gen === generation.current && dispatch({ kind: 'error', message: String(err) }),
      );
    }
  }, [betIds, live]);

  // The saved session remembers the card on screen and the bets the page knows, so a reload
  // (Cmd+R, a crashed tab) comes back to the same card instead of "Waiting for a challenge…".
  useEffect(() => {
    if (!live) return;
    rememberBets(state.focusBetId, betIds ? betIds.split(',') : []);
  }, [live, state.focusBetId, betIds]);

  // RULED but no countdown yet (bet.state's reason did not carry appeal_deadline, and Streams'
  // BetResolved has not come): the payout service writes bets.appeal_deadline at the confirmed
  // resolve, so one more GET /v1/bets/:id fills it. Once per bet, only when the last snapshot
  // predates the ruling.
  const deadlineWanted = deadlineRefetches(state).join(',');
  useEffect(() => {
    if (!live || !deadlineWanted) return;
    for (const id of deadlineWanted.split(',')) {
      if (refetched.current.has(id)) continue;
      refetched.current.add(id);
      fetchBetSnapshot(live.serverUrl, live.token, id).then(
        (bet) => dispatch({ kind: 'snapshot', bet, receivedAt: Date.now() }),
        () => undefined, // the card works without the countdown
      );
    }
  }, [deadlineWanted, live]);

  // Evidence frames: attempt.evidence carries no frame_urls yet (the server keeps the JPEGs in
  // Postgres), so each frame is fetched once with the stage bearer and shown from a blob URL.
  const framesWanted = Object.values(state.bets)
    .flatMap((b) =>
      b.evidence && !b.frame_urls.length
        ? [`${b.bet_id}|${b.evidence.attempt_no}|${b.evidence.frames}`]
        : [],
    )
    .join(',');
  useEffect(() => {
    if (!live || !framesWanted) return;
    for (const want of framesWanted.split(',')) {
      if (framesAsked.current.has(want)) continue;
      framesAsked.current.add(want);
      const [betId, n, count] = want.split('|') as [string, string, string];
      void (async () => {
        for (let idx = 0; idx < Number(count); idx++) {
          try {
            const blob = await fetchFrame(live.serverUrl, live.token, betId, Number(n), idx);
            const url = URL.createObjectURL(blob);
            frameUrls.current.push(url);
            dispatch({ kind: 'frame_blob', bet_id: betId, attempt_no: Number(n), idx, url });
          } catch (err) {
            dispatch({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
            return;
          }
        }
      })();
    }
  }, [framesWanted, live]);

  // Beat 6: once a Gemini bet is ruled (the resolve landed), fetch its evidence chain
  // (GET /v1/bets/:id/settlement) and re-check it here (verifyEvidence), so the projector shows
  // Gemini's bytes tied to the on-chain hashes. Once per bet, and once more on a later state if
  // that answer had no on-chain hashes yet (the server could not read the chain); a failed fetch
  // is retried on the next change.
  const settlementsWanted = settlementFetches(state)
    .map((b) => `${b.bet_id}|${b.state}`)
    .join(',');
  useEffect(() => {
    if (!live || !settlementsWanted) return;
    const gen = generation.current;
    for (const want of settlementsWanted.split(',')) {
      const [id, st] = want.split('|') as [string, string];
      const askedAt = settlementAsked.current.get(id);
      if (
        askedAt !== undefined &&
        (askedAt === st || verificationsRef.current[id]?.onchain !== false)
      )
        continue;
      settlementAsked.current.set(id, st);
      fetchSettlement(live.serverUrl, live.token, id).then(
        (ev) => {
          if (gen !== generation.current) return;
          const bet = stateRef.current.bets[id];
          const v = bet ? verifyEvidence(bet, ev) : null;
          if (v) setVerifications((m) => ({ ...m, [id]: v }));
        },
        (err: unknown) => {
          if (gen !== generation.current) return;
          settlementAsked.current.delete(id); // retry on the next change
          dispatch({ kind: 'error', message: `settlement ${id}: ${String(err)}` });
        },
      );
    }
  }, [settlementsWanted, live]);

  // A reconnect's hello resumes each bet after the last seq applied, not from 0.
  useEffect(() => {
    for (const [id, seq] of Object.entries(state.lastSeq)) conn.current?.noteSeq(id, seq);
  }, [state.lastSeq]);

  // Sound: unlocked by the first key press / click (browsers require a gesture); M mutes.
  const audio = useRef<StageAudio | null>(null);
  audio.current ??= new StageAudio();
  const [sound, setSound] = useState<'locked' | 'on' | 'off'>('locked');
  const heard = useRef(new Set<string>());
  useEffect(() => {
    const fresh: Sfx[] = [];
    for (const id of Object.keys(shown.bets))
      fresh.push(...freshSounds(shown, id, heard.current, shownNow));
    // one sound per update: the newest moment wins
    if (fresh.length) audio.current?.play(fresh[fresh.length - 1]!);
  }, [shown, shownNow]);

  // Stage cues (gavel, drumroll, …): a flash on the projector, and the sound.
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!shown.cueCount || !shown.lastCue) return;
    setFlash(shown.lastCue.kind);
    if (isSfx(shown.lastCue.kind)) audio.current?.play(shown.lastCue.kind);
    const t = setTimeout(() => setFlash(null), 900);
    return () => clearTimeout(t);
  }, [shown.cueCount, shown.lastCue]);

  useEffect(() => {
    const unlock = () => {
      const a = audio.current!;
      a.unlock();
      // resume() settles asynchronously; read the state on the next frame
      setTimeout(() => setSound(a.muted ? 'off' : a.ready ? 'on' : 'locked'), 50);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'escape') setOverlay(null);
      else if (k === 'f') toggleFullscreen();
      else if (k === 'q') setOverlay((o) => (o?.kind === 'qr' ? null : { kind: 'qr' }));
      else if (k === 'h' || k === '?')
        setOverlay((o) => (o?.kind === 'help' ? null : { kind: 'help' }));
      else if (k === 'm') {
        const a = audio.current!;
        a.muted = !a.muted;
        if (!a.muted) a.play('lock');
      } else {
        const n = Number(e.key);
        if ((REPLAY_BEATS as readonly number[]).includes(n))
          setOverlay({ kind: 'replay', beat: n });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const field = (
    k: keyof FormState,
    label: string,
    opts: { type?: string; placeholder?: string } = {},
  ) => (
    <label>
      <span>{label}</span>
      <input
        type={opts.type ?? 'text'}
        value={form[k] ?? ''}
        placeholder={opts.placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(ev) => setForm({ ...form, [k]: ev.target.value })}
      />
    </label>
  );

  const otherServer = foreignServer(form.serverUrl, origin());

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void connect(form);
  };

  return (
    <>
      {pv || live ? (
        <StageView
          state={shown}
          now={shownNow}
          preview={pv ? launch.preview : null}
          onDisconnect={live ? disconnect : undefined}
          health={pv ? PREVIEW_HEALTH : health}
          healthError={pv ? null : healthError}
          showHealth={pv ? true : !!live?.demoKey}
          replays={replays}
          roomLabel={pv ? 'PREVIEW' : (live?.roomLabel ?? null)}
          sound={sound}
          lockSigner={pv ? null : (live?.lockSigner ?? normalizeSigner(health?.lock_signer))}
          verifications={pv ? undefined : verifications}
        />
      ) : (
        <div className="stage connect">
          <h1>
            You&apos;re <span className="on">On</span> <span className="muted">· stage</span>
          </h1>
          <form onSubmit={onSubmit}>
            {field('roomId', 'Room code (on phone A) or room id', { placeholder: 'ABC234' })}
            {field('stageKey', 'Stage key', { type: 'password' })}
            <details>
              <summary>More</summary>
              {field('serverUrl', 'Server', { placeholder: `this server (${origin()})` })}
              {field('token', 'or a stage token', { type: 'password' })}
              {field('betId', 'Bet id (optional)')}
              {field('demoKey', 'Demo admin key (health strip)', { type: 'password' })}
            </details>
            {otherServer && (
              <p className="warn server-note">
                Server: <code>{otherServer}</code> (not this page&apos;s server). The stage key goes
                there.
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            {connectError && <p className="bad">{connectError}</p>}
            {launch.secretInQuery && (
              <p className="warn">
                A key after <code>?</code> in the link was ignored: it reaches the server&apos;s
                logs. Put it after <code>#</code> instead (<code>#key=…</code>).
              </p>
            )}
            {launch.serverIgnored && (
              <p className="muted small">
                The link&apos;s server= was ignored: this page only talks to its own server.
              </p>
            )}
          </form>
          <ReplayLine replays={replays} off={launch.noPreload} />
          <p className="muted small">
            Keys: 1–6 REPLAY clips · F full screen · Q big QR · H help ·{' '}
            <a href="?preview">open the preview</a>
          </p>
          <p className="muted small tip">
            No typing on the projector: open{' '}
            <code>/stage/?room=ABC234#key=STAGE_KEY&amp;demo=DEMO_ADMIN_TOKEN</code> (the part after
            # never leaves this laptop, and is cleared from the address bar).
          </p>
        </div>
      )}
      {paidMoment && focus?.payout && <PaidMoment bet={focus} />}
      {flash && <div className={`flash ${flash}`} aria-hidden="true" />}
      {overlay?.kind === 'replay' && (
        <ReplayOverlay
          key={overlay.beat}
          beat={overlay.beat}
          src={replaySrc(replays, overlay.beat)}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay?.kind === 'qr' && (
        <QrOverlay tx={focus ? featuredTx(focus) : null} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === 'help' && <HelpOverlay onClose={() => setOverlay(null)} />}
    </>
  );
}
