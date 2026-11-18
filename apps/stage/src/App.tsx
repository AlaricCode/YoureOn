// Stage view (TASKS D1-J5, D2-J3, D3-J4, D5-J1; ARCHITECTURE §8.2): the laptop on the projector.
// Served by the API server at /stage (apps/server/src/stage/static.ts), so it talks to its own
// origin: POST /v1/stage/session (STAGE_KEY + room code -> stage token), then one /v1/ws socket
// for the room. Opening
//
//   https://<app>.fly.dev/stage/?room=ABC234#key=<STAGE_KEY>&demo=<DEMO_ADMIN_TOKEN>
//
// connects with no typing (config.ts); ?preview plays a sample bet with no server (preview.ts).
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
import { applyFrame, initialTicker, type BetView } from './ticker';
import {
  fetchBetSnapshot,
  fetchMarket,
  openStageSession,
  StageConnection,
  wsUrlFor,
  type StageConfig,
} from './connection';
import {
  CONFIG_KEY,
  isUuid,
  loadSession,
  parseLaunch,
  readJson,
  resolveServer,
  scrubbedHref,
  SESSION_KEY,
  writeJson,
  type LaunchParams,
  type SavedSession,
} from './config';
import { fetchDemoHealth, HEALTH_POLL_MS, type DemoHealth } from './health';
import { PREVIEW_HEALTH, previewAt } from './preview';
import { freshSounds, isSfx, StageAudio, type Sfx } from './sound';
import {
  initialReplays,
  preloadReplays,
  replaySrc,
  REPLAY_BEATS,
  type ReplayStatus,
} from './replays';
import { featuredTx, HelpOverlay, PaidMoment, QrOverlay, ReplayOverlay, StageView } from './view';

export {
  BetCard,
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
    return parseLaunch(globalThis.location?.search ?? '', globalThis.location?.hash ?? '');
  } catch {
    return parseLaunch('', '');
  }
}

function initialForm(l: LaunchParams): FormState {
  const saved = readJson<Partial<FormState>>('local', CONFIG_KEY) ?? {};
  return {
    serverUrl: l.server ?? saved.serverUrl ?? '',
    roomId: l.room ?? saved.roomId ?? '',
    betId: l.bet ?? saved.betId ?? '',
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

function useReplays(enabled: boolean): ReplayStatus {
  const [s, setS] = useState<ReplayStatus>(initialReplays);
  useEffect(() => {
    if (!enabled || typeof fetch !== 'function' || typeof URL.createObjectURL !== 'function')
      return;
    let cancelled = false;
    const urls: string[] = [];
    // after the page settles, so the bundle and the socket go first
    const t = setTimeout(() => {
      void preloadReplays({
        fetch: (u) => fetch(u),
        createObjectURL: (b) => {
          const u = URL.createObjectURL(b);
          urls.push(u);
          return u;
        },
        cancelled: () => cancelled,
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
  const seeded = useRef(new Set<string>());
  const now = useNow(state.clockOffsetMs);
  const replays = useReplays(!launch.noPreload);
  const { health, error: healthError } = useDemoHealth(live);
  const [previewStart] = useState(() => Date.now());

  const pv = useMemo(
    () => (launch.preview === null ? null : previewAt(previewStart, now, launch.preview || null)),
    [launch.preview, previewStart, now],
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
    conn.current?.stop();
    conn.current = null;
    seeded.current = new Set();
    setLive(null);
    writeJson('session', SESSION_KEY, null);
  }, []);

  const start = useCallback(
    (s: {
      serverUrl: string;
      token: string;
      roomId: string;
      roomLabel: string;
      betId: string | null;
      demoKey: string | null;
    }) => {
      conn.current?.stop();
      seeded.current = new Set();
      const serverUrl = resolveServer(s.serverUrl, origin());
      conn.current = new StageConnection({
        wsUrl: wsUrlFor(serverUrl),
        token: s.token,
        roomId: s.roomId,
        onAction: dispatch,
        subs: s.betId ? [{ bet_id: s.betId, after_seq: 0 }] : [],
      });
      conn.current.start();
      setLive({
        token: s.token,
        serverUrl,
        roomId: s.roomId,
        roomLabel: s.roomLabel,
        demoKey: s.demoKey,
      });
      fetchMarket(serverUrl, s.token).then(
        (snapshot) => dispatch({ kind: 'market', snapshot, receivedAt: Date.now() }),
        () => undefined, // the feed may be off; stage.market frames fill it later
      );
      if (s.betId) {
        seeded.current.add(s.betId);
        fetchBetSnapshot(serverUrl, s.token, s.betId).then(
          (bet) => dispatch({ kind: 'snapshot', bet, receivedAt: Date.now() }),
          (err: unknown) => dispatch({ kind: 'error', message: String(err) }),
        );
      }
    },
    [],
  );

  const connect = useCallback(
    async (f: FormState) => {
      setConnectError(null);
      setBusy(true);
      const serverUrl = resolveServer(f.serverUrl, origin());
      const room = f.roomId.trim();
      const betId = f.betId?.trim() || null;
      const demoKey = f.demoKey?.trim() || null;
      writeJson('local', CONFIG_KEY, {
        serverUrl: f.serverUrl.trim(),
        roomId: room,
        betId: betId ?? '',
      });
      try {
        if (!room) throw new Error('Enter the room code from phone A.');
        dispatch({ kind: 'status', status: 'authorizing' });
        let token = f.token?.trim() ?? '';
        let roomId = room;
        let expiresAt: string | null = null;
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
        } else if (!isUuid(room)) {
          throw new Error('With a pasted stage token, give the room id (uuid), not its code.');
        }
        const saved: SavedSession = {
          serverUrl: f.serverUrl.trim(),
          roomId,
          token,
          demoKey,
          betId,
          expiresAt,
        };
        writeJson('session', SESSION_KEY, { ...saved, roomLabel: room });
        start({ serverUrl: f.serverUrl, token, roomId, roomLabel: room, betId, demoKey });
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
    const s = loadSession(Date.now()) as (SavedSession & { roomLabel?: string }) | null;
    if (s)
      start({
        serverUrl: s.serverUrl,
        token: s.token,
        roomId: s.roomId,
        roomLabel: s.roomLabel ?? s.roomId,
        betId: s.betId,
        demoKey: s.demoKey,
      });
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
    for (const id of betIds ? betIds.split(',') : []) {
      if (seeded.current.has(id)) continue;
      seeded.current.add(id);
      conn.current?.subscribe(id, 0);
      fetchBetSnapshot(live.serverUrl, live.token, id).then(
        (bet) => dispatch({ kind: 'snapshot', bet, receivedAt: Date.now() }),
        (err: unknown) => dispatch({ kind: 'error', message: String(err) }),
      );
    }
  }, [betIds, live]);

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
            <button type="submit" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            {connectError && <p className="bad">{connectError}</p>}
          </form>
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
