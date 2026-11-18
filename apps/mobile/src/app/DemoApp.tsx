// The real app root (beats 1-4 on the phone), forked from PreviewApp's routes but driven by the
// server: the route comes from ./machine selectRoute(app state, the active bet's server state).
//   signup | demo claim (custodial demo seed -> wallet.importSeed, decision D-A)
//   -> face enrollment offered right after signup (skippable; consent first) and in Profile
//   -> home: rooms (create / join / presence) -> challenge from the list (POST /v1/bets 'list')
//      or by face: "Scan a face" -> on-device embedding -> POST face-match -> "Challenge Jake?"
//      -> POST /v1/bets 'face' + match_ticket (no match: "No match" and the room list)
//   -> B: full-screen invite + haptic -> negotiate (captions, draft; on A's phone "Type it
//      instead", automatic with EXPO_PUBLIC_VOICE=off or a failed voice session) -> terms card (hash checked,
//      device policy, hold -> Face ID -> sign -> PartyAuthorization; or the server pushes LOCKED)
//   -> live / judge cam (record, frames, upload) -> ruling (GG = concede, Face ID) / REDO
//   -> payout with GET /v1/me/balance.
// Beat 6 (the closer): on A's negotiate screen "Bet on Bitcoin" (app/marketTerms) shows Gemini's
// live odds and the fair split, proposes at the binding quote, then the same terms card and lock;
// a locked Gemini bet shows the market clock (live price by market.tick) until Gemini settles.
// No simulated Face ID here (that lives in src/preview only). Party screens never show chain
// words: server text that reaches a screen goes through ui/copyRule first.
import { StatusBar } from 'expo-status-bar';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import type {
  BetSnapshot,
  CreateBetResponse,
  RoomMember,
  VoiceDynamicVariables,
} from '@youre-on/shared/api';
import { isReplayTicker } from '@youre-on/shared/judge/market-terms';
import { otherParty, type Party } from '@youre-on/shared/primitives';
import { formatPrice } from '@youre-on/shared/settlement';

import { extractFrames, readClip } from '../attempt/capture';
import { startAttemptVia, startsAttempt, type Recorder } from '../attempt/recorder';
import { initialLock, lockReducer, type AuthFailure } from '../bets/lock';
import { emptyBet, endReasonOf, lockSignals, type BetModel } from '../bets/store';
import { betView, myResult, type BetView } from '../bets/view';
import { feel } from '../device/feedback';
import { PanelErrorBoundary } from '../diagnostics/PanelErrorBoundary';
import { createServerFaceApi, type FaceStatus } from '../enroll/api';
import { createLazyEmbedder } from '../enroll/embedder';
import { FaceEnrollFlow, FaceSettings } from '../enroll/EnrollScreens';
import type { Balance } from '../net/api';
import { ApiClientError } from '../net/signedFetch';
import {
  IncomingScreen,
  NegotiateScreen,
  ScanScreen,
  type Caption,
} from '../screens/ChallengeScreens';
import { COPY, t } from '../screens/copy';
import { DemoClaimScreen } from '../screens/DemoClaimScreen';
import { HistoryScreen, HomeScreen, ProfileScreen } from '../screens/HomeScreens';
import { LockEndedScreen, TermsCardScreen } from '../screens/LockScreens';
import {
  JudgeCamScreen,
  LiveScreen,
  MarketScreen,
  PayoutScreen,
  RedoScreen,
  RulingScreen,
  type CamArm,
  type Clip,
  type LivePhase,
  type PayoutPhase,
} from '../screens/PlayScreens';
import type { HistoryItem, PreviewUser } from '../preview/data';
import { createServerSignupApi } from '../signup/api';
import { SignupScreen } from '../signup/SignupScreen';
import { Label, PrimaryButton } from '../ui/kit';
import { isCopyOk } from '../ui/copyRule';
import { Page, Screen, StatusHero } from '../ui/parts';
import { palette } from '../ui/tokens';
import { micMutedFor, type SessionPhase } from '../voice/session';
import { WalletError } from '../wallet/wallet';
import {
  authorizeLock,
  checkLockPolicy,
  concede,
  sendAttempt,
  type PreparedAttempt,
} from './actions';
import {
  appReducer,
  initialApp,
  isOver,
  nextAttemptNo,
  selectRoute,
  type AppEvent,
  type AppState,
} from './machine';
import {
  canConfirmMarket,
  canSubmitMarket,
  confirmMarketTerms,
  fetchMarketQuote,
  initialMarket,
  MARKET_STAKES_USD,
  marketReducer,
  QUOTE_POLL_MS,
  shouldPoll,
  splitLabel,
  submitMarketTerms,
  waitingForAcceptMarket,
  type MarketStakeUsd,
} from './marketTerms';
import { HISTORY_LIMIT, historyFrom } from './history';
import { HOME_NOTE_MS, homeErrorLabel } from './homeErrors';
import { demoLinkLives, parseDeepLink } from './deepLink';
import { attemptStartAlert, createJudgeCamSync, deviceRoleRequest } from './judgeCam';
import { RESUME_LIMIT, resumable } from './resume';
import { importSafely } from './importSafely';
import { getRuntime, type Runtime } from './runtime';
import {
  challengeErrorResult,
  runScan,
  ticketFresh,
  type ChallengeResult,
  type ScanMatch,
} from './scan';
import {
  canConfirm,
  canSubmit,
  confirmTypedTerms,
  initialTyped,
  submitTypedTerms,
  TYPED_STAKES_USD,
  typedReducer,
  waitingForAccept,
  type TypedStakeUsd,
} from './typedTerms';

const LAST_ROOM_KEY = 'youreon.room.v1';
/**
 * This phone's judge-cam memo (./judgeCam): bound to this device and user, it brings a judge cam
 * back after a restart, or re-sends a turn-off the server never confirmed.
 */
const JUDGE_CAM_KEY = 'youreon.judgecam.v1';
/** EXPO_PUBLIC_VOICE=off builds run without the live judge (screens still follow the server). */
const VOICE_ENABLED = process.env.EXPO_PUBLIC_VOICE !== 'off';
/** EXPO_PUBLIC_MARKET=off hides "Bet on Bitcoin" (the server refuses it without the Gemini relay). */
const MARKET_ENABLED = process.env.EXPO_PUBLIC_MARKET !== 'off';
/** A voice SDK that throws while it loads falls back to typed terms (the boundary below). */
const JudgeVoice = lazy(() => importSafely(() => import('../voice/JudgeVoice')));
/** How long A's judge session outlives its bet: the closing [EVENT] line, spoken (§4.5). */
const VOICE_TAIL_MS = 20_000;
/** EXPO_PUBLIC_FACE=off hides face enrollment and the face scan (the room list still works). */
const FACE_ENABLED = process.env.EXPO_PUBLIC_FACE !== 'off';
/** The face natives load on first use, never at app start (see createLazyEmbedder). */
const loadFaceEmbedder = () => import('../face/native').then((m) => m.getNativeEmbedder());
const JUDGE_CAM_POLL_MS = 3_000;
const FILMING_TIP = 'Keep the whole table in the shot, and stop a beat after it lands.';
const FALLBACK_REASON = 'The judge ruled on the clip.';

export default function DemoApp({ onOperator }: { onOperator: () => void }) {
  const [rt, setRt] = useState<Runtime | null>(null);
  const [failed, setFailed] = useState(false);
  const start = useCallback(() => {
    setFailed(false);
    getRuntime().then(setRt, () => setFailed(true));
  }, []);
  useEffect(start, [start]);
  if (!rt) return <Loading failed={failed} onRetry={start} />;
  return <DemoAppInner rt={rt} onOperator={onOperator} />;
}

