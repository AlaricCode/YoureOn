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
//   -> live / judge cam (record, frames, upload) -> ruling (GG = concede, Face ID; the loser's
//      "I appeal!" = appeal, tap + Face ID, until 1 s before the window ends) / REDO
//   -> appeal: the three-model panel voting live, then its result (Beat 5; until "Continue")
//   -> payout with GET /v1/me/balance (the panel's final outcome when there was an appeal).
// Beat 6 (the closer): on A's negotiate screen "Bet on Bitcoin" (app/marketTerms) shows Gemini's
// live odds and the fair split, proposes at the binding quote, then the same terms card and lock;
// a locked Gemini bet shows the market clock (live price by market.tick) until Gemini settles.
// Dance Off (docs/planning/DANCE-OFF.md): "Dance off" on A's negotiate screen (app/danceTerms),
// the same card and lock, then the round on the recording phone (../dance DanceOffScreen: the
// judge cam, else A's phone) and "Dance off live" on the other (app/danceFlow); the usual ruling,
// GG and payout. Double or nothing (app/rematch) on every finished bet starts a new challenge.
// "Jarvis" (../wake, ./wakeGate; EXPO_PUBLIC_WAKE): one recognizer, listening on Home (in a room)
// and on A's negotiate screen until the judge starts. On Home "Jarvis, …" starts a challenge (the
// person named, the face scan, or the one person online); on the negotiate screen A's judge waits
// for "Jarvis" or "Tap to talk" and hears the sentence first. The rainbow loop (../wake RainbowLoop)
// runs from the wake through the sentence and while the judge connects. Without the module in the
// binary (or with the flag off) the judge starts on the negotiate screen as before.
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
import { AccessibilityInfo, Linking, StyleSheet, View } from 'react-native';

import type {
  BetSnapshot,
  CreateBetResponse,
  RoomMember,
  VoiceDynamicVariables,
} from '@youre-on/shared/api';
import { isReplayTicker } from '@youre-on/shared/judge/market-terms';
import { agreedFor } from '@youre-on/shared/odds';
import { otherParty, type Party } from '@youre-on/shared/primitives';
import { formatPrice } from '@youre-on/shared/settlement';

import { extractFrames, readClip } from '../attempt/capture';
import { startAttemptVia, startsAttempt, type Recorder } from '../attempt/recorder';
import { initialLock, lockReducer, type AuthFailure } from '../bets/lock';
import { emptyBet, endReasonOf, finalOutcome, lockSignals, type BetModel } from '../bets/store';
import { appealSeats, appealVerdict, betView, myResult, type BetView } from '../bets/view';
import { feel } from '../device/feedback';
import { PanelErrorBoundary } from '../diagnostics/PanelErrorBoundary';
import { createServerFaceApi, type FaceStatus } from '../enroll/api';
import { createLazyEmbedder } from '../enroll/embedder';
import { FaceEnrollFlow, FaceSettings } from '../enroll/EnrollScreens';
import { GgPayoutScreen, RulingReview } from '../gg/GgScreens';
import { reviewable } from '../gg/model';
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
  AppealScreen,
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
import { SplashView } from '../ui/brand';
import { Label, PrimaryButton } from '../ui/kit';
import { setConnectionStatus } from '../ui/connection';
import { isCopyOk } from '../ui/copyRule';
import { Page, Screen, StatusHero } from '../ui/parts';
import { half, palette, radius, space } from '../ui/tokens';
import { micMutedFor, type SessionPhase } from '../voice/session';
import { STATUS_COPY, WAKE_COPY, wt } from '../wake/copy';
import { RainbowLoop } from '../wake/RainbowLoop';
import { useWakeWord } from '../wake/useWakeWord';
import { WalletError } from '../wallet/wallet';
import type { DanceUploadBundle } from '../dance/index';
import {
  ActionError,
  appeal,
  authorizeLock,
  checkLockPolicy,
  concede,
  sendAttempt,
  type PreparedAttempt,
} from './actions';
import {
  danceStartNote,
  danceWatchPhase,
  isDanceBet,
  sendDanceUpload,
  startDanceAttemptVia,
  type PreparedDance,
} from './danceFlow';
import {
  canConfirmDance,
  canSubmitDance,
  DANCE_ROUTINE_CHOICES,
  DANCE_STAKES_USD,
  danceCardOf,
  danceClaimPreview,
  danceOpen,
  danceReducer,
  initialDance,
  stakeChips,
  submitDanceTerms,
  waitingForAcceptDance,
} from './danceTerms';
import { canRematch, chipAtMost, startRematch, withRematch } from './rematch';
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
  marketCardOf,
  marketReducer,
  QUOTE_POLL_MS,
  shouldPoll,
  splitLabel,
  submitMarketTerms,
  waitingForAcceptMarket,
  type MarketStakeUsd,
} from './marketTerms';
import { balanceSeries, HISTORY_LIMIT, historyFrom, netCents } from './history';
import { HOME_NOTE_MS, homeErrorLabel } from './homeErrors';
import { demoLinkLives, parseDeepLink } from './deepLink';
import {
  attemptStartAlert,
  createJudgeCamSync,
  deviceRoleRequest,
  rejoinAndRebind,
} from './judgeCam';
import { createLiveRetry, RESUME_LIMIT, resumable, type LiveRetry } from './resume';
import { createSocketStatusHandler } from './socketStatus';
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
  typedCardOf,
  typedReducer,
  typedStakeFor,
  typedStakes,
  waitingForAccept,
} from './typedTerms';
import { oddsApply, oddsSettled } from './odds';
import {
  CONNECTED_GRACE_MS,
  HEARD_REARM_MS,
  heldUtterance,
  homeWakeAction,
  JUDGE_RELEASE_MS,
  judgeAutoStarts,
  judgeWaitsForWake,
  loopReducer,
  THINKING_MAX_MS,
  wakeListening,
  type HeldUtterance,
  type LoopState,
} from './wakeGate';
import { useOddsPanel, useTypedOdds } from '../odds/useOdds';

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
/**
 * The face natives load on first use, never at app start (see createLazyEmbedder), and through
 * importSafely: a face native that throws while it loads (ML Kit is not in the simulator build)
 * rejects here instead of aborting the app (opening "Scan a face" used to kill it).
 */
