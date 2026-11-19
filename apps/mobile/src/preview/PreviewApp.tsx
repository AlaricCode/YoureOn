// The whole app on stand-in data, opened from the diagnostics screen until sign-in (D0-M4), the
// realtime client (D1-M4), rooms (D0-J4), the judge (D1-J1, D2-M3), the lock (D2-L2), rulings
// (D3-J1) and payouts (D3-L1) are served. It walks the demo beats in order and has a "Screens"
// menu that opens any screen directly. Timers stand in for the server's pushes. Nothing here moves
// money or talks to a server; Face ID is real on a phone that has it.
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
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DANCE_STAKES_USD } from '@youre-on/shared/judge/dance-terms';
import { MARKET_STAKES_USD, marketSideOf } from '@youre-on/shared/judge/market-terms';
import { formatUsd, parseUsd } from '@youre-on/shared/money';
import { splitPot } from '@youre-on/shared/gemini';

import {
  controlStakes,
  offerCardView,
  readout,
  type OddsControl,
  type OddsState,
} from '../app/odds';
import { DANCE_ROUTINE_CHOICES, danceClaimPreview, stakeChips } from '../app/danceTerms';
import { initialLock, lockReducer, type EndReason } from '../bets/lock';
import { betView, myResult } from '../bets/view';
import { importSafely } from '../app/importSafely';
import { firstName } from '../dance/copy';
import { authorizeOwner } from '../device/authorize';
import { feel } from '../device/feedback';
import { PanelErrorBoundary } from '../diagnostics/PanelErrorBoundary';
import { createPreviewFaceApi } from '../enroll/api';
import { createPreviewEmbedder } from '../enroll/embedder';
import { FaceEnrollFlow, FaceSettings } from '../enroll/EnrollScreens';
import { GgPayoutScreen, RulingReview } from '../gg/GgScreens';
import type { ReviewModel } from '../gg/model';
import { previewGg, previewReview, previewReviewBet } from '../gg/preview';
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
  HearingScreen,
  JudgeCamScreen,
  LiveScreen,
  MarketScreen,
  PayoutScreen,
  RedoScreen,
  RulingScreen,
  type CamArm,
  type LivePhase,
  type PayoutPhase,
  type TurnState,
  type VoteState,
} from '../screens/PlayScreens';
import { createPreviewSignupApi } from '../signup/api';
import { SignupScreen } from '../signup/SignupScreen';
import { SplashView } from '../ui/brand';
import { Label } from '../ui/kit';
import { ListRow, Screen, Section, TopBar } from '../ui/parts';
import { half, palette, radius, space } from '../ui/tokens';
import { STATUS_COPY, wt } from '../wake/copy';
import { RainbowLoop } from '../wake/RainbowLoop';
import {
  BALANCE,
  BALANCE_SERIES,
  MARKET_TRAIL,
  bottleFlip,
  btcCloser,
  danceOff,
  DANCE_REASON,
  FILMING_TIP,
  HEAD_TO_HEAD,
  HISTORY,
  MARKET_REASON,
  MEMBERS,
  NEGOTIATION_SCRIPT,
  ODDS_STAKES,
  PANEL,
  previewDanceScored,
  previewOdds,
  ROOM,
  RULING_REASON,
} from './data';

/**
 * The Dance Off screens (../dance) sit next to the pose camera's native view: loaded lazily and
 * through importSafely, so the preview never reaches the native module statically. The round
 * itself (DanceOffScreen) needs the camera: the preview shows the other phone and the result.
 */
const loadDance = () => importSafely(() => import('../dance/index'));
const DanceWatchScreen = lazy(() => loadDance().then((m) => ({ default: m.DanceWatchScreen })));
const DanceResultBreakdown = lazy(() =>
  loadDance().then((m) => ({ default: m.DanceResultBreakdown })),
);

type Route =
  | 'menu'
  | 'launch'
  | 'launchFailed'
  | 'signup'
  | 'enroll'
  | 'faceSettings'
  | 'home'
  | 'scan'
  | 'incoming'
  | 'negotiate'
  | 'odds'
  | 'marketPanel'
  | 'terms'
  | 'lockEnded'
  | 'live'
  | 'liveSelf'
  | 'selfCam'
  | 'judgeCam'
  | 'ruling'
  | 'redo'
  | 'payout'
  | 'hearing'
  | 'appeal'
  | 'market'
  | 'history'
  | 'profile'
  | 'demo'
  | 'ggPayout'
  | 'review'
  | 'danceTerms'
  | 'danceWatch'
  | 'danceRuling'
  | 'rematchInvite'
  | 'jarvis';

/**
 * The "Jarvis" preview (../wake, app/wakeGate): A's judge waiting for the wake word, the sentence
 * coming in, the judge connecting (the rainbow loop thinking), then talking; or the mic-off
 * fallback with "Tap to talk".
 */
type JarvisPhase = 'listening' | 'capturing' | 'thinking' | 'speaking' | 'denied';
const JARVIS_SAID = "I bet Jake can't do ten pushups";
const JARVIS_REPLY = 'Ten pushups, Jake. Full reps, chest to the floor. How much?';

const APPEAL_WINDOW_MS = 10_000;
const startCents = Number(BigInt(BALANCE.usdc) / 10_000n);