function Loading({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return (
    <Screen>
      <Page>
        <View style={styles.center}>
          <StatusHero
            mark={failed ? 'cross' : 'ring'}
            title={t(failed ? COPY.app.offline : COPY.app.loading)}
          />
        </View>
        {failed ? <PrimaryButton label={t(COPY.app.failed)} onPress={onRetry} /> : null}
      </Page>
    </Screen>
  );
}

const toPreviewUser = (m: RoomMember): PreviewUser => ({
  user_id: m.user.user_id,
  display_name: m.user.display_name,
  online: m.online,
  face_enrolled: m.face_enrolled,
});

/** Server text on a party screen: shown only if it passes the copy rule. */
const safeData = (text: string | null | undefined, fallback: string) =>
  text && isCopyOk(text, 'data') ? text : fallback;

function DemoAppInner({ rt, onOperator }: { rt: Runtime; onOperator: () => void }) {
  const reducer = useCallback(
    (s: AppState, e: AppEvent) => appReducer(s, e, (id) => rt.hub.get(id)),
    [rt],
  );
  const [app, dispatch] = useReducer(reducer, initialApp);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const [lock, lockDispatch] = useReducer(lockReducer, initialLock);
  const [typed, typedDispatch] = useReducer(typedReducer, initialTyped);
  const [market, marketDispatch] = useReducer(marketReducer, initialMarket);
  /** The bet whose voice session failed (no key, token refused, SDK error): type it instead. */
  const [voiceFailedBet, setVoiceFailedBet] = useState<string | null>(null);
  /** The judge session's phase and whether the judge is talking (NegotiateScreen's mic/ring). */
  const [voicePhase, setVoicePhase] = useState<SessionPhase>('idle');
  const [judgeSpeaking, setJudgeSpeaking] = useState(false);
  const [walletKey, setWalletKey] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [busy, setBusy] = useState(false);
  /** Home: why "New room" / "Challenge" failed (clears itself), and the in-flight guards. */
  const [homeNote, setHomeNote] = useState<string | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  /** Bet history (GET /v1/me/bets?status=settled), loaded each time the screen opens. */
  const [history, setHistory] = useState<{
    status: 'loading' | 'ready' | 'failed';
    items: readonly HistoryItem[];
  }>({ status: 'loading', items: [] });
  const challenging = useRef(false);
  const [alert, setAlert] = useState<string | null>(null);
  const [bootFailed, setBootFailed] = useState(false);
  const appRef = useRef(app);
  appRef.current = app;
  const keys = useRef(new Map<string, string>());
  /** One Idempotency-Key per logical action, so a resend after a lost response is the same write. */
  const keyFor = useCallback(
    (k: string) => {
      let v = keys.current.get(k);
      if (!v) {
        v = rt.uuid();
        keys.current.set(k, v);
      }
      return v;
    },
    [rt],
  );
  const signupApi = useMemo(() => createServerSignupApi(rt.sessions), [rt]);
  const faceApi = useMemo(() => createServerFaceApi(rt.client), [rt]);
  /** The on-device embedder (its natives and the model load on first use; the scan screen
   *  warms it up). */
  const embedder = useMemo(() => (FACE_ENABLED ? createLazyEmbedder(loadFaceEmbedder) : null), []);
  /** A face screen crashed (e.g. a native module missing from the build): face is off until
   *  the app restarts, and challenges go through the room list. */
  const [faceBroken, setFaceBroken] = useState(false);
  const faceOn = FACE_ENABLED && !faceBroken;
  const [faceStatus, setFaceStatus] = useState<FaceStatus | null>(null);
  /** Where enrollment returns to: home after the signup offer, else face settings. */
  const enrollFrom = useRef<'signup' | 'settings'>('settings');
  /** A demo-claim token from a youreon:// link: the Demo account screen claims it on a tap. */
  const [demoLink, setDemoLink] = useState<string | null>(null);
  /** A room from a youreon://room/ link that arrived before sign-in. */
  const pendingRoom = useRef<string | null>(null);
  /** POST /v1/bets returns the judge's dynamic variables; only A (the voice host) has them. */
  const voiceVars = useRef(new Map<string, VoiceDynamicVariables>());

  const refreshBalance = useCallback(() => {
    rt.api.balance().then(setBalance, () => undefined);
  }, [rt]);

  const refreshFace = useCallback(() => {
    faceApi.getStatus().then(setFaceStatus, () => undefined);
  }, [faceApi]);
  useEffect(() => {
    if (app.auth === 'signedIn' && app.overlay === 'profile') refreshFace();
  }, [app.auth, app.overlay, refreshFace]);
  /** This phone's role on the server, and the memo that brings it back (./judgeCam). */
  const camSync = useMemo(
    () =>
      createJudgeCamSync({
        setRole: (role, roomId) => rt.api.setDeviceRole(role, roomId),
        save: async (raw) => {
          const S = await import('expo-secure-store');
          await (raw === null
            ? S.deleteItemAsync(JUDGE_CAM_KEY)
            : S.setItemAsync(JUDGE_CAM_KEY, raw));
        },
        owner: () => {
          const a = appRef.current;
          return a.me && a.deviceId ? { device_id: a.deviceId, user_id: a.me.user_id } : null;
        },
      }),
    [rt],
  );

  // ---- boot / session ---------------------------------------------------------------------
  const boot = useCallback(() => {
    setBootFailed(false);
    rt.sessions.restore().then(
      (s) => dispatch({ type: 'booted', me: s?.user ?? null, deviceId: s?.device_id ?? null }),
      () => setBootFailed(true),
    );
  }, [rt]);
  useEffect(() => {
    boot();
    return rt.sessions.onChange((s) =>
      s
        ? dispatch({ type: 'signed_in', me: s.user, deviceId: s.device_id })
        : dispatch({ type: 'signed_out' }),
    );
  }, [rt, boot]);

  const userId = app.me?.user_id ?? null;
  useEffect(() => {
    if (app.auth !== 'signedIn') return;
    rt.ws.start();
    rt.wallet.getPublicKey().then(setWalletKey, () => setWalletKey(null));
    refreshBalance();
    let live = true;
    const linked = pendingRoom.current;
    pendingRoom.current = null;
    // The judge-cam role first (./judgeCam). The memo is this device's AND this user's, so a demo
    // claim as someone else never comes back as a judge cam. The resume below waits for it, so a
    // judge-cam phone never shows A's negotiate or terms screen before it switches.
    const cam = import('expo-secure-store')
      .then((S) => S.getItemAsync(JUDGE_CAM_KEY))
      .catch(() => null)
      .then((raw) => {
        if (!live) return 'none' as const;
        const restored = camSync.restore(raw);
        if (restored === 'judge_cam') dispatch({ type: 'judge_cam', on: true });
        if (restored === 'send_phone') void camSync.off();
        return restored;
      });
    // Re-join the last room (a convenience; the server's room_members row is the truth). A
    // restored judge cam then re-binds itself to that room on the server, which may hold another
    // room or none (a demo claim resets the device to 'phone').
    void cam.then(async (restored) => {
      const S = await import('expo-secure-store').catch(() => null);
      const code = linked ?? (await S?.getItemAsync(LAST_ROOM_KEY).catch(() => null)) ?? null;
      if (code && live && (linked || !appRef.current.room)) await joinRoom(code);
      if (!live || restored !== 'judge_cam' || !appRef.current.judgeCam) return;
      void bindJudgeCam(appRef.current.room?.room_id ?? null);
    });
    // Back into any bet that is still open (./resume): a restart mid-bet used to strand it.
    void (async () => {
      let open: BetSnapshot[];
      try {
        open = resumable((await rt.api.myBets('active', RESUME_LIMIT)).items);
      } catch {
        return; // offline: the bet's own pushes or the next sign-in bring it back
      }
      for (const snap of open) {
        if (!live) return;
        if (!rt.hub.has(snap.bet_id)) await rt.hub.restore(snap);
        rt.ws.subscribe(snap.bet_id);
      }
      await cam; // judge cam or not decides the screen this bet opens on
      const newest = open[0];
      if (live && newest) dispatch({ type: 'bet_opened', bet_id: newest.bet_id });
    })();
    return () => {
      live = false;
      rt.ws.stop();
    };
  }, [app.auth, userId, rt, camSync]);

  // ---- youreon:// links (./deepLink): the stage's room and demo-claim QRs -------------------
  useEffect(() => {
    const open = (url: string | null | undefined) => {
      const link = parseDeepLink(url);
      if (!link) return;
      if (link.kind === 'demoClaim') {
        setDemoLink(link.token);
        dispatch({ type: 'overlay', overlay: 'demoClaim' });
      } else if (appRef.current.auth === 'signedIn') {
        dispatch({ type: 'overlay', overlay: 'none' });
        void joinRoom(link.code);
      } else {
        pendingRoom.current = link.code;
      }
    };
    Linking.getInitialURL().then(open, () => undefined);
    const sub = Linking.addEventListener('url', (e) => open(e.url));
    return () => sub.remove();
  }, [rt]);

  // ---- socket status, presence -------------------------------------------------------------
  useEffect(() => {
    const a = rt.onStatus((s) => {
      dispatch({ type: 'offline', offline: s === 'reconnecting' || s === 'unauthorized' });
      // A turn-off the server never confirmed (./judgeCam): send it again now that it answers.
      if (s === 'live') void camSync.retry();
    });
    const b = rt.onControl((f) => {
      if (f.op === 'room.presence')
        dispatch({ type: 'presence', room_id: f.room_id, members: f.members });
    });
    // 4403: the client already dropped the refused subs. The reason does not name the bet, so
    // keep following the bet on screen unless it was the only one dropped (then it was refused).
    const c = rt.onForbidden((d) => {
      const cur = appRef.current;
      if (d.room && cur.room?.room_id === d.room) dispatch({ type: 'room', room: null });
      if (cur.activeBetId && d.bets.length > 1 && d.bets.includes(cur.activeBetId))
        rt.ws.subscribe(cur.activeBetId);
    });
    return () => {
      a();
      b();
      c();
    };
  }, [rt, camSync]);

  // ---- bet events --------------------------------------------------------------------------
  useEffect(() => {
    const gap = setInterval(() => void rt.hub.tick(), 500);
    const off = rt.hub.onChange((e, before, after) => {
      const a = appRef.current;
      if (
        e?.type === 'bet.invited' &&
        after.my_party === 'B' &&
        after.challenger?.user_id !== a.me?.user_id
      ) {
        rt.ws.subscribe(after.bet_id);
        const cur = a.activeBetId ? rt.hub.get(a.activeBetId) : undefined;
        if (!a.activeBetId || !cur || isOver(cur.state)) {
          dispatch({ type: 'bet_opened', bet_id: after.bet_id });
          feel('challengeArrived');
        }
      }
      if (e && after.bet_id === a.activeBetId && after.my_party) {
        // The card reset + policy run is the effect below (it also covers GET /lock).
        for (const sig of lockSignalsSafe(
          before ?? emptyBet(after.bet_id),
          after,
          e,
          after.my_party,
        ))
          lockDispatch(sig);
        if (e.type === 'bet.state' && e.payload.state === 'LOCKED' && before?.state !== 'LOCKED')
          feel('locked');
        if (
          e.type === 'bet.state' &&
          e.payload.pending_tx?.rpc_processed_at &&
          !before?.pending_tx?.rpc_processed_at &&
          ['CONCEDED', 'FINALIZED', 'APPEAL_RESOLVED'].includes(e.payload.state) &&
          wonBet(after)
        )
          feel('payout');
        if (e.type === 'bet.state' && (e.payload.state === 'PAID' || e.payload.state === 'VOIDED'))
          refreshBalance();
      }
      rerender();
    });
    return () => {
      clearInterval(gap);
      off();
    };
  }, [rt, refreshBalance]);

  // ---- judge cam: follow A's active bets (the cam is a second device of A) --------------
  useEffect(() => {
    if (!app.judgeCam || app.auth !== 'signedIn') return;
    const poll = async () => {
      let items: { bet_id?: string }[];
      try {
        const r = (await rt.client.request('GET', '/v1/me/bets?status=active&limit=5')) as {
          items?: { bet_id?: string }[];
        };
        items = r.items ?? [];
      } catch {
        return; // route not served yet / offline: keep polling
      }
      for (const it of items) {
        if (!it.bet_id) continue;
        // One bet this device cannot open (404, a transient error) must not hide the rest.
        try {
          if (!rt.hub.has(it.bet_id)) rt.hub.adopt(await rt.api.getBet(it.bet_id));
        } catch {
          continue;
        }
        rt.ws.subscribe(it.bet_id);
        const cur = appRef.current.activeBetId;
        if (!cur || isOver(rt.hub.get(cur)?.state ?? null))
          dispatch({ type: 'bet_opened', bet_id: it.bet_id });
      }
    };
    void poll();
    const tm = setInterval(() => void poll(), JUDGE_CAM_POLL_MS);
    return () => clearInterval(tm);
  }, [rt, app.judgeCam, app.auth]);

  const bet: BetModel | null = app.activeBetId ? (rt.hub.get(app.activeBetId) ?? null) : null;
  const route = selectRoute(app, bet);
  // An alert belongs to the screen it was raised on: a new screen starts without one (it used
  // to follow into the next screens as a toast that never cleared).
  useEffect(() => setAlert(null), [route]);
  // A link's demo-claim token dies with the Demo account screen (./deepLink demoLinkLives).
  useEffect(() => {
    if (!demoLinkLives(route)) setDemoLink(null);
  }, [route]);
  const me: Party | null =
    bet?.my_party ??
    (bet && app.me
      ? bet.party_a?.user_id === app.me.user_id
        ? 'A'
        : bet.party_b
          ? 'B'
          : null
      : null);

  const view: BetView | null = useMemo(
    () => (bet?.envelope && me ? betView(bet.envelope.terms, bet.envelope.terms_hash, me) : null),
    [bet?.envelope?.terms_hash, me],
  );
  /** Who performs: the non-performer's phone has Start and may film (../attempt/recorder). */
  const performer: Party | null = bet?.envelope?.terms.performer ?? bet?.attempt?.performer ?? null;
  const canStart = startsAttempt(me, performer);

  // ---- typed terms (A only): reset per bet; the form is the default without voice ------------
  const negotiating = route === 'negotiate' && me === 'A' && !app.judgeCam;
  const opponentName = bet?.party_b?.display_name ?? '';
  // No judge to talk to: voice off, this phone never got the bet's voice variables (a restart
  // mid-bet), or the session failed.
  const typedForced =
    !VOICE_ENABLED ||
    (bet !== null && (voiceFailedBet === bet.bet_id || !voiceVars.current.has(bet.bet_id)));
  useEffect(() => {
    if (!negotiating || !bet) return;
    typedDispatch({ type: 'init', bet_id: bet.bet_id, bName: opponentName, typed: typedForced });
  }, [negotiating, bet?.bet_id, opponentName, typedForced]);

  // ---- Bet on Bitcoin (A only, Beat 6): reset per bet; poll Gemini's odds while it is open ----
  useEffect(() => {
    if (!negotiating || !bet || !MARKET_ENABLED) return;
    marketDispatch({ type: 'init', bet_id: bet.bet_id });
  }, [negotiating, bet?.bet_id]);
  const polling = negotiating && market.bet_id === bet?.bet_id && shouldPoll(market);
  useEffect(() => {
    if (!polling) return;
    const pick = { side: market.side, stakeUsd: market.stakeUsd };
    let live = true;
    const ask = () =>
      void fetchMarketQuote({ api: rt.api }, pick).then(
        (quote) => live && marketDispatch({ type: 'quoted', ...pick, quote }),
      );
    ask();
    const tm = setInterval(ask, QUOTE_POLL_MS);
    return () => {
      live = false;
      clearInterval(tm);
    };
  }, [rt, polling, market.side, market.stakeUsd]);

  const submitMarket = async () => {
    if (!bet || !canSubmitMarket(market) || market.bet_id !== bet.bet_id) return;
    marketDispatch({ type: 'submit' });
    const outcome = await submitMarketTerms(
      { api: rt.api },
      { betId: bet.bet_id, side: market.side, stakeUsd: market.stakeUsd },
    );
    marketDispatch({ type: 'submitted', outcome });
    if (outcome.kind !== 'proposed') feel('failed');
  };

  const confirmMarket = async () => {
    const hash = bet?.envelope?.terms_hash ?? null;
    if (!bet || !hash || !canConfirmMarket(market, hash, bet.inviteAnswer)) return;
    marketDispatch({ type: 'confirm' });
    const keyName = `confirm:${bet.bet_id}:${hash}`;
    const r = await confirmMarketTerms(
      { api: rt.api },
      { betId: bet.bet_id, termsHash: hash, idempotencyKey: keyFor(keyName) },
    );
    if (r.kind === 'confirmed') marketDispatch({ type: 'confirmed' });
    else {
      keys.current.delete(keyName);
      if (r.kind === 'requoted')
        marketDispatch({ type: 'requoted', terms_hash: r.terms_hash, note: r.note });
      else if (r.kind === 'round_over') marketDispatch({ type: 'round_over', note: r.note });
      else marketDispatch({ type: 'confirm_failed', note: r.note });
      feel('failed');
    }
  };

  const voiceFailed = useCallback(
    (id: string) => {
      // Unmounts JudgeVoice (the session is already ended) and opens the typed form, unless
      // the bet is already over (a failure in the closing tail has nothing left to type).
      setVoiceFailedBet(id);
      setJudgeSpeaking(false);
      if (!isOver(rt.hub.get(id)?.state ?? null)) typedDispatch({ type: 'open' });
    },
    [rt],
  );

  const submitTyped = async () => {
    if (!bet || !canSubmit(typed) || typed.bet_id !== bet.bet_id) return;
    typedDispatch({ type: 'submit' });
    const outcome = await submitTypedTerms(
      { api: rt.api },
      { betId: bet.bet_id, claim: typed.claim, stakeUsd: typed.stakeUsd, bName: opponentName },
    );
    typedDispatch({ type: 'submitted', outcome });
    if (outcome.kind !== 'proposed') feel('failed');
  };

  const confirmTyped = async () => {
    const hash = bet?.envelope?.terms_hash ?? null;
    // Gated on B's accept too: an early tap would get a 409 replayed for this key for 24h.
    if (!bet || !hash || !canConfirm(typed, hash, bet.inviteAnswer)) return;
    typedDispatch({ type: 'confirm' });
    const keyName = `confirm:${bet.bet_id}:${hash}`;
    const r = await confirmTypedTerms(
      { api: rt.api },
      { betId: bet.bet_id, termsHash: hash, idempotencyKey: keyFor(keyName) },
    );
    if (r.ok) typedDispatch({ type: 'confirmed' });
    else {
      // A 4xx is replayed for its key: the next tap is a new request with a new key.
      if (r.freshKey) keys.current.delete(keyName);
      typedDispatch({ type: 'confirm_failed', note: r.note });
      feel('failed');
    }
  };

  // ---- the lock card: fetch the request if we missed the push; run the policy at mount -----
  const req = bet?.authorizeRequest ?? null;
  const betId = bet?.bet_id ?? null;
  const state = bet?.state ?? null;
  /** GET /lock into the hub, unless the push already brought it (`live` guards an unmount). */
  const fetchLock = useCallback(
    (id: string, live: () => boolean = () => true) => {
      rt.api.getLock(id).then(
        (r) => {
          if (!live()) return;
          rt.hub.patch(id, (m) =>
            m.authorizeRequest
              ? m
              : {
                  ...m,
                  authorizeRequest: r,
                  envelope: m.envelope ?? r.envelope,
                  termsMismatch:
                    m.envelope !== null && m.envelope.terms_hash !== r.envelope.terms_hash,
                },
          );
        },
        () => undefined,
      );
    },
    [rt],
  );
  useEffect(() => {
    if (!betId || state !== 'AWAITING_AUTHORIZATIONS' || req) return;
    let live = true;
    const tm = setTimeout(() => fetchLock(betId, () => live), 600);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [fetchLock, betId, state, req]);

  /**
   * The judge's show_terms_card client tool (§4.4, after confirm_terms): the card arrives anyway
   * with terms.authorize_request; this brings it forward now. Back from the typed form to the
   * draft card, and fetch the lock request if the push has not landed yet.
   */
  const showTermsCard = useCallback(
    (id: string) => {
      typedDispatch({ type: 'voice' });
      const b = rt.hub.get(id);
      if (b?.state === 'AWAITING_AUTHORIZATIONS' && !b.authorizeRequest) fetchLock(id);
    },
    [rt, fetchLock],
  );

  const lockId = req?.lock_request_id ?? null;
  const mismatch = bet?.termsMismatch ?? false;
  useEffect(() => {
    if (!req || !me) return;
    lockDispatch({ type: 'reset' });
    setAlert(null);
    const b = rt.hub.get(req.bet_id);
    if (b?.authorized[otherParty(me)]) lockDispatch({ type: 'their_signature' });
    // A restart after this phone's hold (resume): the snapshot has our signature, so the card
    // is "signed", not "Hold to lock" again. After the policy, so a refusal still wins.
    const mine = b?.authorized[me] === true;
    if (!walletKey) {
      if (mine) lockDispatch({ type: 'already_signed' });
      return;
    }
    // Refuse when the lock's terms aren't the terms this phone was shown (recomputed hashes).
    const ok = !mismatch && checkLockPolicy(req, walletKey, Date.now()).ok;
    lockDispatch({ type: 'policy', ok });
    if (!ok) feel('failed');
    if (mine) lockDispatch({ type: 'already_signed' });
    if (b?.state === 'AWAITING_LOCK') lockDispatch({ type: 'submitted' });
  }, [rt, lockId, walletKey, mismatch, me]);

  // Custodial path / cold start: already LOCKED -> the card shows Locked, then moves on. A Gemini
  // bet is locked straight into AWAITING_MARKET (one commit), so that counts as locked too.
  const lockedNow = state === 'LOCKED' || state === 'AWAITING_MARKET';
  useEffect(() => {
    if (lockedNow) lockDispatch({ type: 'confirmed' });
    if (lockedNow && betId) {
      const tm = setTimeout(() => dispatch({ type: 'lock_ack', bet_id: betId }), 1800);
      return () => clearTimeout(tm);
    }
    return undefined;
  }, [lockedNow, betId]);

  // At RULED the GG card needs appeal_deadline (BetSnapshot.deadlines) if chain.BetResolved
  // hasn't arrived yet; also pick up a concede SignRequest we may have missed.
  const needDeadline = state === 'RULED' && bet?.appeal_deadline === null;
  useEffect(() => {
    if (!needDeadline || !betId) return;
    let live = true;
    rt.api.getBet(betId).then(
      (s) => live && void rt.hub.adopt(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rt, needDeadline, betId]);

  const loadHistory = useCallback(() => {
    setHistory((h) => ({ status: 'loading', items: h.items }));
    rt.api.myBets('settled', HISTORY_LIMIT).then(
      (r) => setHistory({ status: 'ready', items: historyFrom(r.items) }),
      () => setHistory((h) => ({ status: 'failed', items: h.items })),
    );
  }, [rt]);
  const historyOpen = app.overlay === 'history';
  useEffect(() => {
    if (historyOpen) loadHistory();
  }, [historyOpen, loadHistory]);

  useEffect(() => {
    if (!homeNote) return;
    const tm = setTimeout(() => setHomeNote(null), HOME_NOTE_MS);
    return () => clearTimeout(tm);
  }, [homeNote]);

  // ---- actions -----------------------------------------------------------------------------
  /** A new challenge (list or face): A hosts the judge, follows the bet, and opens it. */
  const openNewBet = (r: CreateBetResponse) => {
    voiceVars.current.set(r.bet.bet_id, r.voice.dynamic_variables);
    rt.hub.adopt(r.bet);
    rt.ws.subscribe(r.bet.bet_id);
    dispatch({ type: 'bet_opened', bet_id: r.bet.bet_id, force: true });
  };

  const challengeFromList = (u: PreviewUser) => {
    const room = appRef.current.room;
    // One challenge in flight: a double tap must not open two bets.
    if (!room || challenging.current) return;
    challenging.current = true;
    setHomeNote(null);
    rt.api
      .createBet(room.room_id, u.user_id)
      .then(openNewBet, (e: unknown) => {
        feel('failed');
        setHomeNote(homeErrorLabel('challenge', e));
      })
      .finally(() => {
        challenging.current = false;
      });
  };

  /** "Challenge Jake?" after a face match: POST /v1/bets 'face' with the 60 s ticket. */
  const challengeByFace = async (m: ScanMatch): Promise<ChallengeResult> => {
    const room = appRef.current.room;
    if (!room) return 'not_in_room';
    if (!ticketFresh(m, rt.clock.now())) return 'expired';
    try {
      openNewBet(await rt.api.createFaceBet(room.room_id, m.user.user_id, m.ticket));
      return 'ok';
    } catch (e) {
      return challengeErrorResult(e);
    }
  };

  const leaveEnroll = () =>
    dispatch({
      type: 'overlay',
      overlay: enrollFrom.current === 'signup' ? 'none' : 'faceSettings',
    });

  /** The backstop for a face screen that throws while rendering: turn face off, go home (the
   *  room list), and say so briefly. */
  const faceCrashed = (where: 'scan' | 'enroll') => (message: string) => {
    console.warn(`[yo] face ${where}`, message);
    setFaceBroken(true);
    const line = t(COPY.scan.unavailable);
    setAlert(line);
    setTimeout(() => setAlert((cur) => (cur === line ? null : cur)), 4_000);
    dispatch({ type: 'overlay', overlay: 'none' });
  };

  /** Judge-cam mode on this phone AND on the server (./judgeCam: the server picks the recorder). */
  const setJudgeCam = useCallback(
    (on: boolean) => {
      dispatch({ type: 'overlay', overlay: 'none' });
      const req = deviceRoleRequest(on, appRef.current.room?.room_id ?? null);
      if (!req.ok) {
        setHomeNote(t(COPY.home.joinRoomFirst));
        return;
      }
      dispatch({ type: 'judge_cam', on });
      const sent = req.role === 'judge_cam' ? camSync.on(req.roomId) : camSync.off();
      void sent.then((r) => {
        if (r.status !== 'failed') return;
        console.warn('[yo] device role', r.error);
        // A failed turn-on goes back off here (camSync then sends 'phone'). A failed turn-off
        // stays off on screen: camSync keeps 'phone' pending and re-sends it when the socket is
        // live again, or at the next sign-in.
        if (on) dispatch({ type: 'judge_cam', on: false });
        setHomeNote(homeErrorLabel('judgeCam', r.error));
      });
    },
    [camSync],
  );

  /**
   * Bind the judge cam to the room this phone is in now, on the server too (a restart, or a room
   * link while judging). No room, or a refusal: judge cam off here as well, and home says why.
   */
  const bindJudgeCam = useCallback(
    async (roomId: string | null) => {
      if (!roomId) {
        // The last room is gone or unreachable: the operator joins one and turns it on again.
        dispatch({ type: 'judge_cam', on: false });
        void camSync.off();
        setHomeNote(t(COPY.home.joinRoomFirst));
        return;
      }
      const r = await camSync.on(roomId);
      if (r.status !== 'failed') return; // 'superseded': a newer on/off, or another user
      console.warn('[yo] device role', r.error);
      dispatch({ type: 'judge_cam', on: false }); // camSync sends 'phone' after a failed turn-on
      setHomeNote(homeErrorLabel('judgeCam', r.error));
    },
    [camSync],
  );

  async function joinRoom(code: string): Promise<boolean> {
    try {
      const prev = appRef.current.room;
      const r = await rt.api.joinRoom(code);
      // Switching rooms (a room link): leave the old one so presence there is right.
      if (prev && prev.room_id !== r.room.room_id)
        void rt.api.leaveRoom(prev.room_id).catch(() => undefined);
      dispatch({
        type: 'room',
        room: { room_id: r.room.room_id, code: r.room.code, name: r.room.name ?? r.room.code },
        members: r.members,
      });
      rt.ws.subscribeRoom(r.room.room_id);
      // A judge cam that moved rooms (a room link) judges the new one.
      if (prev && prev.room_id !== r.room.room_id && appRef.current.judgeCam)
        void bindJudgeCam(r.room.room_id);
      void import('expo-secure-store')
        .then((S) => S.setItemAsync(LAST_ROOM_KEY, r.room.code))
        .catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  const holdComplete = async () => {
    if (!req) return;
    feel('holdComplete');
    lockDispatch({ type: 'hold_complete' });
    try {
      const { result } = await authorizeLock(
        { wallet: rt.wallet, api: rt.api, now: Date.now },
        req,
        `Lock in ${view?.myStakeUsd ?? ''}`.trim(),
        keyFor(`lock:${req.lock_request_id}`),
      );
      lockDispatch({ type: 'auth_result', ok: true });
      feel('authorized');
      if (result.status === 'submitted') lockDispatch({ type: 'submitted' });
    } catch (e) {
      // The card says which (lock reducer): refused, Face ID failed, or try again.
      lockDispatch({ type: 'auth_result', ok: false, failure: authFailureOf(e) });
      feel('failed');
      if (e instanceof ApiClientError && e.code === 'STALE_LOCK_REQUEST')
        rt.hub.patch(req.bet_id, (m) => ({ ...m, authorizeRequest: null }));
    }
  };

  const declineLock = async () => {
    if (!bet || !me) return;
    lockDispatch({ type: 'end', reason: 'declined' });
    await rt.api
      .declineLock({
        bet_id: bet.bet_id,
        party: me,
        lock_request_id: req?.lock_request_id ?? null,
        declined_at: new Date(rt.clock.now()).toISOString(),
      })
      .catch(() => undefined);
  };

  /**
   * POST /attempts for `b` from this phone (party `as`): the judge cam if the room has one, else
   * this phone films (two phones; never the performer's, ../attempt/recorder).
   */
  const startAttemptFor = useCallback(
    (b: BetModel, attemptNo: number, as: Party | null): Promise<Recorder> =>
      startAttemptVia(
        (recorder) => rt.api.startAttempt(b.bet_id, attemptNo, recorder),
        as,
        b.envelope?.terms.performer ?? b.attempt?.performer ?? null,
      ).then((s) => s.recorder),
    [rt],
  );

  const startAttempt = async () => {
    if (!bet) return;
    setBusy(true);
    try {
      await startAttemptFor(bet, nextAttemptNo(bet), me);
    } catch (e) {
      // Quiet on the benign races; 'No judge cam' when the room has none on the server.
      const note = attemptStartAlert(e);
      if (note) setAlert(note);
    } finally {
      setBusy(false);
    }
  };

  const gg = async () => {
    if (!bet) return;
    setBusy(true);
    setAlert(null);
    try {
      await concede(
        { wallet: rt.wallet, api: rt.api },
        bet,
        `Pay ${view?.theirName ?? ''}`.trim(),
        keyFor(`concede:${bet.bet_id}`),
      );
    } catch (e) {
      feel('failed');
      if (e instanceof WalletError && e.code === 'POLICY_REJECTED') setAlert(t(COPY.terms.refused));
      else if (e instanceof WalletError) setAlert(t(COPY.terms.faceIdFailed));
      else setAlert(t(COPY.app.failed));
    } finally {
      setBusy(false);
    }
  };

  /** Built uploads by Idempotency-Key: the judge cam's retry resends the exact same body. */
  const preparedUploads = useRef(new Map<string, PreparedAttempt>());
  const sendClip = useCallback(
    async (clip: Clip | null) => {
      const b = appRef.current.activeBetId ? rt.hub.get(appRef.current.activeBetId) : undefined;
      if (!clip || !b?.attempt) throw new Error('no clip');
      await sendAttempt(
        {
          api: rt.api,
          readClip,
          extractFrames: (uri, ms) => extractFrames(uri, ms),
          iso: (ms) => new Date(ms + rt.clock.offsetMs).toISOString(),
        },
        {
          bet_id: b.bet_id,
          attempt_no: b.attempt.attempt_no,
          recorded_by: b.my_party ?? 'A',
          clip,
          idempotencyKey: keyFor(`frames:${b.bet_id}:${b.attempt.attempt_no}`),
        },
        preparedUploads.current,
      );
    },
    [rt, keyFor],
  );

  const arm: CamArm | null =
    bet?.attempt &&
    app.deviceId &&
    bet.attempt.recorder_device_id === app.deviceId &&
    bet.state === 'ATTEMPT'
      ? {
          attemptNo: bet.attempt.attempt_no,
          goAtMs: Date.parse(bet.attempt.go_at) - rt.clock.offsetMs,
          maxMs: bet.attempt.max_ms,
        }
      : null;

  const dismiss = () => {
    setAlert(null);
    dispatch({ type: 'bet_dismissed' });
    refreshBalance();
  };

  // ---- the judge session (A's phone only, D6) ------------------------------------------------
  // It lives for the whole bet and VOICE_TAIL_MS past its end, so the last [EVENT] line (PAID,
  // VOIDED, DECLINED, EXPIRED, LOCK_FAILED, which arrive with or after the terminal state) is
  // still spoken after the screen moves on. Gone at once when it failed (the controller already
  // ended it; unmounting also drops the error boundary's box) or when this phone stops hosting.
  const hostsVoice =
    VOICE_ENABLED &&
    !app.judgeCam &&
    bet !== null &&
    me === 'A' &&
    !isOver(bet.state) &&
    voiceFailedBet !== bet.bet_id &&
    voiceVars.current.has(bet.bet_id);
  const [voiceBetId, setVoiceBetId] = useState<string | null>(null);
  useEffect(() => {
    if (hostsVoice && bet) setVoiceBetId(bet.bet_id);
  }, [hostsVoice, bet?.bet_id]);
  useEffect(() => {
    if (app.judgeCam || app.auth !== 'signedIn') setVoiceBetId(null);
  }, [app.judgeCam, app.auth]);
  const voiceBet = voiceBetId ? (rt.hub.get(voiceBetId) ?? null) : null;
  const voiceBetOver = voiceBet ? isOver(voiceBet.state) : false;
  useEffect(() => {
    if (!voiceBetId || !voiceBetOver) return;
    const tm = setTimeout(
      () => setVoiceBetId((cur) => (cur === voiceBetId ? null : cur)),
      VOICE_TAIL_MS,
    );
    return () => clearTimeout(tm);
  }, [voiceBetId, voiceBetOver]);
  const voice =
    voiceBet && voiceFailedBet !== voiceBet.bet_id
      ? (voiceVars.current.get(voiceBet.bet_id) ?? null)
      : null;
  const voiceLive =
    voice !== null && voiceBet?.bet_id === bet?.bet_id && voicePhase === 'connected';

  // ---- render ------------------------------------------------------------------------------
  if (bootFailed && app.auth === 'booting') return <Loading failed onRetry={boot} />;

  const result =
    bet?.ruling && me
      ? bet.state === 'VOIDED'
        ? 'void'
        : myResult(bet.ruling.ruling.outcome, me)
      : 'void';
  const balanceCents = balance ? Number(BigInt(balance.usdc) / 10_000n) : 0;
  const waiting = <Loading failed={false} onRetry={() => undefined} />;

  const screen = (() => {
    switch (route) {
      case 'boot':
        return waiting;
      case 'signup':
        return (
          <SignupScreen
            api={signupApi}
            onSignedUp={() => {
              // The session listener moves on to home; enrollment is offered first (skippable).
              if (!faceOn) return;
              enrollFrom.current = 'signup';
              dispatch({ type: 'overlay', overlay: 'enroll' });
            }}
            onDemo={() => dispatch({ type: 'overlay', overlay: 'demoClaim' })}
            onTitleLongPress={onOperator}
          />
        );
      case 'demoClaim':
        return (
          <DemoClaimScreen
            linkCode={demoLink}
            onBack={() => {
              setDemoLink(null);
              dispatch({ type: 'overlay', overlay: 'none' });
            }}
            claim={async (qr) => {
              try {
                const token = qr.trim().replace(/^youreon:\/\/[a-z-]+\//i, '');
                const s = await rt.sessions.demoClaim(token);
                return s.user.display_name;
              } catch {
                return null;
              }
            }}
            onDone={() => {
              setDemoLink(null);
              dispatch({ type: 'overlay', overlay: 'none' });
            }}
          />
        );
      case 'home':
        return (
          <HomeScreen
            name={app.me?.display_name ?? ''}
            balanceCents={balanceCents}
            pending={false}
            inBetsUsd={balance && balance.in_escrow !== '0' ? balance.in_escrow_display : null}
            room={app.room ? { code: app.room.code, name: app.room.name } : null}
            members={app.members
              .filter((m) => m.user.user_id !== app.me?.user_id)
              .map(toPreviewUser)}
            offline={app.offline}
            note={homeNote}
            creating={creatingRoom}
            onJoin={joinRoom}
            onCreate={() => {
              if (creatingRoom) return;
              setCreatingRoom(true);
              setHomeNote(null);
              rt.api
                .createRoom()
                .then(
                  async (r) => {
                    if (!(await joinRoom(r.code))) setHomeNote(t(COPY.home.createFailed));
                  },
                  (e: unknown) => setHomeNote(homeErrorLabel('create', e)),
                )
                .finally(() => setCreatingRoom(false));
            }}
            onLeave={() => {
              const id = app.room?.room_id;
              dispatch({ type: 'room', room: null });
              rt.ws.subscribeRoom(null);
              void import('expo-secure-store')
                .then((S) => S.deleteItemAsync(LAST_ROOM_KEY))
                .catch(() => undefined);
              if (id) void rt.api.leaveRoom(id).catch(() => undefined);
            }}
            onScan={
              faceOn && app.room ? () => dispatch({ type: 'overlay', overlay: 'scan' }) : undefined
            }
            onChallenge={challengeFromList}
            onHistory={() => dispatch({ type: 'overlay', overlay: 'history' })}
            onProfile={() => dispatch({ type: 'overlay', overlay: 'profile' })}
            onTitleLongPress={onOperator}
          />
        );
      case 'profile':
        return (
          <ProfileScreen
            name={app.me?.display_name ?? ''}
            faceOn={faceStatus === 'active'}
            onBack={() => dispatch({ type: 'overlay', overlay: 'none' })}
            onFace={() => {
              if (FACE_ENABLED) dispatch({ type: 'overlay', overlay: 'faceSettings' });
            }}
            onHistory={() => dispatch({ type: 'overlay', overlay: 'history' })}
            onJudgeCam={() => setJudgeCam(!app.judgeCam)}
            onDemo={() => dispatch({ type: 'overlay', overlay: 'demoClaim' })}
          />
        );
      case 'scan': {
        const room = app.room;
        if (!room || !embedder) return waiting;
        return (
          <PanelErrorBoundary name="Face scan" onError={faceCrashed('scan')}>
            <ScanScreen
              onBack={() => dispatch({ type: 'overlay', overlay: 'none' })}
              scan={(url) =>
                runScan(
                  {
                    embedder,
                    faceMatch: (req) => rt.api.faceMatch(room.room_id, req),
                    now: () => rt.clock.now(),
                  },
                  url,
                )
              }
              onChallenge={challengeByFace}
              members={app.members
                .filter((m) => m.user.user_id !== app.me?.user_id && m.online)
                .map(toPreviewUser)}
              onPickMember={challengeFromList}
              onPickList={() => dispatch({ type: 'overlay', overlay: 'none' })}
              onOpen={() => void embedder.prewarm?.().catch(() => undefined)}
            />
          </PanelErrorBoundary>
        );
      }
      case 'faceSettings':
        return (
          <FaceSettings
            api={faceApi}
            onBack={() => {
              refreshFace();
              dispatch({ type: 'overlay', overlay: 'profile' });
            }}
            onSetUp={() => {
              if (!faceOn) return;
              enrollFrom.current = 'settings';
              dispatch({ type: 'overlay', overlay: 'enroll' });
            }}
          />
        );
      case 'enroll':
        return embedder ? (
          <PanelErrorBoundary name="Face enrollment" onError={faceCrashed('enroll')}>
            <FaceEnrollFlow
              api={faceApi}
              embedder={embedder}
              now={() => rt.clock.now()}
              onDone={() => {
                refreshFace();
                leaveEnroll();
              }}
              onSkip={leaveEnroll}
              onExit={leaveEnroll}
            />
          </PanelErrorBoundary>
        ) : (
          waiting
        );
      case 'history':
        return (
          <HistoryScreen
            items={history.items}
            status={history.status}
            onRetry={loadHistory}
            onBack={() => dispatch({ type: 'overlay', overlay: 'none' })}
          />
        );
      case 'incoming':
        return (
          <IncomingScreen
            challenger={bet?.challenger?.display_name ?? bet?.party_a?.display_name ?? ''}
            roomName={app.room?.name ?? t(COPY.home.room)}
            onAccept={() => {
              if (!bet) return;
              rt.hub.patch(bet.bet_id, (m) => ({ ...m, inviteAnswer: 'accepted' }));
              rt.api.acceptInvite(bet.bet_id).then(
                (r) => rt.hub.adopt(r.bet),
                () => undefined,
              );
            }}
            onDecline={() => {
              if (!bet) return;
              rt.hub.patch(bet.bet_id, (m) => ({ ...m, inviteAnswer: 'declined' }));
              rt.api.declineInvite(bet.bet_id).then(
                (r) => rt.hub.adopt(r.bet),
                () => dismiss(),
              );
            }}
          />
        );
      case 'negotiate': {
        const names = {
          me: me ?? 'A',
          myName: app.me?.display_name ?? '',
          theirName:
            (me === 'A'
              ? bet?.party_b?.display_name
              : (bet?.party_a?.display_name ?? bet?.challenger?.display_name)) ?? '',
        } as const;
        const captions: Caption[] = (bet?.lines ?? []).map((l) => ({ who: l.who, text: l.text }));
        return (
          <NegotiateScreen
            view={names}
            captions={captions}
            speaking={voiceLive ? judgeSpeaking : captions.at(-1)?.who === 'judge'}
            hasMic={me === 'A' && VOICE_ENABLED && !typedForced}
            micMuted={!voiceLive || micMutedFor(state)}
            voice={VOICE_ENABLED}
            draft={view}
            typed={
              negotiating && typed.bet_id === bet?.bet_id
                ? {
                    mode: typed.mode,
                    canVoice: !typedForced,
                    claim: typed.claim,
                    stakeUsd: typed.stakeUsd,
                    stakes: TYPED_STAKES_USD,
                    sending: typed.phase === 'sending',
                    confirming: typed.phase === 'confirming' || typed.phase === 'confirmed',
                    canSubmit: canSubmit(typed),
                    canConfirm: canConfirm(
                      typed,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                    ),
                    waitingFor: waitingForAccept(
                      typed,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                    )
                      ? names.theirName
                      : null,
                    note: typed.note,
                    onOpen: () => typedDispatch({ type: 'open' }),
                    onVoice: () => typedDispatch({ type: 'voice' }),
                    onClaim: (text) => typedDispatch({ type: 'claim', text }),
                    onStake: (usd) => typedDispatch({ type: 'stake', usd: usd as TypedStakeUsd }),
                    onSubmit: () => void submitTyped(),
                    onConfirm: () => void confirmTyped(),
                  }
                : undefined
            }
            market={
              negotiating && MARKET_ENABLED && market.bet_id === bet?.bet_id
                ? {
                    open: market.phase !== 'closed',
                    side: market.side,
                    stakeUsd: market.stakeUsd,
                    stakes: MARKET_STAKES_USD,
                    quote: market.quote
                      ? {
                          ok: market.quote.ok,
                          refusal: market.quote.refusal,
                          upPct: market.quote.upPct,
                          strikeUsd: market.quote.strikeUsd,
                          priceUsd: market.quote.priceUsd,
                          split: splitLabel(market.quote),
                          lockableUntilMs:
                            market.quote.lockableUntilMs === null
                              ? null
                              : market.quote.lockableUntilMs - rt.clock.offsetMs,
                          replay: isReplayTicker(market.quote.eventTicker ?? ''),
                          nextWindowMs:
                            market.quote.nextWindowMs === null
                              ? null
                              : market.quote.nextWindowMs - rt.clock.offsetMs,
                        }
                      : null,
                    sending: market.phase === 'sending',
                    confirming: market.phase === 'confirming' || market.phase === 'confirmed',
                    canSubmit: canSubmitMarket(market),
                    canConfirm: canConfirmMarket(
                      market,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                    ),
                    waitingFor: waitingForAcceptMarket(
                      market,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                    )
                      ? names.theirName
                      : null,
                    note: market.note,
                    onOpen: () => marketDispatch({ type: 'open' }),
                    onClose: () => marketDispatch({ type: 'close' }),
                    onSide: (side) => marketDispatch({ type: 'side', side }),
                    onStake: (usd) => marketDispatch({ type: 'stake', usd: usd as MarketStakeUsd }),
                    onSubmit: () => void submitMarket(),
                    onConfirm: () => void confirmMarket(),
                  }
                : undefined
            }
            onDecline={() => {
              if (bet && me === 'B') void rt.api.declineInvite(bet.bet_id).catch(() => undefined);
              dismiss();
            }}
          />
        );
      }
      case 'terms':
        return view && req ? (
          <TermsCardScreen
            view={view}
            lock={lock}
            expiresAtMs={Date.parse(req.expires_at) - rt.clock.offsetMs}
            onHoldStart={() => feel('holdStart')}
            onHoldComplete={() => void holdComplete()}
            onDecline={() => void declineLock()}
            onContinue={() => bet && dispatch({ type: 'lock_ack', bet_id: bet.bet_id })}
          />
        ) : view && lockedNow ? (
          <TermsCardScreen
            view={view}
            lock={lock}
            expiresAtMs={Date.now()}
            onHoldComplete={() => undefined}
            onDecline={() => undefined}
            onContinue={() => bet && dispatch({ type: 'lock_ack', bet_id: bet.bet_id })}
          />
        ) : (
          waiting
        );
      case 'lockEnded':
        return (
          <LockEndedScreen
            reason={bet ? endReasonOf(bet) : 'declined'}
            onHome={dismiss}
            onReview={dismiss}
          />
        );
      case 'live': {
        const phase: LivePhase =
          state === 'LOCKED' ? 'locked' : state === 'ATTEMPT' ? 'filming' : 'judging';
        return view ? (
          <LiveScreen
            view={view}
            phase={phase}
            attemptNo={bet?.attempt?.attempt_no ?? 1}
            onStart={canStart ? () => void startAttempt() : undefined}
            startBusy={busy}
          />
        ) : (
          waiting
        );
      }
      case 'market': {
        const m = bet?.envelope?.terms.market;
        if (!view || !bet || !m) return waiting;
        // My side: A holds the Terms side, B the other one.
        const aUp = m.side === 'YES';
        const mineUp = me === 'A' ? aUp : !aUp;
        const tick = bet.market?.eventTicker === m.eventTicker ? bet.market : null;
        return (
          <MarketScreen
            view={view}
            priceUsd={tick?.indexPrice ? formatPrice(tick.indexPrice) : '—'}
            strikeUsd={m.strike.value ? formatPrice(m.strike.value) : '—'}
            side={t(mineUp ? COPY.market.up : COPY.market.down)}
            expiryMs={Date.parse(m.expiry) - rt.clock.offsetMs}
            replay={isReplayTicker(m.eventTicker)}
          />
        );
      }
      case 'judgeCam':
        // This phone films: as the room's judge cam, or (two phones) as the non-performer's own
        // phone for this attempt only, which has no judge-cam mode to leave.
        return (
          <JudgeCamScreen
            arm={arm}
            onSend={sendClip}
            onBack={app.judgeCam ? () => setJudgeCam(false) : undefined}
          />
        );
      case 'redo':
        return (
          <RedoScreen
            attemptNo={nextAttemptNo(bet ?? { lastAttemptNo: null })}
            maxAttempts={3}
            tip={FILMING_TIP}
            onReady={() => {
              if (canStart) void startAttempt();
            }}
          />
        );
      case 'ruling': {
        if (!view || !bet) return waiting;
        const deadline =
          bet.appeal_deadline !== null
            ? bet.appeal_deadline * 1000 - rt.clock.offsetMs
            : Date.parse(bet.ruling?.ruling.created_at ?? new Date().toISOString()) +
              10_000 -
              rt.clock.offsetMs;
        return (
          <RulingScreen
            view={view}
            result={result}
            judgeLabel={view.kind === 'market' ? t(COPY.market.gemini) : undefined}
            reason={safeData(bet.ruling?.ruling.reason, FALLBACK_REASON)}
            appealDeadlineMs={deadline}
            busy={busy}
            alert={alert}
            onGG={() => void gg()}
          />
        );
      }
      case 'payout': {
        if (!view || !bet) return waiting;
        const phase: PayoutPhase = state === 'PAID' ? 'confirmed' : 'processed';
        return (
          <PayoutScreen
            view={view}
            won={result === 'won'}
            balanceCents={balanceCents}
            phase={phase}
            onRetry={refreshBalance}
            onHome={dismiss}
          />
        );
      }
    }
  })();

  return (
    <View style={styles.root}>
      {screen}
      {voice && voiceBet ? (
        <PanelErrorBoundary
          key={voiceBet.bet_id}
          name="voice"
          onError={(m) => {
            console.warn('[yo] voice', m);
            voiceFailed(voiceBet.bet_id);
          }}
        >
          <Suspense fallback={null}>
            <JudgeVoice
              rt={rt}
              betId={voiceBet.bet_id}
              dynamicVariables={voice}
              startAttempt={(n) => startAttemptFor(voiceBet, n, 'A')}
              micMuted={micMutedFor(voiceBet.state)}
              onShowTermsCard={() => showTermsCard(voiceBet.bet_id)}
              onPhase={setVoicePhase}
              onSpeaking={setJudgeSpeaking}
              onFailed={(reason) => {
                console.warn('[yo] voice failed', reason);
                voiceFailed(voiceBet.bet_id);
              }}
            />
          </Suspense>
        </PanelErrorBoundary>
      ) : null}
      {alert && route !== 'ruling' && route !== 'terms' ? (
        <View style={styles.toast} pointerEvents="none">
          <Label variant="small">{alert}</Label>
        </View>
      ) : null}
      <StatusBar style="light" />
    </View>
  );
}

/** Why holdComplete failed, for the lock card (bets/lock AuthFailure). */
function authFailureOf(e: unknown): AuthFailure {
  if (e instanceof WalletError) {
    if (e.code === 'POLICY_REJECTED') return 'policy';
    if (e.code === 'AUTH_CANCELLED' || e.code === 'AUTH_FAILED') return 'auth';
  }
  return 'send';
}

/** lockSignals minus 'reset' (the card effect resets on every new lock_request_id itself). */
function lockSignalsSafe(...args: Parameters<typeof lockSignals>) {
  return lockSignals(...args).filter((s) => s.type !== 'reset');
}

function wonBet(b: BetModel): boolean {
  if (!b.ruling || !b.my_party) return false;
  return myResult(b.ruling.ruling.outcome, b.my_party) === 'won';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 40,
    alignItems: 'center',
    padding: 8,
    borderRadius: 8,
    backgroundColor: palette.background,
  },
});