const loadFaceEmbedder = () =>
  importSafely(() => import('../face/native')).then((m) => m.getNativeEmbedder());
/** EXPO_PUBLIC_DANCE=off hides "Dance off" on the negotiate screen (a dance bet still plays). */
const DANCE_ENABLED = process.env.EXPO_PUBLIC_DANCE !== 'off';
/**
 * EXPO_PUBLIC_WAKE=off turns "Jarvis" off (./wakeGate): A's judge then starts on the negotiate
 * screen by itself, as before. It needs the voice judge (EXPO_PUBLIC_VOICE) to have anyone to hear.
 */
const WAKE_ENABLED = VOICE_ENABLED && process.env.EXPO_PUBLIC_WAKE !== 'off';
/**
 * The Dance Off screens (../dance) pull the pose camera's native view: loaded on first use and
 * through importSafely, like the voice SDK, so a build without it never fails at launch.
 */
const loadDance = () => importSafely(() => import('../dance/index'));
const DanceOffScreen = lazy(() => loadDance().then((m) => ({ default: m.DanceOffScreen })));
const DanceWatchScreen = lazy(() => loadDance().then((m) => ({ default: m.DanceWatchScreen })));
const DanceResultBreakdown = lazy(() =>
  loadDance().then((m) => ({ default: m.DanceResultBreakdown })),
);
const JUDGE_CAM_POLL_MS = 3_000;
const FILMING_TIP = 'Keep the whole table in the shot, and stop a beat after it lands.';
const FALLBACK_REASON = 'The judge ruled on the clip.';
const DANCE_FALLBACK_REASON = 'The scores are in.';
/** What the dance screen's Start and upload get back (its retry line says `message`). */
type DanceAnswer = { ok: true } | { ok: false; message: string };