export default function PreviewApp({ onClose }: { onClose: () => void }) {
  const faceApi = useMemo(() => createPreviewFaceApi({ delayMs: 600 }), []);
  // The face natives load on first use: a static import made the whole preview fail to load
  // in a build without the ML Kit detector (the simulator's); now only the capture step does.
  const embedder = useMemo(
    () =>
      createPreviewEmbedder(undefined, (url) =>
        importSafely(() => import('../face/native')).then((m) => m.detectFacesInPhoto(url)),
      ),
    [],
  );
  const signupApi = useMemo(() => createPreviewSignupApi({ delayMs: 600 }), []);

  const [route, setRoute] = useState<Route>('menu');
  const [name, setName] = useState('Logan');
  const [faceOn, setFaceOn] = useState(false);
  const [inRoom, setInRoom] = useState(true);
  const [balance, setBalance] = useState(startCents);
  const [market, setMarket] = useState(false);
  /** Dance Off (DANCE-OFF §6): the bet is a dance off; the panel's pick; a too-close round. */
  const [danceBet, setDanceBet] = useState(false);
  const [dRoutine, setDRoutine] = useState('wave-pop');
  const [dStake, setDStake] = useState(5);
  const [jarvis, setJarvis] = useState<JarvisPhase>('listening');
  const [danceVoid, setDanceVoid] = useState(false);
  const [rematchBusy, setRematchBusy] = useState(false);
  // History: 'loading' with no rows is the first-load skeleton; a pull on a loaded list reloads
  // it (the refresh spinner over the rows, for a moment).
  const [historyStatus, setHistoryStatus] = useState<'loading' | 'ready'>('ready');
  const [historyFirstLoad, setHistoryFirstLoad] = useState(false);
  /** Odds: the card at $15 vs $5, the offer on screen, the counter sheet, agreed. */
  const [atOdds, setAtOdds] = useState(false);
  const [odds, setOdds] = useState<OddsState | null>(null);
  const [oddsCounter, setOddsCounter] = useState<OddsControl | null>(null);
  const [oddsAgreed, setOddsAgreed] = useState(false);
  // "Bet on Bitcoin" panel (Beat 6): A's call and stake, priced at the sample 62 % Up.
  const [mSide, setMSide] = useState<'UP' | 'DOWN'>('UP');
  const [mStake, setMStake] = useState<number>(2);
  const [me, setMe] = useState<'A' | 'B'>('A');
  const [lock, dispatch] = useReducer(lockReducer, initialLock);
  const [lockExpires, setLockExpires] = useState(0);
  const [endReason, setEndReason] = useState<EndReason>('declined');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [draftShown, setDraftShown] = useState(false);
  const [livePhase, setLivePhase] = useState<LivePhase>('locked');
  const [attemptNo, setAttemptNo] = useState(1);
  /** Two phones, no judge cam: this (the non-performer's) phone's Start, then its own camera. */
  const [startBusy, setStartBusy] = useState(false);
  const [selfArm, setSelfArm] = useState<CamArm | null>(null);
  /** The first bet of a session is a clean win; later ones take the dispute path. */
  const betsPlayed = useRef(0);
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const [result, setResult] = useState<'A_WINS' | 'B_WINS' | 'VOID'>('A_WINS');
  const [appealDeadline, setAppealDeadline] = useState(0);
  const [ggBusy, setGgBusy] = useState(false);
  const [ggAlert, setGgAlert] = useState<string | null>(null);
  const [payoutPhase, setPayoutPhase] = useState<PayoutPhase>('processed');
  /** The GG moment (../gg): Jake's GG, and a review someone asked the judge for. */
  const ggSample = useMemo(previewGg, []);
  const [review, setReview] = useState<ReviewModel | null>(null);
  const [turns, setTurns] = useState<{ name: string; state: TurnState }[]>([]);
  const [turnEnds, setTurnEnds] = useState<number | null>(null);
  const [hearingJudging, setHearingJudging] = useState(false);
  const [seats, setSeats] = useState<{ name: string; vote: VoteState; reason: string | null }[]>(
    [],
  );
  const [appealResult, setAppealResult] = useState<'stands' | 'flipped' | null>(null);
  const [price, setPrice] = useState(97412.5);
  const [expiry, setExpiry] = useState(0);

  const bet = useMemo(
    () =>
      market
        ? btcCloser(name)
        : danceBet
          ? danceOff(name)
          : bottleFlip(name, 'Jake', atOdds ? ODDS_STAKES : undefined),
    [market, danceBet, name, atOdds],
  );
  const danceScored = useMemo(
    () => (danceBet ? previewDanceScored(bet, danceVoid) : null),
    [bet, danceBet, danceVoid],
  );
  const danceNames = { a: bet.terms.party_a.display_name, b: bet.terms.party_b.display_name };
  const view = useMemo(() => betView(bet.terms, bet.termsHash, me), [bet, me]);

  // One set of timers per route: leaving a route cancels its pending "server pushes".
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = useCallback((ms: number, f: () => void) => {
    timers.current.push(setTimeout(f, ms));
  }, []);
  const go = useCallback((r: Route) => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setRoute(r);
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // ---- beat helpers ---------------------------------------------------------------------

  const startNegotiation = (asB = false) => {
    setMe(asB ? 'B' : 'A');
    setCaptions([]);
    setDraftShown(false);
    go('negotiate');
    NEGOTIATION_SCRIPT.forEach((line, i) =>
      later(1600 * (i + 1), () => setCaptions((c) => [...c, line])),
    );
    const end = 1600 * (NEGOTIATION_SCRIPT.length + 1);
    later(end, () => setDraftShown(true));
    later(end + 2500, () => openTerms(false));
  };

  const openTerms = (theyFirst: boolean) => {
    dispatch({ type: 'reset' });
    setLockExpires(Date.now() + 295_000);
    go('terms');
    // Nobody finished locking in before expires_at: the server revokes it (SCHEMAS §9.4).
    later(295_000, () => {
      if (['locked', 'locking', 'ended'].includes(lockRef.current.phase)) return;
      dispatch({ type: 'end', reason: 'expired' });
      setEndReason('expired');
      go('lockEnded');
    });
    // The device policy runs at mount (API-CONTRACT §6.3); the stand-in passes it.
    later(700, () => dispatch({ type: 'policy', ok: true }));
    if (theyFirst) later(1500, () => dispatch({ type: 'their_signature' }));
  };

  const holdComplete = async () => {
    feel('holdComplete');
    dispatch({ type: 'hold_complete' });
    const r = await authorizeOwner(`Lock in ${view.myStakeUsd}`, { simulateIfUnavailable: true });
    dispatch({ type: 'auth_result', ok: r.ok });
    if (!r.ok) {
      feel('failed');
      return;
    }
    feel('authorized');
    later(1500, () => {
      dispatch({ type: 'their_signature' });
      dispatch({ type: 'submitted' });
    });
    later(2300, () => {
      dispatch({ type: 'confirmed' });
      feel('locked');
    });
  };

  const startLive = (isMarket = market) => {
    setLivePhase('locked');
    go(isMarket ? 'market' : 'live');
    if (isMarket) {
      setExpiry(Date.now() + 210_000);
      // Gemini settles YES at expiry; A holds YES (SCHEMAS §2.6).
      later(210_000, () => openRuling('A_WINS', 'A'));
      return;
    }
    setAttemptNo(1);
    later(1500, () => setLivePhase('filming'));
    later(4000, () => setLivePhase('judging'));
    if (betsPlayed.current++ === 0) {
      later(6000, () => openRuling('A_WINS', 'A'));
    } else {
      // Dispute path: an unclear clip (REDO), then a contested one (hearing), which A loses.
      later(6000, () => {
        setAttemptNo(2);
        go('redo');
      });
    }
  };

  const openRuling = (outcome: 'A_WINS' | 'B_WINS' | 'VOID', who: 'A' | 'B' = me) => {
    setResult(outcome);
    setGgAlert(null);
    const deadline = Date.now() + APPEAL_WINDOW_MS;
    setAppealDeadline(deadline);
    go('ruling');
    // No GG by the deadline: the server finalizes at appeal_deadline + 1 s (SCHEMAS §9.3).
    later(APPEAL_WINDOW_MS + 1000, () => openPayout(myResult(outcome, who) === 'won'));
  };

  const openPayout = (won: boolean) => {
    setPayoutPhase('processed');
    go('payout');
    if (won) {
      feel('payout');
      setBalance((b) => b + Number(BigInt(view.theirStake) / 10_000n));
    }
    later(900, () => setPayoutPhase('confirmed'));
  };

  const gg = async () => {
    setGgBusy(true);
    setGgAlert(null);
    const r = await authorizeOwner('Concede', { simulateIfUnavailable: true });
    setGgBusy(false);
    if (!r.ok) {
      setGgAlert(t(COPY.terms.faceIdFailed));
      return;
    }
    openPayout(false);
  };

  const openGg = () => {
    setResult('A_WINS');
    setPayoutPhase('processed');
    go('ggPayout');
    later(900, () => setPayoutPhase('confirmed'));
  };

  /** The loser's ruling; 1.2 s in, someone says "check that again" and the sheet opens. */
  const openReview = () => {
    setResult('A_WINS');
    setGgAlert(null);
    setReview(null);
    setAppealDeadline(Date.now() + APPEAL_WINDOW_MS);
    go('review');
    later(1200, () => setReview(previewReview(APPEAL_WINDOW_MS - 2200)));
    later(APPEAL_WINDOW_MS + 1000, () => openPayout(false));
  };

  const openHearing = () => {
    setHearingJudging(false);
    setTurns([
      { name: bet.terms.party_a.display_name, state: 'now' },
      { name: bet.terms.party_b.display_name, state: 'next' },
    ]);
    setTurnEnds(Date.now() + 10_000);
    go('hearing');
    later(10_000, finishMyTurn);
  };

  const finishMyTurn = () => {
    setTurns((ts) => ts.map((x, i) => ({ ...x, state: i === 0 ? 'done' : 'now' })));
    setTurnEnds(Date.now() + 10_000);
    later(5000, () => {
      setTurns((ts) => ts.map((x) => ({ ...x, state: 'done' })));
      setTurnEnds(null);
      setHearingJudging(true);
    });
    later(7000, () => openRuling('B_WINS', 'A'));
  };

  const openAppeal = () => {
    setAppealResult(null);
    setSeats(PANEL.map((p) => ({ name: p.name, vote: 'voting', reason: null })));
    go('appeal');
    const votes: VoteState[] = ['upholds', 'upholds', 'overturns'];
    PANEL.forEach((p, i) =>
      later(1200 + i * 700, () =>
        setSeats((s) =>
          s.map((x, j) => (j === i ? { ...x, vote: votes[i] ?? 'abstains', reason: p.reason } : x)),
        ),
      ),
    );
    later(3200, () => setAppealResult('stands'));
  };

  // Market price ticks while the market screen is up.
  useEffect(() => {
    if (route !== 'market') return;
    const tm = setInterval(
      () => setPrice((p) => Math.round((p + (Math.random() - 0.45) * 18) * 100) / 100),
      1000,
    );
    return () => clearInterval(tm);
  }, [route]);

  // ---- render ---------------------------------------------------------------------------

  const screen = (() => {
    switch (route) {
      case 'menu':
        return <Menu onClose={onClose} open={openFromMenu} />;
      case 'launch':
        return <SplashView />;
      case 'launchFailed':
        return <SplashView failed onRetry={() => go('launch')} />;
      case 'signup':
        // No "Preview" step tag here: the harness's own Preview bar already says so.
        return (
          <SignupScreen
            api={signupApi}
            onSignedUp={(u) => {
              setName(u.display_name);
              go('enroll');
            }}
          />
        );
      case 'enroll':
        return (
          <FaceEnrollFlow
            api={faceApi}
            embedder={embedder}
            showPreviewTag={false}
            now={Date.now}
            onDone={() => {
              setFaceOn(true);
              setInRoom(false);
              go('home');
            }}
            onSkip={() => {
              setInRoom(false);
              go('home');
            }}
            onExit={() => go('home')}
          />
        );
      case 'faceSettings':
        return (
          <FaceSettings
            api={faceApi}
            onBack={() => {
              void faceApi.getStatus().then((s) => setFaceOn(s === 'active'));
              go('profile');
            }}
            onSetUp={() => go('enroll')}
          />
        );
      case 'home':
        return (
          <HomeScreen
            name={name}
            balanceCents={balance}
            series={
              balance === BALANCE_SERIES.at(-1) ? BALANCE_SERIES : [...BALANCE_SERIES, balance]
            }
            change={{ cents: balance - BALANCE_SERIES[0]! }}
            pending={false}
            inBetsUsd={null}
            room={inRoom ? ROOM : null}
            members={MEMBERS}
            offline={false}
            onJoin={async (code) => {
              await new Promise((r) => setTimeout(r, 500));
              if (code !== ROOM.code) return false;
              setInRoom(true);
              return true;
            }}
            onCreate={() => setInRoom(true)}
            onLeave={() => setInRoom(false)}
            onScan={() => go('scan')}
            onChallenge={() => {
              setMarket(false);
              startNegotiation();
            }}
            onHistory={() => openHistory(false)}
            onProfile={() => go('profile')}
          />
        );
      case 'scan':
        return (
          <ScanScreen
            onBack={() => go('home')}
            scan={async () => {
              // Stand-in: no model, no server. Every scan finds Jake.
              await new Promise((r) => setTimeout(r, 900));
              const jake = MEMBERS[0];
              return jake
                ? {
                    kind: 'found',
                    match: {
                      user: jake,
                      ticket: 'preview',
                      expiresAtMs: Date.now() + 60_000,
                      headToHead: HEAD_TO_HEAD,
                    },
                  }
                : { kind: 'miss', miss: 'no_match' };
            }}
            onChallenge={async () => {
              setMarket(false);
              startNegotiation();
              return 'ok';
            }}
            members={MEMBERS.filter((m) => m.online)}
            onPickMember={() => {
              setMarket(false);
              startNegotiation();
            }}
            onPickList={() => go('home')}
          />
        );
      case 'incoming':
        return (
          <IncomingScreen
            challenger={name}
            roomName={ROOM.name}
            onAccept={() => startNegotiation(true)}
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
      case 'negotiate':
        return (
          <NegotiateScreen
            view={view}
            captions={captions}
            speaking={captions[captions.length - 1]?.who === 'judge' && !draftShown}
            hasMic={me === 'A'}
            micMuted={draftShown}
            // B's phone has no judge session: it says the judge is on A's phone.
            judgeOn={me === 'B' ? firstName(view.theirName) : undefined}
            draft={draftShown ? view : null}
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
      case 'odds': {
        const card = odds
          ? offerCardView({ odds, me: 'A', state: 'TERMS_PROPOSED', terms: bet.terms })
          : null;
        const sheet = oddsCounter ? controlStakes(oddsCounter, 'A') : null;
        return (
          <NegotiateScreen
            view={view}
            captions={NEGOTIATION_SCRIPT.slice(0, 2).map((l) => ({ ...l }))}
            speaking={false}
            hasMic
            micMuted={false}
            draft={view}
            odds={{
              card: oddsAgreed ? null : card,
              agreed: oddsAgreed,
              busy: false,
              note: null,
              counter: oddsCounter
                ? {
                    control: oddsCounter,
                    readout: sheet?.ok ? readout(sheet.stakes, 'A', 'Jake') : (sheet?.note ?? null),
                    bases: [1, 5, 10, 20],
                    onChange: setOddsCounter,
                  }
                : null,
              suggest: null,
              canPropose: false,
              onAccept: () => {
                setOddsAgreed(true);
                later(1500, () => {
                  setAtOdds(true);
                  openTerms(false);
                });
              },
              onCounter: () => card && setOddsCounter(card.counterFrom),
              onSend: () => setOddsCounter(null),
              onCancel: () => setOddsCounter(null),
              onWithdraw: () => undefined,
            }}
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
      }
      case 'marketPanel': {
        const { a, b } = splitPot(2n * BigInt(parseUsd(String(mStake))), marketSideOf(mSide), 62n);
        return (
          <NegotiateScreen
            view={view}
            captions={[]}
            speaking={false}
            hasMic
            micMuted
            draft={null}
            market={{
              open: true,
              side: mSide,
              stakeUsd: mStake,
              stakes: MARKET_STAKES_USD,
              quote: {
                ok: true,
                refusal: null,
                upPct: 62,
                strikeUsd: '$97,250.03',
                priceUsd: `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                split: `${formatUsd(a.toString())} vs ${formatUsd(b.toString())}`,
                lockableUntilMs: expiry - 120_000,
                replay: false,
                nextWindowMs: null,
              },
              sending: false,
              confirming: false,
              canSubmit: true,
              canConfirm: false,
              waitingFor: null,
              note: null,
              onOpen: () => undefined,
              onClose: () => go('menu'),
              onSide: setMSide,
              onStake: setMStake,
              onSubmit: () => openTerms(false),
              onConfirm: () => undefined,
            }}
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
      }
      case 'terms':
        return (
          <TermsCardScreen
            view={view}
            lock={lock}
            expiresAtMs={lockExpires}
            onHoldStart={() => feel('holdStart')}
            onHoldComplete={() => void holdComplete()}
            onDecline={() => {
              dispatch({ type: 'end', reason: 'declined' });
              setEndReason('declined');
              go('lockEnded');
            }}
            onContinue={() => {
              if (!danceBet) return startLive();
              // A dance off: this phone watches while the judge cam films the round.
              setLivePhase('filming');
              go('danceWatch');
              later(15_000, () => setLivePhase('judging'));
            }}
          />
        );
      case 'lockEnded':
        return (
          <LockEndedScreen
            reason={endReason}
            onHome={() => go('home')}
            onReview={() => openTerms(false)}
          />
        );
      case 'live':
        return <LiveScreen view={view} phase={livePhase} attemptNo={attemptNo} />;
      case 'liveSelf':
        // The two-phone fallback: no judge cam in the room, so the non-performer's phone has
        // Start, and the server names it the recorder (attempt.started -> its own camera).
        return (
          <LiveScreen
            view={view}
            phase={livePhase}
            attemptNo={attemptNo}
            startBusy={startBusy}
            onStart={() => {
              setStartBusy(true);
              later(600, () => {
                setStartBusy(false);
                setSelfArm({ attemptNo: 1, goAtMs: Date.now() + 3000, maxMs: 6000 });
                go('selfCam');
              });
            }}
          />
        );
      case 'selfCam':
        // No back arrow: filming this attempt is not a mode to leave (DemoApp's judgeCam route).
        return (
          <JudgeCamScreen
            arm={selfArm}
            onSend={async () => {
              await new Promise((r) => setTimeout(r, 1200));
              later(900, () => {
                setLivePhase('judging');
                go('live');
                later(2500, () => openRuling('A_WINS', 'A'));
              });
            }}
          />
        );
      case 'judgeCam':
        return (
          <JudgeCamScreen
            onBack={() => go('profile')}
            onSend={() => new Promise((r) => setTimeout(r, 1200))}
          />
        );
      case 'ruling':
        return (
          <RulingScreen
            view={view}
            result={myResult(result, me)}
            reason={market ? MARKET_REASON : RULING_REASON}
            appealDeadlineMs={appealDeadline}
            busy={ggBusy}
            alert={ggAlert}
            onGG={() => void gg()}
            onAppeal={openAppeal}
          />
        );
      case 'redo':
        return (
          <RedoScreen
            attemptNo={attemptNo}
            maxAttempts={3}
            tip={FILMING_TIP}
            onReady={() => {
              setLivePhase('filming');
              go('live');
              later(2500, () => setLivePhase('judging'));
              later(4500, openHearing);
            }}
          />
        );
      case 'payout':
        return (
          <PayoutScreen
            view={view}
            result={myResult(result, me)}
            balanceCents={balance}
            phase={payoutPhase}
            onRetry={() => openPayout(true)}
            onHome={() => go('home')}
            onRematch={payoutPhase === 'confirmed' ? rematch : undefined}
            rematchBusy={rematchBusy}
          />
        );
      case 'ggPayout':
        return (
          <GgPayoutScreen
            view={view}
            gg={ggSample}
            me={me}
            balanceCents={balance}
            phase={payoutPhase === 'confirmed' ? 'confirmed' : 'processed'}
            onHome={() => go('home')}
            onRematch={payoutPhase === 'confirmed' ? rematch : undefined}
            rematchBusy={rematchBusy}
          />
        );
      case 'review':
        return (
          <RulingReview
            bet={previewReviewBet(review)}
            me={me}
            offsetMs={0}
            reason={RULING_REASON}
            confirm={async () => {
              const r = await authorizeOwner(t(COPY.ruling.appealPrompt), {
                simulateIfUnavailable: true,
              });
              if (!r.ok) throw Object.assign(new Error('auth'), { code: 'AUTH_FAILED' });
              openAppeal();
            }}
            decline={async () => setReview((r) => r && { ...r, closed: 'declined' })}
          >
            {(tag) => (
              <RulingScreen
                view={view}
                result="lost"
                reason={RULING_REASON}
                appealDeadlineMs={appealDeadline}
                busy={ggBusy}
                alert={ggAlert}
                onGG={() => void gg()}
                onAppeal={openAppeal}
                tag={tag}
              />
            )}
          </RulingReview>
        );
      case 'danceTerms':
        // A's "Dance off" panel: a routine, an even stake, the claim the card will read.
        return (
          <NegotiateScreen
            view={view}
            captions={[]}
            speaking={false}
            hasMic
            micMuted
            draft={null}
            dance={{
              open: true,
              routines: DANCE_ROUTINE_CHOICES,
              routineId: dRoutine,
              stakeUsd: dStake,
              stakes: stakeChips(DANCE_STAKES_USD),
              preview: danceClaimPreview(dRoutine, dStake),
              sending: false,
              confirming: false,
              canSubmit: true,
              canConfirm: false,
              waitingFor: null,
              note: null,
              onOpen: () => undefined,
              onClose: () => go('menu'),
              onRoutine: setDRoutine,
              onStake: setDStake,
              onSubmit: () => openTerms(false),
              onConfirm: () => undefined,
            }}
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
      case 'danceWatch':
        // The phone that does not film: the round live on the other phone, then its score.
        return (
          <PanelErrorBoundary name="Dance off" onError={() => undefined}>
            <Suspense fallback={null}>
              <DanceWatchScreen
                terms={bet.terms}
                me={me}
                names={danceNames}
                phase={livePhase === 'judging' ? 'judging' : 'dancing'}
                scored={null}
              />
            </Suspense>
          </PanelErrorBoundary>
        );
      case 'danceRuling':
        return (
          <RulingScreen
            view={view}
            result={myResult(result, me)}
            judgeLabel={t(COPY.dance.announcer)}
            title={danceVoid ? t(COPY.dance.tooClose) : undefined}
            note={danceVoid ? t(COPY.dance.refund) : null}
            reason={danceScored?.announcer_line ?? DANCE_REASON}
            detail={
              danceScored ? (
                <PanelErrorBoundary name="Dance off" onError={() => undefined}>
                  <Suspense fallback={null}>
                    <DanceResultBreakdown scored={danceScored} names={danceNames} />
                  </Suspense>
                </PanelErrorBoundary>
              ) : null
            }
            appealDeadlineMs={appealDeadline}
            busy={ggBusy}
            alert={ggAlert}
            onGG={() => void gg()}
            onRematch={danceVoid ? rematch : undefined}
            rematchBusy={rematchBusy}
          />
        );
      case 'rematchInvite':
        // B's side of a double or nothing: the usual invite, labelled.
        return (
          <IncomingScreen
            challenger={name}
            roomName={ROOM.name}
            rematch
            onAccept={() => startNegotiation(true)}
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
      case 'jarvis': {
        // Waiting: the wake line and "Tap to talk"; then the sentence, the judge connecting, and
        // its first answer.
        const waiting = jarvis === 'listening' || jarvis === 'capturing' || jarvis === 'denied';
        const line =
          STATUS_COPY[
            jarvis === 'denied' ? 'denied' : jarvis === 'capturing' ? 'capturing' : 'listening'
          ];
        const said: Caption[] = waiting ? [] : [{ who: 'a', text: JARVIS_SAID }];
        return (
          <NegotiateScreen
            view={view}
            captions={
              jarvis === 'speaking' ? [...said, { who: 'judge', text: JARVIS_REPLY }] : said
            }
            speaking={jarvis === 'speaking'}
            hasMic
            micMuted={false}
            draft={null}
            wake={
              waiting
                ? {
                    line: line ? wt(line) : null,
                    onTapToTalk: () => {
                      go('jarvis');
                      setJarvis('thinking');
                      later(2_500, () => setJarvis('speaking'));
                    },
                    onOpenSettings: jarvis === 'denied' ? () => undefined : undefined,
                  }
                : undefined
            }
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
      }
      case 'hearing':
        return (
          <HearingScreen
            view={view}
            turns={turns}
            myTurnOpen={turns[me === 'A' ? 0 : 1]?.state === 'now'}
            turnEndsAtMs={turnEnds}
            judging={hearingJudging}
            onTalkStart={() => undefined}
            onTalkEnd={() => {
              timers.current.forEach(clearTimeout);
              timers.current = [];
              finishMyTurn();
            }}
          />
        );
      case 'appeal':
        return (
          <AppealScreen
            seats={seats}
            result={appealResult}
            onContinue={() => openPayout(myResult(result, me) === 'won')}
          />
        );
      case 'market':
        return (
          <MarketScreen
            view={view}
            priceUsd={`$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            strikeUsd="$97,250.03"
            side={bet.terms.market?.side === 'YES' ? 'Up' : 'Down'}
            expiryMs={expiry}
            seedTrail={MARKET_TRAIL}
          />
        );
      case 'history':
        return (
          <HistoryScreen
            items={historyFirstLoad ? [] : HISTORY}
            status={historyStatus}
            onRetry={() => {
              setHistoryFirstLoad(false);
              setHistoryStatus('loading');
              later(1200, () => setHistoryStatus('ready'));
            }}
            onBack={() => go('home')}
          />
        );
      case 'profile':
        return (
          <ProfileScreen
            name={name}
            faceOn={faceOn}
            onBack={() => go('home')}
            onFace={() => go('faceSettings')}
            onHistory={() => openHistory(false)}
            onJudgeCam={() => go('judgeCam')}
            onDemo={() => go('demo')}
          />
        );
      case 'demo':
        return (
          <DemoClaimScreen
            onBack={() => go('profile')}
            claim={async () => {
              await new Promise((r) => setTimeout(r, 800));
              return 'Logan';
            }}
            onDone={() => {
              setName('Logan');
              go('home');
            }}
          />
        );
    }
  })();

  /** Double or nothing: a moment for the POST, then the new challenge (the typed form there). */
  function rematch() {
    setRematchBusy(true);
    later(700, () => {
      setRematchBusy(false);
      setDanceBet(false);
      setDanceVoid(false);
      setMarket(false);
      startNegotiation();
    });
  }

  /** History ready, or (`firstLoad`) still on its first page: the skeleton, held there. */
  function openHistory(firstLoad: boolean) {
    setHistoryFirstLoad(firstLoad);
    setHistoryStatus(firstLoad ? 'loading' : 'ready');
    go('history');
  }

  function openFromMenu(key: MenuKey) {
    setMarket(key === 'market' || key === 'termsMarket' || key === 'marketPanel');
    setDanceBet(key.startsWith('dance'));
    setDanceVoid(key === 'danceVoid');
    setRematchBusy(false);
    setAtOdds(key === 'termsOdds');
    setOdds(null);
    setOddsCounter(null);
    setOddsAgreed(false);
    setMe('A');
    switch (key) {
      case 'launch':
      case 'launchFailed':
        return go(key);
      case 'history':
        return openHistory(false);
      case 'historyLoading':
        return openHistory(true);
      case 'signup':
      case 'home':
      case 'scan':
      case 'profile':
      case 'judgeCam':
      case 'demo':
      case 'faceSettings':
        if (key === 'home') setInRoom(true);
        return go(key);
      case 'homeNoRoom':
        setInRoom(false);
        return go('home');
      case 'enroll':
        return go('enroll');
      case 'incoming':
        return go('incoming');
      case 'negotiate':
        return startNegotiation();
      case 'oddsOffer':
      case 'oddsJudge':
        setOdds(previewOdds(key === 'oddsJudge' ? 'judge' : 'party'));
        return go('odds');
      case 'marketPanel':
        // 3:20 to the contract's expiry: Gemini prices it for another 1:20
        setExpiry(Date.now() + 200_000);
        return go('marketPanel');
      case 'terms':
      case 'termsMarket':
      case 'termsOdds':
        return openTerms(false);
      case 'termsTheyFirst':
        return openTerms(true);
      case 'termsLocked':
        // Straight to the locked moment: both signatures in, the lock confirmed.
        openTerms(false);
        for (const e of [
          { type: 'policy', ok: true },
          { type: 'already_signed' },
          { type: 'their_signature' },
          { type: 'submitted' },
          { type: 'confirmed' },
        ] as const)
          dispatch(e);
        return;
      case 'endDeclined':
      case 'endExpired':
      case 'endFailed':
      case 'endChanged': {
        const r: Record<string, EndReason> = {
          endDeclined: 'declined',
          endExpired: 'expired',
          endFailed: 'lock_failed',
          endChanged: 'terms_changed',
        };
        setEndReason(r[key] ?? 'declined');
        return go('lockEnded');
      }
      case 'live':
        return startLive(false);
      case 'liveSelf':
        setLivePhase('locked');
        setAttemptNo(1);
        setStartBusy(false);
        return go('liveSelf');
      case 'rulingWon':
        return openRuling('A_WINS', 'A');
      case 'rulingLost':
        setMe('B');
        return openRuling('A_WINS', 'B');
      case 'rulingVoid':
        return openRuling('VOID', 'A');
      case 'redo':
        setAttemptNo(2);
        return go('redo');
      case 'payoutWon':
        setResult('A_WINS');
        return openPayout(true);
      case 'payoutLost':
        setMe('B');
        setResult('A_WINS');
        return openPayout(false);
      case 'payoutReverted':
        setResult('A_WINS');
        setPayoutPhase('reverted');
        return go('payout');
      case 'hearing':
        return openHearing();
      case 'appeal':
        setMe('B');
        setResult('A_WINS');
        return openAppeal();
      case 'market':
        return startLive(true);
      case 'ggWinner':
        return openGg();
      case 'ggLoser':
        setMe('B');
        return openGg();
      case 'reviewSheet':
        setMe('B');
        return openReview();
      case 'danceTerms':
        setDRoutine('wave-pop');
        setDStake(5);
        return go('danceTerms');
      case 'danceCard':
        return openTerms(false);
      case 'danceLive':
        setMe('B');
        setLivePhase('filming');
        go('danceWatch');
        later(15_000, () => setLivePhase('judging'));
        return;
      case 'danceResult':
      case 'danceVoid': {
        setResult(key === 'danceVoid' ? 'VOID' : 'A_WINS');
        setGgAlert(null);
        setAppealDeadline(Date.now() + APPEAL_WINDOW_MS);
        return go('danceRuling');
      }
      case 'rematch':
        setResult('A_WINS');
        return openPayout(true);
      case 'rematchInvite':
        return go('rematchInvite');
      case 'jarvis':
        go('jarvis');
        setJarvis('listening');
        later(1_500, () => setJarvis('capturing'));
        later(4_000, () => setJarvis('thinking'));
        later(6_500, () => setJarvis('speaking'));
        return;
      case 'jarvisDenied':
        go('jarvis');
        return setJarvis('denied');
    }
  }

  // A thin "Preview" strip sits above every screen, under the status bar; the screens below it
  // get top inset 0 so they lay out as they would on their own.
  const insets = useSafeAreaInsets();
  const inner = useMemo(() => ({ ...insets, top: 0 }), [insets]);
  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <PreviewStrip onMenu={route === 'menu' ? undefined : () => go('menu')} />
      <SafeAreaInsetsContext.Provider value={inner}>{screen}</SafeAreaInsetsContext.Provider>
      {/* Every screen is on black, so the status bar is always light. Keyed by route: it
          re-mounts after each screen and so stays last on the status bar stack. */}
      <StatusBar key={route} style="light" />
      {/* Last, above everything, as in DemoApp: the "Jarvis" preview's edge light. */}
      <RainbowLoop
        active={route === 'jarvis' && (jarvis === 'capturing' || jarvis === 'thinking')}
        mode={jarvis === 'capturing' ? 'listening' : 'thinking'}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------------------

type MenuKey =
  | 'launch'
  | 'launchFailed'
  | 'signup'
  | 'enroll'
  | 'faceSettings'
  | 'home'
  | 'homeNoRoom'
  | 'scan'
  | 'incoming'
  | 'negotiate'
  | 'oddsOffer'
  | 'oddsJudge'
  | 'terms'
  | 'termsTheyFirst'
  | 'termsLocked'
  | 'termsOdds'
  | 'termsMarket'
  | 'endDeclined'
  | 'endExpired'
  | 'endFailed'
  | 'endChanged'
  | 'live'
  | 'liveSelf'
  | 'judgeCam'
  | 'rulingWon'
  | 'rulingLost'
  | 'rulingVoid'
  | 'redo'
  | 'payoutWon'
  | 'payoutLost'
  | 'payoutReverted'
  | 'hearing'
  | 'appeal'
  | 'marketPanel'
  | 'market'
  | 'history'
  | 'historyLoading'
  | 'profile'
  | 'demo'
  | 'ggWinner'
  | 'ggLoser'
  | 'reviewSheet'
  | 'danceTerms'
  | 'danceCard'
  | 'danceLive'
  | 'danceResult'
  | 'danceVoid'
  | 'rematch'
  | 'rematchInvite'
  | 'jarvis'
  | 'jarvisDenied';

/** The screen index, by beat. "Full run" entries play on into the next screens. */
const MENU: readonly { section: string; items: readonly [MenuKey, string][] }[] = [
  {
    section: 'Launch',
    items: [
      ['launch', '0  App launch'],
      ['launchFailed', '0b  App launch, offline'],
    ],
  },
  {
    section: 'Sign up',
    items: [
      ['signup', '1  Sign up (full run)'],
      ['enroll', '2  Consent and face'],
      ['faceSettings', '3  Face settings'],
    ],
  },
  {
    section: 'Home',
    items: [
      ['homeNoRoom', '4  Home, no room'],
      ['home', '5  Home, in a room (scrub the line)'],
      ['history', '6  History (pull to refresh)'],
      ['historyLoading', '6b  History, loading'],
      ['profile', '7  Profile'],
    ],
  },
  {
    section: 'Beat 1-2: challenge',
    items: [
      ['scan', '8  Scan a face'],
      ['incoming', '9  Incoming challenge'],
      ['negotiate', '10  Judge sets terms (full run)'],
      ['oddsOffer', '10b  Odds offer, accept or counter'],
      ['oddsJudge', '10c  Judge odds, from history'],
    ],
  },
  {
    section: 'Beat 3: lock',
    items: [
      ['terms', '11  Terms card (swipe up to lock)'],
      ['termsTheyFirst', '12  Terms card, they signed first'],
      ['termsLocked', '12b  Locked'],
      ['termsOdds', '12c  Terms card at odds'],
      ['endDeclined', '13  Declined'],
      ['endExpired', '14  Expired'],
      ['endFailed', '15  Lock failed'],
      ['endChanged', '16  Terms changed'],
    ],
  },
  {
    section: 'Beat 4: attempt and payout',
    items: [
      ['live', '17  Locked, filming, judging'],
      ['liveSelf', '17b  Two phones: this phone films'],
      ['judgeCam', '18  Judge cam'],
      ['rulingWon', '19  Ruling, winner'],
      ['rulingLost', '20  Ruling, loser (swipe GG, appeal)'],
      ['rulingVoid', '21  Ruling, no contest'],
      ['redo', '22  Run it back'],
      ['payoutWon', '23  Payout, winner'],
      ['payoutLost', '24  Payout, loser'],
      ['payoutReverted', '25  Payout failed'],
    ],
  },
  {
    section: 'Beat 5-6',
    items: [
      ['hearing', '26  Hearing'],
      ['appeal', '27  Appeal panel'],
      ['marketPanel', '28  Bet on Bitcoin (odds, stakes)'],
      ['termsMarket', '29  Market terms card'],
      ['market', '30  Waiting for market'],
    ],
  },
  {
    section: 'GG moment',
    items: [
      ['ggWinner', '30b  GG, winner'],
      ['ggLoser', '30c  GG, loser'],
      ['reviewSheet', '30d  Review requested'],
    ],
  },
  { section: 'Demo', items: [['demo', '31  Demo account']] },
  {
    section: 'Dance off',
    items: [
      ['danceTerms', '32  Dance off (routine, stake)'],
      ['danceCard', '33  Dance off terms card'],
      ['danceLive', '34  Dance off live, other phone'],
      ['danceResult', '35  Dance off ruling, scores'],
      ['danceVoid', '36  Too close to call'],
    ],
  },
  {
    section: 'Double or nothing',
    items: [
      ['rematch', '37  Payout, double or nothing'],
      ['rematchInvite', '38  Incoming double or nothing'],
    ],
  },
  {
    section: 'Jarvis',
    items: [
      ['jarvis', '39  Jarvis, the rainbow loop'],
      ['jarvisDenied', '40  Jarvis, mic off (tap to talk)'],
    ],
  },
];

function Menu({ onClose, open }: { onClose: () => void; open: (k: MenuKey) => void }) {
  // The list runs to the bottom edge (the inset is content padding instead): a row that has
  // scrolled into the home-indicator band is still on screen and tappable, which Maestro's
  // scrollUntilVisible relies on (it can stop with the last row there).
  const insets = useSafeAreaInsets();
  const edge = useMemo(() => ({ ...insets, bottom: 0 }), [insets]);
  return (
    <SafeAreaInsetsContext.Provider value={edge}>
      <Screen>
        <TopBar onBack={onClose} title="Screens" />
        <ScrollView
          contentContainerStyle={[styles.menu, { paddingBottom: space.x5 + insets.bottom }]}
        >
          {MENU.map((s) => (
            <Section key={s.section} label={s.section}>
              {s.items.map(([key, label]) => (
                <ListRow key={key} testID={`menu-${key}`} title={label} onPress={() => open(key)} />
              ))}
            </Section>
          ))}
        </ScrollView>
      </Screen>
    </SafeAreaInsetsContext.Provider>
  );
}

function PreviewStrip({ onMenu }: { onMenu: (() => void) | undefined }) {
  return (
    <View style={styles.strip}>
      <Label variant="smallStrong">Preview</Label>
      {onMenu ? (
        <Pressable
          testID="preview-menu"
          accessibilityRole="button"
          accessibilityLabel="Screens"
          onPress={onMenu}
          hitSlop={8}
          style={styles.menuButton}
        >
          <Label variant="smallStrong">Screens</Label>
        </Pressable>
      ) : null}
    </View>
  );
}

// The dev strip is black like every screen, set off by a hairline underneath; its "Screens"
// button is a #1C1C1F pill.
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  menu: { paddingHorizontal: space.page, paddingBottom: space.x5 },
  strip: {
    height: space.x5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.page,
    backgroundColor: palette.background,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.hairline,
  },
  menuButton: {
    paddingHorizontal: half.x15,
    paddingVertical: half.x05,
    borderRadius: radius.pill,
    backgroundColor: palette.fill,
  },
});
