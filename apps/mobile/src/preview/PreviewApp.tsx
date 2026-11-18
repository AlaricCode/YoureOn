// The whole app on stand-in data, opened from the diagnostics screen until sign-in (D0-M4), the
// realtime client (D1-M4), rooms (D0-J4), the judge (D1-J1, D2-M3), the lock (D2-L2), rulings
// (D3-J1) and payouts (D3-L1) are served. It walks the demo beats in order and has a "Screens"
// menu that opens any screen directly. Timers stand in for the server's pushes. Nothing here moves
// money or talks to a server; Face ID is real on a phone that has it.
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { initialLock, lockReducer, type EndReason } from '../bets/lock';
import { betView, myResult } from '../bets/view';
import { authorizeOwner } from '../device/authorize';
import { feel } from '../device/feedback';
import { createPreviewFaceApi } from '../enroll/api';
import { createPreviewEmbedder } from '../enroll/embedder';
import { FaceEnrollFlow, FaceSettings } from '../enroll/EnrollScreens';
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
import { palette, radius, space } from '../ui/tokens';
import {
  BALANCE,
  bottleFlip,
  btcCloser,
  FILMING_TIP,
  HEAD_TO_HEAD,
  HISTORY,
  MARKET_REASON,
  MEMBERS,
  NEGOTIATION_SCRIPT,
  PANEL,
  ROOM,
  RULING_REASON,
} from './data';

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
  | 'terms'
  | 'lockEnded'
  | 'live'
  | 'judgeCam'
  | 'ruling'
  | 'redo'
  | 'payout'
  | 'hearing'
  | 'appeal'
  | 'market'
  | 'history'
  | 'profile'
  | 'demo';

const APPEAL_WINDOW_MS = 10_000;
const startCents = Number(BigInt(BALANCE.usdc) / 10_000n);

