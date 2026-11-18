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
import { StyleSheet, View } from 'react-native';

import type { CreateBetResponse, RoomMember, VoiceDynamicVariables } from '@youre-on/shared/api';
import { otherParty, type Party } from '@youre-on/shared/primitives';

import { extractFrames, readClip } from '../attempt/capture';
import { initialLock, lockReducer } from '../bets/lock';
import { emptyBet, endReasonOf, lockSignals, type BetModel } from '../bets/store';
import { betView, myResult, type BetView } from '../bets/view';
import { feel } from '../device/feedback';
import { PanelErrorBoundary } from '../diagnostics/PanelErrorBoundary';
import { createServerFaceApi, type FaceStatus } from '../enroll/api';
import { FaceEnrollFlow, FaceSettings } from '../enroll/EnrollScreens';
import { getNativeEmbedder } from '../face/native';
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
import { HomeScreen, ProfileScreen } from '../screens/HomeScreens';
import { LockEndedScreen, TermsCardScreen } from '../screens/LockScreens';
import {
  JudgeCamScreen,
  LiveScreen,
  PayoutScreen,
  RedoScreen,
  RulingScreen,
  type CamArm,
  type Clip,
  type LivePhase,
  type PayoutPhase,
} from '../screens/PlayScreens';
import type { PreviewUser } from '../preview/data';
import { createServerSignupApi } from '../signup/api';
import { SignupScreen } from '../signup/SignupScreen';
import { Label, PrimaryButton } from '../ui/kit';
import { isCopyOk } from '../ui/copyRule';
import { Page, Screen, StatusHero } from '../ui/parts';
import { palette } from '../ui/tokens';
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
/** EXPO_PUBLIC_VOICE=off builds run without the live judge (screens still follow the server). */
const VOICE_ENABLED = process.env.EXPO_PUBLIC_VOICE !== 'off';
/** EXPO_PUBLIC_FACE=off hides face enrollment and the face scan (the room list still works). */
const FACE_ENABLED = process.env.EXPO_PUBLIC_FACE !== 'off';
const JudgeVoice = lazy(() => import('../voice/JudgeVoice'));
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
  /** The bet whose voice session failed (no key, token refused, SDK error): type it instead. */
  const [voiceFailedBet, setVoiceFailedBet] = useState<string | null>(null);
  const [walletKey, setWalletKey] = useState<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [busy, setBusy] = useState(false);
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
  /** The on-device embedder (the model loads on first use; the scan screen warms it up). */
  const embedder = useMemo(() => (FACE_ENABLED ? getNativeEmbedder() : null), []);
  const [faceStatus, setFaceStatus] = useState<FaceStatus | null>(null);
  /** Where enrollment returns to: home after the signup offer, else face settings. */
  const enrollFrom = useRef<'signup' | 'settings'>('settings');
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
    // Re-join the last room (a convenience; the server's room_members row is the truth).
    void import('expo-secure-store').then(async (SecureStore) => {
      const code = await SecureStore.getItemAsync(LAST_ROOM_KEY).catch(() => null);
      if (code && !appRef.current.room) void joinRoom(code);
    });
    return () => rt.ws.stop();
  }, [app.auth, userId, rt]);

  // ---- socket status, presence -------------------------------------------------------------
  useEffect(() => {
    const a = rt.onStatus((s) =>
      dispatch({ type: 'offline', offline: s === 'reconnecting' || s === 'unauthorized' }),
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
    };
  }, [rt]);

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

  const voiceFailed = useCallback((id: string) => {
    setVoiceFailedBet(id);
    typedDispatch({ type: 'open' });
  }, []);

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
  useEffect(() => {
    if (!betId || state !== 'AWAITING_AUTHORIZATIONS' || req) return;
    let live = true;
    const tm = setTimeout(() => {
      rt.api.getLock(betId).then(
        (r) => {
          if (!live) return;
          rt.hub.patch(betId, (m) =>
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
    }, 600);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [rt, betId, state, req]);

  const lockId = req?.lock_request_id ?? null;
  const mismatch = bet?.termsMismatch ?? false;
  useEffect(() => {
    if (!req || !me) return;
    lockDispatch({ type: 'reset' });
    setAlert(null);
    const b = rt.hub.get(req.bet_id);
    if (b?.authorized[otherParty(me)]) lockDispatch({ type: 'their_signature' });
    if (!walletKey) return;
    // Refuse when the lock's terms aren't the terms this phone was shown (recomputed hashes).
    const ok = !mismatch && checkLockPolicy(req, walletKey, Date.now()).ok;
    lockDispatch({ type: 'policy', ok });
    if (!ok) feel('failed');
    if (b?.state === 'AWAITING_LOCK') lockDispatch({ type: 'submitted' });
  }, [rt, lockId, walletKey, mismatch, me]);

  // Custodial path / cold start: already LOCKED -> the card shows Locked, then moves on.
  useEffect(() => {
    if (state === 'LOCKED') lockDispatch({ type: 'confirmed' });
    if (state === 'LOCKED' && betId) {
      const tm = setTimeout(() => dispatch({ type: 'lock_ack', bet_id: betId }), 1800);
      return () => clearTimeout(tm);
    }
    return undefined;
  }, [state, betId]);

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
    if (!room) return;
    rt.api.createBet(room.room_id, u.user_id).then(openNewBet, () => undefined);
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

  async function joinRoom(code: string): Promise<boolean> {
    try {
      const r = await rt.api.joinRoom(code);
      dispatch({
        type: 'room',
        room: { room_id: r.room.room_id, code: r.room.code, name: r.room.name ?? r.room.code },
        members: r.members,
      });
      rt.ws.subscribeRoom(r.room.room_id);
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
      lockDispatch({ type: 'auth_result', ok: false });
      feel('failed');
      if (e instanceof WalletError && e.code === 'POLICY_REJECTED') setAlert(t(COPY.terms.refused));
      else if (
        e instanceof WalletError &&
        (e.code === 'AUTH_CANCELLED' || e.code === 'AUTH_FAILED')
      )
        setAlert(t(COPY.terms.faceIdFailed));
      else if (e instanceof ApiClientError && e.code === 'STALE_LOCK_REQUEST')
        rt.hub.patch(req.bet_id, (m) => ({ ...m, authorizeRequest: null }));
      else setAlert(t(COPY.app.failed));
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

  const startAttempt = async () => {
    if (!bet) return;
    setBusy(true);
    try {
      await rt.api.startAttempt(bet.bet_id, nextAttemptNo(bet));
    } catch (e) {
      if (!(e instanceof ApiClientError && e.code === 'INVALID_STATE'))
        setAlert(t(COPY.app.failed));
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

  const voice =
    VOICE_ENABLED && !app.judgeCam && bet && me === 'A' && !isOver(bet.state)
      ? (voiceVars.current.get(bet.bet_id) ?? null)
      : null;

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
              if (!FACE_ENABLED) return;
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
            onBack={() => dispatch({ type: 'overlay', overlay: 'none' })}
            claim={async (qr) => {
              try {
                const token = qr.trim().replace(/^youreon:\/\/[a-z-]+\//i, '');
                const s = await rt.sessions.demoClaim(token);
                return s.user.display_name;
              } catch {
                return null;
              }
            }}
            onDone={() => dispatch({ type: 'overlay', overlay: 'none' })}
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
            onJoin={joinRoom}
            onCreate={() =>
              void rt.api.createRoom().then(
                (r) => void joinRoom(r.code),
                () => undefined,
              )
            }
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
              FACE_ENABLED && app.room
                ? () => dispatch({ type: 'overlay', overlay: 'scan' })
                : undefined
            }
            onChallenge={challengeFromList}
            onHistory={() => undefined}
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
            onHistory={() => undefined}
            onJudgeCam={() => {
              dispatch({ type: 'judge_cam', on: !app.judgeCam });
              dispatch({ type: 'overlay', overlay: 'none' });
              void rt.api
                .setDeviceRole(app.judgeCam ? 'phone' : 'judge_cam', app.room?.room_id)
                .catch(() => undefined);
            }}
            onDemo={() => dispatch({ type: 'overlay', overlay: 'demoClaim' })}
          />
        );
      case 'scan': {
        const room = app.room;
        if (!room || !embedder) return waiting;
        return (
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
              enrollFrom.current = 'settings';
              dispatch({ type: 'overlay', overlay: 'enroll' });
            }}
          />
        );
      case 'enroll':
        return embedder ? (
          <FaceEnrollFlow
            api={faceApi}
            embedder={embedder}
            onDone={() => {
              refreshFace();
              leaveEnroll();
            }}
            onSkip={leaveEnroll}
            onExit={leaveEnroll}
          />
        ) : (
          waiting
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
            speaking={captions.at(-1)?.who === 'judge'}
            hasMic={me === 'A' && VOICE_ENABLED}
            micMuted={view !== null}
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
        ) : view && state === 'LOCKED' ? (
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
            onStart={me === 'A' ? () => void startAttempt() : undefined}
            startBusy={busy}
          />
        ) : (
          waiting
        );
      }
      case 'judgeCam':
        return (
          <JudgeCamScreen
            arm={arm}
            onSend={sendClip}
            onBack={() => dispatch({ type: 'judge_cam', on: false })}
          />
        );
      case 'redo':
        return (
          <RedoScreen
            attemptNo={nextAttemptNo(bet ?? { lastAttemptNo: null })}
            maxAttempts={3}
            tip={FILMING_TIP}
            onReady={() => {
              if (me === 'A') void startAttempt();
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
      {voice && bet ? (
        <PanelErrorBoundary
          key={bet.bet_id}
          name="voice"
          onError={(m) => {
            console.warn('[yo] voice', m);
            voiceFailed(bet.bet_id);
          }}
        >
          <Suspense fallback={null}>
            <JudgeVoice
              rt={rt}
              betId={bet.bet_id}
              dynamicVariables={voice}
              startAttempt={(n) => rt.api.startAttempt(bet.bet_id, n).then(() => undefined)}
              onShowTermsCard={() => undefined}
              onFailed={() => voiceFailed(bet.bet_id)}
            />
          </Suspense>
        </PanelErrorBoundary>
      ) : null}
      {alert && route !== 'ruling' && route !== 'terms' ? (
        <View style={styles.toast} pointerEvents="none">
          <Label variant="small">{alert}</Label>
        </View>
      ) : null}
      <StatusBar style="dark" />
    </View>
  );
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