export default function DemoApp({ onOperator }: { onOperator: () => void }) {
  const [rt, setRt] = useState<Runtime | null>(null);
  const [failed, setFailed] = useState(false);
  const start = useCallback(() => {
    setFailed(false);
    getRuntime().then(setRt, () => setFailed(true));
  }, []);
  useEffect(start, [start]);
  // The native splash hands off to the same mark (ui/brand SplashView): no jump at launch.
  if (!rt) return <SplashView failed={failed} onRetry={start} />;
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
  const [dance, danceDispatch] = useReducer(danceReducer, initialDance);
  /** Double or nothing (./rematch) in flight from this phone. */
  const [rematchBusy, setRematchBusy] = useState(false);
  /** The bet whose voice session failed (no key, token refused, SDK error): type it instead. */
  const [voiceFailedBet, setVoiceFailedBet] = useState<string | null>(null);
  /** The judge session's phase and whether the judge is talking (NegotiateScreen's mic/ring). */
  const [voicePhase, setVoicePhase] = useState<SessionPhase>('idle');
  const [judgeSpeaking, setJudgeSpeaking] = useState(false);
  /** ../gg: the bet whose ruling the judge has finished saying (the RULED mic gate). */
  const [rulingSpokenBet, setRulingSpokenBet] = useState<string | null>(null);
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
  // ---- "Jarvis" state (./wakeGate; the hook and the gating are below the judge session) ----
  /** The bet whose judge was asked for: a wake, "Tap to talk", or a sentence held from Home. */
  const [judgeArmedBet, setJudgeArmedBet] = useState<string | null>(null);
  /** The bet whose JudgeVoice is mounted: it stays until the bet's session ends as before. */
  const [judgeMountedBet, setJudgeMountedBet] = useState<string | null>(null);
  /** What was said after "Jarvis", per bet: the judge's first user message (JudgeVoice). */
  const wakeUtterances = useRef(new Map<string, string>());
  /** Said on Home: waits for the challenge it started (openNewBet). */
  const heldWake = useRef<HeldUtterance | null>(null);
  /** The rainbow loop. */
  const [loop, loopDispatch] = useReducer(loopReducer, 'off' as LoopState);

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

  /** Sign-in steps waiting for the socket to be live again (./resume createLiveRetry). */
  const liveRetries = useRef<readonly LiveRetry[]>([]);

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
    // A step the server could not answer here (offline at a cold start) runs again once the
    // socket is live (./resume createLiveRetry): it used to wait for the next restart, with the
    // phone on home, room-less, and its open bet stranded.
    const roomRetry = createLiveRetry(async () => {
      if (appRef.current.room) return true;
      const S = await import('expo-secure-store');
      const code = await S.getItemAsync(LAST_ROOM_KEY);
      return !code || !live || (await joinRoomId(code)) !== null;
    });
    // Re-join the last room (a convenience; the server's room_members row is the truth). A
    // restored judge cam then re-binds itself to that room on the server, which may hold another
    // room or none (a demo claim resets the device to 'phone'). ./judgeCam rejoinAndRebind: the
    // room comes from the join, not from appRef (a render behind right after it).
    void cam
      .then((restored) =>
        rejoinAndRebind({
          restored,
          linked,
          storedCode: async () => {
            const S = await import('expo-secure-store');
            return S.getItemAsync(LAST_ROOM_KEY);
          },
          currentRoomId: () => appRef.current.room?.room_id ?? null,
          join: joinRoomId,
          live: () => live,
          stillOn: () => camSync.restoredOn,
          bind: (roomId) => void bindJudgeCam(roomId),
        }),
      )
      .then((joined) => {
        if (!joined) roomRetry.markPending();
      });
    // Back into any bet that is still open (./resume): a restart mid-bet used to strand it.
    const betsRetry = createLiveRetry(async () => {
      let open: BetSnapshot[];
      try {
        open = resumable((await rt.api.myBets('active', RESUME_LIMIT)).items);
      } catch {
        return false; // offline: again once the socket is live
      }
      for (const snap of open) {
        if (!live) return true;
        if (!rt.hub.has(snap.bet_id)) await rt.hub.restore(snap);
        rt.ws.subscribe(snap.bet_id);
      }
      await cam; // judge cam or not decides the screen this bet opens on
      const newest = open[0];
      if (live && newest) dispatch({ type: 'bet_opened', bet_id: newest.bet_id });
      return true;
    });
    void betsRetry.run();
    liveRetries.current = [roomRetry, betsRetry];
    return () => {
      live = false;
      roomRetry.stop();
      betsRetry.stop();
      liveRetries.current = [];
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
    // Home's offline flag, the reconnect banner on every screen (./socketStatus), and a turn-off
    // the server never confirmed (./judgeCam) sent again once the socket answers.
    const a = rt.onStatus(
      createSocketStatusHandler({
        offline: (offline) => dispatch({ type: 'offline', offline }),
        live: () => {
          void camSync.retry();
          for (const r of liveRetries.current) r.onLive();
        },
      }),
    );
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
      // Not following the socket any more (the operator screen, a restart of this tree): no
      // stale "Reconnecting" on the next screen.
      setConnectionStatus('idle');
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
  /** Double or nothing (./rematch): every stake picker starts on the suggested stake. */
  const rematchStake = bet?.rematchOf ? bet.suggestedStakeUsd : null;
  useEffect(() => {
    if (!negotiating || !bet) return;
    // After a restart mid-bet the card is already on screen: start the form on it (./typedTerms).
    typedDispatch({
      type: 'init',
      bet_id: bet.bet_id,
      bName: opponentName,
      typed: typedForced,
      shown: typedCardOf(bet.envelope),
      stakeUsd: rematchStake,
    });
  }, [negotiating, bet?.bet_id, opponentName, typedForced, rematchStake]);
  // ---- odds (both phones): offers, counters, the judge's suggestion (../odds/useOdds) --------
  const oddsTheirName =
    (me === 'A' ? bet?.party_b?.display_name : bet?.party_a?.display_name) ?? '';
  const oddsPanel = useOddsPanel({ api: rt.api, bet, me, theirName: oddsTheirName });
  const typedOdds = useTypedOdds({
    api: rt.api,
    bet,
    typed,
    dispatch: typedDispatch,
    theirName: opponentName,
    enabled: negotiating && typed.mode === 'typed',
  });
  const oddsOk = bet?.envelope ? oddsSettled(bet.odds, bet.envelope.terms) : true;
  // Agreed odds that differed from A's typed card recompose it (new hash): the form adopts it.
  useEffect(() => {
    if (!negotiating || !bet?.envelope) return;
    const terms = bet.envelope.terms;
    const agreed = oddsApply(terms) && !bet.odds.open && agreedFor(bet.odds, terms.stakes);
    const shown = agreed ? typedCardOf(bet.envelope) : null;
    if (shown) typedDispatch({ type: 'odds_agreed', shown });
  }, [negotiating, bet?.envelope?.terms_hash, bet?.odds.agreed.length]);

  // ---- Bet on Bitcoin (A only, Beat 6): reset per bet; poll Gemini's odds while it is open ----
  useEffect(() => {
    if (!negotiating || !bet || !MARKET_ENABLED) return;
    marketDispatch({
      type: 'init',
      bet_id: bet.bet_id,
      shown: marketCardOf(bet.envelope),
      stakeUsd: chipAtMost(MARKET_STAKES_USD, rematchStake),
    });
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

  // ---- Dance off (A only, ./danceTerms): reset per bet; a card already shown reopens on it ------
  useEffect(() => {
    if (!negotiating || !bet || !DANCE_ENABLED) return;
    danceDispatch({
      type: 'init',
      bet_id: bet.bet_id,
      shown: danceCardOf(bet.envelope),
      stakeUsd: rematchStake,
    });
  }, [negotiating, bet?.bet_id]);

  const submitDance = async () => {
    if (!bet || !canSubmitDance(dance) || dance.bet_id !== bet.bet_id) return;
    danceDispatch({ type: 'submit' });
    const outcome = await submitDanceTerms(
      { api: rt.api },
      { betId: bet.bet_id, routineId: dance.routineId, stakeUsd: dance.stakeUsd },
    );
    danceDispatch({ type: 'submitted', outcome });
    if (outcome.kind !== 'proposed') feel('failed');
  };

  const confirmDance = async () => {
    const hash = bet?.envelope?.terms_hash ?? null;
    if (!bet || !hash || !canConfirmDance(dance, hash, bet.inviteAnswer)) return;
    danceDispatch({ type: 'confirm' });
    const keyName = `confirm:${bet.bet_id}:${hash}`;
    // The same confirm as the typed form (POST …/terms/confirm with the card's hash).
    const r = await confirmTypedTerms(
      { api: rt.api },
      { betId: bet.bet_id, termsHash: hash, idempotencyKey: keyFor(keyName) },
    );
    if (r.ok) danceDispatch({ type: 'confirmed' });
    else {
      if (r.freshKey) keys.current.delete(keyName);
      danceDispatch({ type: 'confirm_failed', note: r.note });
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
    const picked = typedStakes(typed);
    const outcome = await submitTypedTerms(
      { api: rt.api },
      {
        betId: bet.bet_id,
        claim: typed.claim,
        stakeUsd: typed.stakeUsd,
        bName: opponentName,
        stakes: picked.ok ? picked.stakes : undefined,
      },
    );
    typedDispatch({ type: 'submitted', outcome });
    if (outcome.kind !== 'proposed') feel('failed');
  };

  const confirmTyped = async () => {
    const hash = bet?.envelope?.terms_hash ?? null;
    // Gated on B's accept too: an early tap would get a 409 replayed for this key for 24h.
    if (!bet || !hash || !canConfirm(typed, hash, bet.inviteAnswer, oddsOk)) return;
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
  /**
   * Start A's judge for this bet (a wake, "Tap to talk", or a sentence held from Home): it mounts
   * with `text` as its first user message ('' = none) while the loop thinks.
   */
  const armJudge = (betId: string, text: string) => {
    wakeUtterances.current.set(betId, text);
    // A fresh session's phase: a stale 'stopped' from the last bet must not end the loop.
    setVoicePhase('idle');
    setJudgeSpeaking(false);
    setJudgeArmedBet(betId);
    loopDispatch({ type: 'tap' });
  };

  /** A new challenge (list or face): A hosts the judge, follows the bet, and opens it. */
  const openNewBet = (r: CreateBetResponse) => {
    voiceVars.current.set(r.bet.bet_id, r.voice.dynamic_variables);
    // "Jarvis, …" on Home started this challenge: the judge hears it as the screen opens.
    const held = heldUtterance(heldWake.current, Date.now());
    heldWake.current = null;
    if (held !== null && WAKE_ENABLED) armJudge(r.bet.bet_id, held);
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
    return (await joinRoomId(code)) !== null;
  }

  /** Join by code; the room id, or null when it failed. */
  async function joinRoomId(code: string): Promise<string | null> {
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
      return r.room.room_id;
    } catch {
      return null;
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

  /** "I appeal!" (Beat 5): tap + Face ID, the device policy on the 'appeal' screen, POST. */
  const appealNow = async () => {
    if (!bet) return;
    setBusy(true);
    setAlert(null);
    try {
      await appeal(
        { wallet: rt.wallet, api: rt.api },
        bet,
        t(COPY.ruling.appealPrompt),
        keyFor(`appeal:${bet.bet_id}`),
      );
    } catch (e) {
      feel('failed');
      if (e instanceof WalletError && e.code === 'POLICY_REJECTED') setAlert(t(COPY.terms.refused));
      else if (e instanceof WalletError) setAlert(t(COPY.terms.faceIdFailed));
      else if (e instanceof ApiClientError && e.code === 'APPEAL_WINDOW_CLOSED')
        setAlert(t(COPY.ruling.tooLate));
      else setAlert(t(COPY.app.failed));
    } finally {
      setBusy(false);
    }
  };

  /**
   * ../gg review sheet "Check it again": the same appeal as "I appeal!" (same Idempotency-Key),
   * but it throws, so the sheet can show why and stay up while the window runs.
   */
  const checkAgain = async () => {
    if (!bet) throw new Error('no bet');
    await appeal(
      { wallet: rt.wallet, api: rt.api },
      bet,
      t(COPY.ruling.appealPrompt),
      keyFor(`appeal:${bet.bet_id}`),
    );
  };

  /** Built uploads by Idempotency-Key: the judge cam's retry resends the exact same body. */
  const preparedUploads = useRef(new Map<string, PreparedAttempt>());
  const sendClip = useCallback(
    async (clip: Clip | null) => {
      const b = appRef.current.activeBetId ? rt.hub.get(appRef.current.activeBetId) : undefined;
      if (!clip || !b?.attempt) throw new Error('no clip');
      const frameKey = `frames:${b.bet_id}:${b.attempt.attempt_no}`;
      await sendAttempt(
        {
          api: rt.api,
          readClip,
          extractFrames: (uri, ms) => extractFrames(uri, ms),
          iso: (ms) => new Date(ms + rt.clock.offsetMs).toISOString(),
          // a server older than D10 refuses the landing crop: the 12 frames go under this key
          noCropKey: () => keyFor(`${frameKey}:nocrop`),
        },
        {
          bet_id: b.bet_id,
          attempt_no: b.attempt.attempt_no,
          recorded_by: b.my_party ?? 'A',
          clip,
          idempotencyKey: keyFor(frameKey),
        },
        preparedUploads.current,
      );
    },
    [rt, keyFor],
  );

  // ---- Dance Off round (./danceFlow): the recording phone's Start and upload ----------------
  /**
   * DanceOffScreen's Start (after its framing check): POST /attempts asking for the judge cam,
   * then (A's phone, none in the room) this phone. The count-in follows attempt.started.
   */
  const startDance = useCallback(async (): Promise<DanceAnswer> => {
    const a = appRef.current;
    const b = a.activeBetId ? rt.hub.get(a.activeBetId) : undefined;
    if (!b) return { ok: false, message: t(COPY.app.failed) };
    try {
      const { result: started } = await startDanceAttemptVia(
        (recorder) => rt.api.startAttempt(b.bet_id, nextAttemptNo(b), recorder),
        a.judgeCam,
        b.my_party,
      );
      // The answer already names the recorder and go_at: the count-in need not wait for the
      // attempt.started push (which brings the same facts).
      rt.hub.patch(b.bet_id, (m) =>
        m.attempt?.attempt_no === started.attempt_no
          ? m
          : {
              ...m,
              attempt: {
                attempt_no: started.attempt_no,
                performer: started.performer,
                max_ms: started.max_ms,
                recorder_device_id: started.recorder_device_id,
                go_at: started.go_at,
              },
              lastAttemptNo: started.attempt_no,
            },
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, message: danceStartNote(e) };
    }
  }, [rt]);

  /** Built dance uploads by Idempotency-Key: a retry resends the exact same body. */
  const preparedDances = useRef(new Map<string, PreparedDance>());
  /**
   * Bets whose dance screen this app session has shown. After a restart in JUDGING or RULED the
   * round (and its upload) is gone with the old screen: a fresh DanceOffScreen would start back
   * at framing, so that phone shows the watch screen (judging, then the score) instead.
   */
  const danceShown = useRef(new Set<string>());
  const uploadDance = useCallback(
    async (bundle: DanceUploadBundle, attemptNo: number): Promise<DanceAnswer> => {
      const id = appRef.current.activeBetId;
      if (!id) return { ok: false, message: t(COPY.app.failed) };
      const keyName = `dance:${id}:${attemptNo}`;
      const r = await sendDanceUpload(
        { api: rt.api },
        { betId: id, attemptNo, bundle, idempotencyKey: keyFor(keyName) },
        preparedDances.current,
      );
      if (r.ok) return { ok: true };
      // A 4xx is replayed for its key: the next try is a new request with a new key.
      if (r.freshKey) keys.current.delete(keyName);
      feel('failed');
      return { ok: false, message: r.message };
    },
    [rt, keyFor],
  );

  // ---- Double or nothing (./rematch): any finished bet, either party --------------------------
  const rematch = async () => {
    if (!bet || rematchBusy || !canRematch(bet.state)) return;
    const from = bet.bet_id;
    setRematchBusy(true);
    setAlert(null);
    const keyName = `rematch:${from}`;
    const r = await startRematch({ api: rt.api }, from, keyFor(keyName));
    setRematchBusy(false);
    if (!r.ok) {
      if (r.freshKey) keys.current.delete(keyName);
      setAlert(r.note);
      feel('failed');
      return;
    }
    // The new bet, as a new challenge from this phone (A): the negotiate screen, typed (no
    // voice variables for it), every stake picker on the suggested stake.
    if (r.snapshot) rt.hub.adopt(r.snapshot);
    rt.hub.patch(r.betId, (m) => withRematch(m, from, r.suggestedStakeUsd));
    rt.ws.subscribe(r.betId);
    dispatch({ type: 'bet_opened', bet_id: r.betId, force: true });
    refreshBalance();
  };
  /** The button shows once the bet is over (the server refuses a rematch before). */
  const onRematch =
    bet && !app.judgeCam && canRematch(bet.state) ? () => void rematch() : undefined;

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

  // ---- "Jarvis" (../wake, ./wakeGate) -----------------------------------------------------------
  // The judge is started for a bet: armed (a wake, a tap, a held sentence), already mounted, or
  // the bet moved past the negotiation (typed terms, Bet on Bitcoin, Dance off: it hosts the lock,
  // the attempt and the ruling as before).
  const judgeStartedFor = (b: BetModel) =>
    judgeArmedBet === b.bet_id ||
    judgeMountedBet === b.bet_id ||
    judgeAutoStarts({ waits: true, state: b.state, over: isOver(b.state) });
  // As the wake gate sees it (a missing module makes the judge start anyway, and then nothing
  // listens, so this view is enough to keep the mic off while a session holds it).
  const judgeUp =
    voice !== null && voiceBet !== null && (!WAKE_ENABLED || judgeStartedFor(voiceBet));
  // The audio session settles before the recognizer takes it again (LiveKit tears down async).
  const [judgeReleased, setJudgeReleased] = useState(true);
  useEffect(() => {
    if (judgeUp) {
      setJudgeReleased(false);
      return;
    }
    const tm = setTimeout(() => setJudgeReleased(true), JUDGE_RELEASE_MS);
    return () => clearTimeout(tm);
  }, [judgeUp]);
  // A's voice view (not the typed form, Bet on Bitcoin or Dance off), its judge not started yet.
  const voiceView =
    !(typed.bet_id === bet?.bet_id && typed.mode === 'typed') &&
    !(market.bet_id === bet?.bet_id && market.phase !== 'closed') &&
    !(dance.bet_id === bet?.bet_id && danceOpen(dance));
  const judgePendingBet =
    negotiating && voiceView && bet && voice !== null && voiceBet?.bet_id === bet.bet_id
      ? judgeStartedFor(bet)
        ? null
        : bet.bet_id
      : null;
  const routeRef = useRef(route);
  routeRef.current = route;
  const pendingRef = useRef(judgePendingBet);
  pendingRef.current = judgePendingBet;

  const wake = useWakeWord({
    enabled: wakeListening({
      flag: WAKE_ENABLED,
      signedIn: app.auth === 'signedIn',
      judgeCam: app.judgeCam,
      route,
      inRoom: app.room !== null,
      judgePending: judgePendingBet !== null,
      judgeBusy: judgeUp || !judgeReleased,
    }),
    onWake: () => {
      loopDispatch({ type: 'wake' });
      feel('wakeHeard');
      AccessibilityInfo.announceForAccessibility(wt(WAKE_COPY.listening));
    },
    onUtterance: (text) => {
      // The mic is already released here.
      const pending = pendingRef.current;
      if (routeRef.current === 'negotiate' && pending) {
        armJudge(pending, text);
        return;
      }
      loopDispatch({ type: 'utterance', toJudge: false });
      if (routeRef.current !== 'home') return;
      const a = appRef.current;
      const opponents = a.members
        .filter((m) => m.user.user_id !== a.me?.user_id)
        .map(toPreviewUser);
      const action = homeWakeAction({
        text,
        inRoom: a.room !== null,
        canScan: faceOn && a.room !== null,
        opponents,
      });
      // Kept for the challenge's negotiate screen (openNewBet), '' included: the judge starts
      // there without waiting for another "Jarvis".
      heldWake.current = action.kind === 'none' ? null : { text, atMs: Date.now() };
      if (action.kind === 'challenge') {
        const u = opponents.find((o) => o.user_id === action.userId);
        if (u) challengeFromList(u);
      } else if (action.kind === 'scan') {
        dispatch({ type: 'overlay', overlay: 'scan' });
      } else if (action.kind === 'pick') {
        setHomeNote(wt(WAKE_COPY.pickOpponent));
      }
    },
    onCancel: () => loopDispatch({ type: 'cancel' }),
    onError: (message) => console.warn('[yo] wake', message),
  });
  // Missing from this binary (or the flag off): the judge starts by itself, as before.
  const judgeWaits = judgeWaitsForWake({
    flag: WAKE_ENABLED,
    available: wake.available,
    status: wake.status,
  });
  // The recognizer still holds the mic (its stop is async): the judge mounts once it let go.
  const wakeHoldsMic = wake.status === 'listening' || wake.status === 'capturing';
  const judgeOn =
    voice !== null &&
    voiceBet !== null &&
    (judgeMountedBet === voiceBet.bet_id ||
      !judgeWaits ||
      (judgeStartedFor(voiceBet) && !wakeHoldsMic));
  // Once mounted, a bet's judge stays (a status flip must never end a live session).
  useEffect(() => {
    if (judgeOn && voiceBet) setJudgeMountedBet(voiceBet.bet_id);
  }, [judgeOn, voiceBet?.bet_id]);
  /** On A's negotiate screen: the judge waits for "Jarvis" or "Tap to talk". */
  const judgeWaiting = judgePendingBet !== null && judgeWaits && !judgeOn;
  const wakeStatusLine = STATUS_COPY[wake.status];
  const wakeLine = wakeStatusLine ? wt(wakeStatusLine) : null;

  // Home: a sentence that stayed on Home ("pick one", a failed challenge) listens again shortly.
  const resumeWake = wake.resume;
  useEffect(() => {
    if (route !== 'home' || wake.status !== 'heard') return;
    const tm = setTimeout(resumeWake, HEARD_REARM_MS);
    return () => clearTimeout(tm);
  }, [route, wake.status, resumeWake]);
  // A sentence held from Home is for the challenge it started, not one picked later.
  const prevRoute = useRef(route);
  useEffect(() => {
    if (route === 'home' && prevRoute.current !== 'home') heldWake.current = null;
    prevRoute.current = route;
  }, [route]);

  // The rainbow loop: off when the judge talks or fails, on another screen, or past its deadlines.
  useEffect(() => {
    loopDispatch({ type: 'judge', phase: voicePhase, speaking: judgeSpeaking });
  }, [voicePhase, judgeSpeaking]);
  useEffect(() => {
    if (route !== 'home' && route !== 'negotiate') loopDispatch({ type: 'reset' });
  }, [route]);
  useEffect(() => {
    if (loop !== 'thinking') return;
    const ms = voicePhase === 'connected' ? CONNECTED_GRACE_MS : THINKING_MAX_MS;
    const tm = setTimeout(() => loopDispatch({ type: 'reset' }), ms);
    return () => clearTimeout(tm);
  }, [loop, voicePhase]);

  // ---- render ------------------------------------------------------------------------------
  if (bootFailed && app.auth === 'booting') return <SplashView failed onRetry={boot} />;

  // After an appeal the panel's outcome pays (and may differ from the ruling's).
  const outcome = bet ? finalOutcome(bet) : null;
  const result =
    outcome && me ? (bet?.state === 'VOIDED' ? 'void' : myResult(outcome, me)) : 'void';
  const balanceCents = balance ? Number(BigInt(balance.usdc) / 10_000n) : 0;
  // Home's sparkline and delta come from the settled history the app already holds (loaded when
  // History opens); no extra request. Hidden until there is history. No caption: the list is
  // capped at HISTORY_LIMIT, so "all time" would not be true.
  const homeSeries = balance ? balanceSeries(balanceCents, history.items) : null;
  const homeChange = balance && history.items.length ? { cents: netCents(history.items) } : null;
  const waiting = <Loading failed={false} onRetry={() => undefined} />;

  const screen = (() => {
    switch (route) {
      case 'boot':
        return <SplashView />;
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
            series={homeSeries}
            change={homeChange}
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
            rematch={bet?.rematchOf != null}
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
                    stakes: stakeChips(TYPED_STAKES_USD, typedStakeFor(rematchStake)),
                    sending: typed.phase === 'sending',
                    confirming: typed.phase === 'confirming' || typed.phase === 'confirmed',
                    canSubmit: canSubmit(typed),
                    canConfirm: canConfirm(
                      typed,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                      oddsOk,
                    ),
                    waitingFor: waitingForAccept(
                      typed,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                      oddsOk,
                    )
                      ? names.theirName
                      : null,
                    note: typed.note,
                    onOpen: () => typedDispatch({ type: 'open' }),
                    onVoice: () => typedDispatch({ type: 'voice' }),
                    onClaim: (text) => typedDispatch({ type: 'claim', text }),
                    onStake: (usd) => typedDispatch({ type: 'stake', usd }),
                    onSubmit: () => void submitTyped(),
                    onConfirm: () => void confirmTyped(),
                    odds: typedOdds,
                  }
                : undefined
            }
            odds={oddsPanel}
            wake={
              judgeWaiting && bet
                ? {
                    line: wakeLine,
                    onTapToTalk: () => armJudge(bet.bet_id, ''),
                    onOpenSettings:
                      wake.status === 'denied' ? () => void Linking.openSettings() : undefined,
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
            dance={
              negotiating && DANCE_ENABLED && dance.bet_id === bet?.bet_id
                ? {
                    open: danceOpen(dance),
                    routines: DANCE_ROUTINE_CHOICES,
                    routineId: dance.routineId,
                    stakeUsd: dance.stakeUsd,
                    stakes: stakeChips(DANCE_STAKES_USD, rematchStake),
                    preview: danceClaimPreview(dance.routineId, dance.stakeUsd),
                    sending: dance.phase === 'sending',
                    confirming: dance.phase === 'confirming' || dance.phase === 'confirmed',
                    canSubmit: canSubmitDance(dance),
                    canConfirm: canConfirmDance(
                      dance,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                    ),
                    waitingFor: waitingForAcceptDance(
                      dance,
                      bet?.envelope?.terms_hash ?? null,
                      bet?.inviteAnswer ?? null,
                    )
                      ? names.theirName
                      : null,
                    note: dance.note,
                    onOpen: () => danceDispatch({ type: 'open' }),
                    onClose: () => danceDispatch({ type: 'close' }),
                    onRoutine: (id) => danceDispatch({ type: 'routine', id }),
                    onStake: (usd) => danceDispatch({ type: 'stake', usd }),
                    onSubmit: () => void submitDance(),
                    onConfirm: () => void confirmDance(),
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
      case 'dance': {
        // The recording phone (./danceFlow recordsDance): framing, count-in, the round, the
        // local result, the upload, then the ruling (which moves the bet to RULED).
        const terms = bet?.envelope?.terms;
        if (!bet || !terms || !me) return waiting;
        const names = { a: terms.party_a.display_name, b: terms.party_b.display_name };
        if (state === 'LOCKED' || state === 'ATTEMPT') danceShown.current.add(bet.bet_id);
        if (!danceShown.current.has(bet.bet_id)) {
          return (
            <PanelErrorBoundary
              key={bet.bet_id}
              name={t(COPY.dance.panel)}
              onError={(m) => console.warn('[yo] dance watch', m)}
            >
              <Suspense fallback={waiting}>
                <DanceWatchScreen
                  terms={terms}
                  me={me}
                  names={names}
                  phase="judging"
                  scored={bet.danceScored}
                />
              </Suspense>
            </PanelErrorBoundary>
          );
        }
        const a = bet.attempt;
        return (
          <PanelErrorBoundary
            key={bet.bet_id}
            name={t(COPY.dance.panel)}
            onError={(m) => console.warn('[yo] dance', m)}
          >
            <Suspense fallback={waiting}>
              <DanceOffScreen
                betId={bet.bet_id}
                terms={terms}
                me={me}
                names={names}
                // go_at on this phone's clock (as the judge cam's arm), so the count-in lands
                // on the server's instant.
                attempt={
                  a
                    ? {
                        attempt_no: a.attempt_no,
                        go_at: new Date(Date.parse(a.go_at) - rt.clock.offsetMs).toISOString(),
                        max_ms: a.max_ms,
                      }
                    : null
                }
                ruling={
                  bet.ruling
                    ? {
                        outcome: bet.ruling.ruling.outcome,
                        reason: safeData(bet.ruling.ruling.reason, DANCE_FALLBACK_REASON),
                      }
                    : null
                }
                onStartAttempt={startDance}
                onUpload={uploadDance}
                onLeave={app.judgeCam ? () => setJudgeCam(false) : undefined}
              />
            </Suspense>
          </PanelErrorBoundary>
        );
      }
      case 'danceWatch': {
        // The other phone: "Dance off live" while the recording phone runs the round.
        const terms = bet?.envelope?.terms;
        if (!bet || !terms || !me) return waiting;
        return (
          <PanelErrorBoundary
            key={bet.bet_id}
            name={t(COPY.dance.panel)}
            onError={(m) => console.warn('[yo] dance watch', m)}
          >
            <Suspense fallback={waiting}>
              <DanceWatchScreen
                terms={terms}
                me={me}
                names={{ a: terms.party_a.display_name, b: terms.party_b.display_name }}
                phase={danceWatchPhase(state)}
                scored={bet.danceScored}
              />
            </Suspense>
          </PanelErrorBoundary>
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
        const isDance = view.kind === 'dance';
        // A dance off's ruling reason is the announcer's line (DANCE-OFF §5).
        const reason = safeData(
          bet.ruling?.ruling.reason,
          isDance ? DANCE_FALLBACK_REASON : FALLBACK_REASON,
        );
        const scored = isDance ? bet.danceScored : null;
        // VOID 'undecidable': the scores within the margin, or a player the camera missed. An
        // invalid round (someone left, a third person) stays "No contest".
        const tooClose =
          result === 'void' &&
          scored !== null &&
          scored.validation.verdict !== 'invalid' &&
          (scored.evidence.too_close || scored.evidence.failed !== null);
        const breakdown = scored ? (
          <PanelErrorBoundary name={t(COPY.dance.panel)} onError={() => undefined}>
            <Suspense fallback={null}>
              <DanceResultBreakdown scored={scored} names={partyNames(view)} />
            </Suspense>
          </PanelErrorBoundary>
        ) : null;
        // ../gg: a spoken "check that again" opens the loser's review sheet over the ruling.
        return (
          <RulingReview
            bet={bet}
            me={me}
            offsetMs={rt.clock.offsetMs}
            reason={reason}
            confirm={checkAgain}
            decline={() => rt.api.declineReview(bet.bet_id)}
          >
            {(tag) => (
              <RulingScreen
                view={view}
                result={result}
                judgeLabel={
                  view.kind === 'market'
                    ? t(COPY.market.gemini)
                    : isDance
                      ? t(COPY.dance.announcer)
                      : undefined
                }
                title={tooClose ? t(COPY.dance.tooClose) : undefined}
                note={isDance && result === 'void' ? t(COPY.dance.refund) : null}
                detail={breakdown}
                reason={reason}
                appealDeadlineMs={deadline}
                busy={busy}
                alert={alert}
                onGG={() => void gg()}
                // No appeal on a dance off: its score is deterministic (DANCE-OFF §5).
                onAppeal={result === 'lost' && !isDance ? () => void appealNow() : undefined}
                onRematch={onRematch}
                rematchBusy={rematchBusy}
                tag={tag}
              />
            )}
          </RulingReview>
        );
      }
      case 'appeal': {
        if (!bet) return waiting;
        const original = bet.appealResult?.original_outcome ?? bet.ruling?.ruling.outcome ?? null;
        return (
          <AppealScreen
            seats={appealSeats(bet.appealVotes, original).map((s) => ({
              ...s,
              reason: s.reason ? safeData(s.reason, '') || null : null,
            }))}
            result={appealVerdict(bet.appealResult)}
            onContinue={() => dispatch({ type: 'appeal_ack', bet_id: bet.bet_id })}
          />
        );
      }
      case 'payout': {
        if (!view || !bet) return waiting;
        const phase: PayoutPhase = state === 'PAID' ? 'confirmed' : 'processed';
        // ../gg: the loser said GG ("Jake said GG" / "Good game").
        if (bet.gg && me)
          return (
            <GgPayoutScreen
              view={view}
              gg={bet.gg}
              me={me}
              balanceCents={balanceCents}
              phase={phase === 'confirmed' ? 'confirmed' : 'processed'}
              onHome={dismiss}
              onRematch={onRematch}
              rematchBusy={rematchBusy}
              alert={alert}
            />
          );
        return (
          <PayoutScreen
            view={view}
            won={result === 'won'}
            balanceCents={balanceCents}
            phase={phase}
            onRetry={refreshBalance}
            onHome={dismiss}
            onRematch={onRematch}
            rematchBusy={rematchBusy}
            alert={alert}
          />
        );
      }
    }
  })();

  // One light status bar for the whole app: every screen, moments included, sits on black.
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {screen}
      {judgeOn && voice && voiceBet ? (
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
              initialUtterance={wakeUtterances.current.get(voiceBet.bet_id)}
              // A dance round starts on the dance screen, after its framing check (never by voice).
              startAttempt={(n) =>
                isDanceBet(voiceBet)
                  ? Promise.reject(new ActionError('INVALID_STATE'))
                  : startAttemptFor(voiceBet, n, 'A')
              }
              micMuted={micMutedFor(voiceBet.state, {
                reviewable: reviewable(voiceBet),
                rulingSpoken: rulingSpokenBet === voiceBet.bet_id,
              })}
              onRulingSpoken={(spoken) =>
                setRulingSpokenBet((cur) =>
                  spoken ? voiceBet.bet_id : cur === voiceBet.bet_id ? null : cur,
                )
              }
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
      {alert && route !== 'ruling' && route !== 'terms' && route !== 'payout' ? (
        <View style={styles.toast} pointerEvents="none">
          <Label variant="labelMedium">{alert}</Label>
        </View>
      ) : null}
      {/* Last, above every screen and toast: "Jarvis" heard, then the judge connecting. */}
      <RainbowLoop active={loop !== 'off'} mode={loop === 'listening' ? 'listening' : 'thinking'} />
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

/** A's and B's names as the dance screens take them (this phone's view is mine/theirs). */
const partyNames = (v: Pick<BetView, 'me' | 'myName' | 'theirName'>) =>
  v.me === 'A' ? { a: v.myName, b: v.theirName } : { a: v.theirName, b: v.myName };

/** This phone wins the payout: the panel's outcome after an appeal, else the ruling's. */
function wonBet(b: BetModel): boolean {
  const outcome = finalOutcome(b);
  if (!outcome || !b.my_party) return false;
  return myResult(outcome, b.my_party) === 'won';
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // A raised pill above the home indicator: #0F0F11 fill, no outline, white text.
  toast: {
    position: 'absolute',
    left: space.page,
    right: space.page,
    bottom: space.x5,
    alignItems: 'center',
    paddingVertical: half.x15,
    paddingHorizontal: space.x3,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
  },
});