export default function PreviewApp({ onClose }: { onClose: () => void }) {
  const faceApi = useMemo(() => createPreviewFaceApi({ delayMs: 600 }), []);
  const embedder = useMemo(() => createPreviewEmbedder(), []);
  const signupApi = useMemo(() => createPreviewSignupApi({ delayMs: 600 }), []);

  const [route, setRoute] = useState<Route>('menu');
  const [name, setName] = useState('Logan');
  const [faceOn, setFaceOn] = useState(false);
  const [inRoom, setInRoom] = useState(true);
  const [balance, setBalance] = useState(startCents);
  const [market, setMarket] = useState(false);
  const [me, setMe] = useState<'A' | 'B'>('A');
  const [lock, dispatch] = useReducer(lockReducer, initialLock);
  const [lockExpires, setLockExpires] = useState(0);
  const [endReason, setEndReason] = useState<EndReason>('declined');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [draftShown, setDraftShown] = useState(false);
  const [livePhase, setLivePhase] = useState<LivePhase>('locked');
  const [attemptNo, setAttemptNo] = useState(1);
  /** The first bet of a session is a clean win; later ones take the dispute path. */
  const betsPlayed = useRef(0);
  const lockRef = useRef(lock);
  lockRef.current = lock;
  const [result, setResult] = useState<'A_WINS' | 'B_WINS' | 'VOID'>('A_WINS');
  const [appealDeadline, setAppealDeadline] = useState(0);
  const [ggBusy, setGgBusy] = useState(false);
  const [ggAlert, setGgAlert] = useState<string | null>(null);
  const [payoutPhase, setPayoutPhase] = useState<PayoutPhase>('processed');
  const [turns, setTurns] = useState<{ name: string; state: TurnState }[]>([]);
  const [turnEnds, setTurnEnds] = useState<number | null>(null);
  const [hearingJudging, setHearingJudging] = useState(false);
  const [seats, setSeats] = useState<{ name: string; vote: VoteState; reason: string | null }[]>(
    [],
  );
  const [appealResult, setAppealResult] = useState<'stands' | 'flipped' | null>(null);
  const [price, setPrice] = useState(97412.5);
  const [expiry, setExpiry] = useState(0);

  const bet = useMemo(() => (market ? btcCloser(name) : bottleFlip(name)), [market, name]);
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
        return (
          <SignupScreen
            api={signupApi}
            preview
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
            onHistory={() => go('history')}
            onProfile={() => go('profile')}
          />
        );
      case 'scan':
        return (
          <ScanScreen
            onBack={() => go('home')}
            scan={async () => {
              // Stand-in for face/scan.ts: the room's server is not here, so Jake always matches.
              await new Promise((r) => setTimeout(r, 900));
              const jake = MEMBERS[0];
              return jake
                ? {
                    kind: 'match',
                    user: { user_id: jake.user_id, display_name: jake.display_name },
                    matchTicket: 'preview',
                    headToHead: HEAD_TO_HEAD,
                  }
                : { kind: 'problem', problem: 'no_match', label: 'No match' };
            }}
            onChallenge={() => {
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
            draft={draftShown ? view : null}
            onDecline={() => {
              setEndReason('declined');
              go('lockEnded');
            }}
          />
        );
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
            onContinue={() => startLive()}
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
            won={myResult(result, me) === 'won'}
            balanceCents={balance}
            phase={payoutPhase}
            onRetry={() => openPayout(true)}
            onHome={() => go('home')}
          />
        );
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
          />
        );
      case 'history':
        return <HistoryScreen items={HISTORY} onBack={() => go('home')} />;
      case 'profile':
        return (
          <ProfileScreen
            name={name}
            faceOn={faceOn}
            onBack={() => go('home')}
            onFace={() => go('faceSettings')}
            onHistory={() => go('history')}
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

  function openFromMenu(key: MenuKey) {
    setMarket(key === 'market' || key === 'termsMarket');
    setMe('A');
    switch (key) {
      case 'launch':
      case 'launchFailed':
        return go(key);
      case 'signup':
      case 'home':
      case 'scan':
      case 'history':
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
      case 'terms':
      case 'termsMarket':
        return openTerms(false);
      case 'termsTheyFirst':
        return openTerms(true);
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
      <StatusBar style="light" />
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
  | 'terms'
  | 'termsTheyFirst'
  | 'termsMarket'
  | 'endDeclined'
  | 'endExpired'
  | 'endFailed'
  | 'endChanged'
  | 'live'
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
  | 'market'
  | 'history'
  | 'profile'
  | 'demo';

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
      ['home', '5  Home, in a room'],
      ['history', '6  History'],
      ['profile', '7  Profile'],
    ],
  },
  {
    section: 'Beat 1-2: challenge',
    items: [
      ['scan', '8  Scan a face'],
      ['incoming', '9  Incoming challenge'],
      ['negotiate', '10  Judge sets terms (full run)'],
    ],
  },
  {
    section: 'Beat 3: lock',
    items: [
      ['terms', '11  Terms card'],
      ['termsTheyFirst', '12  Terms card, they signed first'],
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
      ['judgeCam', '18  Judge cam'],
      ['rulingWon', '19  Ruling, winner'],
      ['rulingLost', '20  Ruling, loser (GG, appeal)'],
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
      ['termsMarket', '28  Market terms card'],
      ['market', '29  Waiting for market'],
    ],
  },
  { section: 'Demo', items: [['demo', '30  Demo account']] },
];

function Menu({ onClose, open }: { onClose: () => void; open: (k: MenuKey) => void }) {
  return (
    <Screen>
      <TopBar onBack={onClose} title="Screens" />
      <ScrollView contentContainerStyle={styles.menu}>
        {MENU.map((s) => (
          <Section key={s.section} label={s.section}>
            {s.items.map(([key, label]) => (
              <ListRow key={key} testID={`menu-${key}`} title={label} onPress={() => open(key)} />
            ))}
          </Section>
        ))}
      </ScrollView>
    </Screen>
  );
}

function PreviewStrip({ onMenu }: { onMenu: (() => void) | undefined }) {
  return (
    <View style={styles.strip}>
      <Label variant="small">Preview</Label>
      {onMenu ? (
        <Pressable
          testID="preview-menu"
          accessibilityRole="button"
          accessibilityLabel="Screens"
          onPress={onMenu}
          hitSlop={8}
          style={styles.menuButton}
        >
          <Label variant="small">Screens</Label>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  menu: { paddingHorizontal: space.page, paddingBottom: space.x5 },
  strip: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.page,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.hairline,
  },
  menuButton: {
    paddingHorizontal: space.x1,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.hairline,
    backgroundColor: palette.background,
  },
});
