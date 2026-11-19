// Beats 4-6 and the judge cam:
//   LiveScreen      after the lock: Locked → filming (try n) → judging (ARCHITECTURE §3.4)
//   JudgeCamScreen  the phone that films: the judge cam (a third phone), or with two phones the
//                   non-performer's own. "3-2-1, Go", record up to 6 s (video only, the mic
//                   stays with the voice judge) with a big Stop, send the frames (TASKS D3-M1)
//   RulingScreen    the ruling with the 10 s window; the loser gets GG (tap + Face ID) and, on
//                   camera bets, "I appeal!" until 1 s before the window ends (D3-M2, D4-M3)
//   RedoScreen      "Run it back" with one filming tip (D3-M2)
//   PayoutScreen    the winner's payout at `processed`, pending tint until confirmed, revert
//                   after 5 s (SCHEMAS §9.2, API-CONTRACT §6.2); the loser's GG screen
//   HearingScreen   two 10 s push-to-talk turns, A then B (D4-M3, API-CONTRACT §2.11)
//   AppealScreen    the three-model panel voting live (D4-M3, SCHEMAS §7)
//   MarketScreen    a Gemini bet waiting for settlement (D4-M4)
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RECORDING_CAMERA } from '../attempt/recorder';
import { camRetryAction } from '../attempt/retry';
import { recordedSpan } from '../attempt/span';
import { hasCameraLens } from '../device/camera';
import { feel } from '../device/feedback';
import {
  canAppeal,
  canConcede,
  countdownLabel,
  RESULT_TITLE,
  signedUsd,
  type BetView,
  type MyResult,
} from '../bets/view';
import {
  AlertLine,
  BodyText,
  Label,
  PrimaryButton,
  QuietButton,
  ShutterButton,
  Stage,
  StageBubble,
} from '../ui/kit';
import {
  AttemptDots,
  Avatar,
  BalanceLine,
  Chip,
  DataText,
  DotsLabel,
  InfoRow,
  MomentGroup,
  MomentHeadline,
  MomentMoney,
  MomentScreen,
  Page,
  Screen,
  Section,
  Sparkline,
  StatusHero,
  TopBar,
  useNow,
} from '../ui/parts';
import { DrainBar } from '../ui/DrainBar';
import { JudgeOrb } from '../ui/JudgeOrb';
import { RollingText } from '../ui/RollingNumber';
import { Perforation, Slip } from '../ui/slip';
import { SwipeToConfirm } from '../ui/SwipeToConfirm';
import { avatarSize, color, half, hold, palette, radius, space, type } from '../ui/tokens';
import { COPY, fill, t } from './copy';

// ---------------------------------------------------------------------------------------

export type LivePhase = 'locked' | 'filming' | 'judging';

export function LiveScreen({
  view,
  phase,
  attemptNo,
  onStart,
  startBusy = false,
  tag,
}: {
  view: BetView;
  phase: LivePhase;
  attemptNo: number;
  /**
   * The non-performer's phone: "Start" (also the fallback for the judge's request_attempt). With
   * no judge cam in the room this phone films (API-CONTRACT §2.9, ../attempt/recorder).
   */
  onStart?: (() => void) | undefined;
  startBusy?: boolean;
  tag?: string | undefined;
}) {
  const performerIsMe = view.performerName === view.myName;
  return (
    <Screen>
      <TopBar title={t(COPY.live.title)} tag={tag} />
      <Page>
        {/* The slip, kept: the claim, then you (white ring), the pot in thin numerals, them. */}
        <Slip>
          <DataText variant="statement">{view.claim}</DataText>
          <Perforation />
          <View style={styles.vs}>
            <Avatar name={view.myName} size={avatarSize.vs} accent />
            <View style={styles.pot}>
              <Label variant="small">{t(COPY.live.pot)}</Label>
              <DataText variant="figure">{view.potUsd}</DataText>
            </View>
            <Avatar name={view.theirName} size={avatarSize.vs} />
          </View>
        </Slip>
        <View style={styles.center}>
          {phase === 'locked' ? (
            <StatusHero mark="check" title={t(COPY.live.locked)} loud />
          ) : phase === 'filming' ? (
            <StatusHero
              title={
                performerIsMe
                  ? t(COPY.live.yourTurn)
                  : fill.turn(view.performerName ?? view.theirName)
              }
              detail={`${t(COPY.live.filming)} · ${attemptNo}`}
              loud
            />
          ) : (
            // The judge is looking at it: the orb, breathing.
            <View style={styles.judging}>
              <JudgeOrb size={JUDGING_ORB} listening label={t(COPY.ruling.judge)} />
              <DotsLabel text={t(COPY.live.judging)} variant="subtitle" />
            </View>
          )}
        </View>
        {onStart && phase === 'locked' ? (
          <PrimaryButton
            testID="live-start"
            label={t(COPY.live.start)}
            busy={startBusy}
            onPress={onStart}
          />
        ) : null}
      </Page>
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------

type CamPhase = 'standby' | 'countdown' | 'recording' | 'sending' | 'sent';

/** The server's attempt.started for this device: count down to go_at, record at most max_ms. */
export interface CamArm {
  /** attempt_no; a new value re-arms the camera. */
  attemptNo: number;
  /** go_at on this phone's clock (ms). */
  goAtMs: number;
  maxMs: number;
}

/**
 * What a finished recording hands back: the clip file, how long it really ran (from the camera's
 * first progress event to Stop: ../attempt/span), and when it ended.
 */
export interface Clip {
  uri: string;
  durationMs: number;
  endedAtMs: number;
}

/** The judge's sphere while it deliberates on the live screen. */
const JUDGING_ORB = 88;

/** The appeal window the ruling counts down (SCHEMAS §9.3, 10 s demo). */
const APPEAL_WINDOW_MS = 10_000;

/** Recording ceiling (TASKS D3-M1 maxDuration 6). */
const MAX_RECORD_MS = 6000;

/**
 * expo-camera records the clip (FINDINGS §3.3, codec avc1, maxDuration 6). Without `arm` (the
 * preview) the operator starts it; with `arm` the server's attempt.started does, counting down
 * to go_at. `onSend` gets the clip (null when nothing was recorded) and does the frames.
 */
export function JudgeCamScreen({
  onBack,
  onSend,
  arm,
  tag,
}: {
  onBack?: (() => void) | undefined;
  onSend: (clip: Clip | null) => Promise<void>;
  /** undefined = preview (manual start); null = waiting for the server; set = armed. */
  arm?: CamArm | null;
  tag?: string | undefined;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<CamPhase>('standby');
  const [count, setCount] = useState(3);
  const [ready, setReady] = useState(false);
  /** The camera failed to start, or it started with no lens (the simulator). */
  const [noCamera, setNoCamera] = useState(false);
  const [failed, setFailed] = useState(false);
  const cam = useRef<CameraView | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recording = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const startedAt = useRef(0);
  /** The camera's first progress event (when the file began) and when recordAsync resolved. */
  const firstProgress = useRef<{ atMs: number; durationS: number } | null>(null);
  const finishedAt = useRef<number | null>(null);
  const armedFor = useRef<number | null>(null);
  /** The last recorded clip of this arm, kept so "Try again" can resend it after a failed upload. */
  const lastClip = useRef<Clip | null>(null);
  /** A retake counts down on its own clock (go_at is already past). */
  const manualCountdown = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  // Server-armed: count down to go_at (whole seconds, at most 3).
  useEffect(() => {
    if (!arm || armedFor.current === arm.attemptNo) return;
    armedFor.current = arm.attemptNo;
    lastClip.current = null;
    manualCountdown.current = false;
    setFailed(false);
    setCount(Math.min(3, Math.max(0, Math.ceil((arm.goAtMs - Date.now()) / 1000))));
    setPhase('countdown');
  }, [arm]);

  useEffect(() => {
    if (phase !== 'countdown') return;
    if (count === 0) {
      setPhase('recording');
      return;
    }
    const wait =
      arm && !manualCountdown.current
        ? Math.max(0, Math.min(1000, arm.goAtMs - (count - 1) * 1000 - Date.now()))
        : 800;
    const tm = setTimeout(() => setCount((c) => c - 1), wait);
    return () => clearTimeout(tm);
  }, [phase, count, arm]);

  const stop = useCallback(async () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    setPhase('sending');
    let clip: Clip | null = null;
    try {
      const pending = recording.current;
      recording.current = null;
      if (pending) {
        // The clip ends now, not when the file is finalized (../attempt/span).
        const stopAtMs = Date.now();
        cam.current?.stopRecording();
        const out = await pending;
        if (out?.uri)
          clip = {
            uri: out.uri,
            ...recordedSpan({
              requestedAtMs: startedAt.current,
              firstProgress: firstProgress.current,
              stopAtMs,
              finishedAtMs: finishedAt.current,
              maxMs: MAX_RECORD_MS,
            }),
          };
      }
      lastClip.current = clip;
      await onSend(clip);
      setPhase('sent');
    } catch {
      setFailed(true);
      setPhase('sent');
    }
  }, [onSend]);

  // "Try again": resend the same clip, retake it, or back to standby (../attempt/retry).
  const retry = useCallback(async () => {
    const action = camRetryAction({ armed: !!arm, hasClip: lastClip.current !== null });
    setFailed(false);
    if (action === 'standby') {
      setPhase('standby');
      return;
    }
    if (action === 'retake') {
      manualCountdown.current = true;
      setCount(3);
      setPhase('countdown');
      return;
    }
    setPhase('sending');
    try {
      await onSend(lastClip.current);
      setPhase('sent');
    } catch {
      setFailed(true);
      setPhase('sent');
    }
  }, [arm, onSend]);

  // Start the camera recording on GO; Stop (or max_ms, at most 6 s) ends it.
  useEffect(() => {
    if (phase !== 'recording') return;
    const camera = cam.current;
    if (camera && ready && !recording.current) {
      startedAt.current = Date.now();
      firstProgress.current = null;
      finishedAt.current = null;
      recording.current = camera
        .recordAsync({
          codec: 'avc1',
          maxDuration: MAX_RECORD_MS / 1000,
          // the first event (~100 ms in) dates the start of the file
          progressUpdateInterval: 0.1,
        })
        .then((out) => {
          finishedAt.current ??= Date.now();
          return out;
        });
    }
    const limit = Math.min(MAX_RECORD_MS, arm?.maxMs ?? MAX_RECORD_MS);
    stopTimer.current = setTimeout(() => void stop(), limit);
    return () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
    };
  }, [phase, stop, ready, arm]);

  // No capture device (the simulator) or one that failed to start: say so on the stage.
  const bubble = noCamera
    ? t(COPY.judgeCam.noCamera)
    : phase === 'standby'
      ? t(COPY.judgeCam.standingBy)
      : phase === 'countdown'
        ? count === 0
          ? t(COPY.judgeCam.go)
          : String(count)
        : t(COPY.judgeCam.recording);

  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.judgeCam.title)} tag={tag} />
      <Page>
        {phase === 'sending' || phase === 'sent' ? (
          <Stage style={styles.centerStage}>
            {phase === 'sending' ? (
              <DotsLabel text={t(COPY.judgeCam.sending)} variant="subtitle" />
            ) : (
              <StatusHero
                mark={failed ? 'cross' : 'check'}
                title={t(failed ? COPY.ruling.retry : COPY.judgeCam.sent)}
              />
            )}
          </Stage>
        ) : permission?.granted ? (
          <Stage>
            <CameraView
              ref={cam}
              style={StyleSheet.absoluteFill}
              {...RECORDING_CAMERA}
              onCameraReady={() => {
                setReady(true);
                void hasCameraLens(cam.current).then((ok) => setNoCamera(!ok));
              }}
              onMountError={() => setNoCamera(true)}
              onRecordingProgress={(e) => {
                if (!firstProgress.current && e.duration > 0)
                  firstProgress.current = { atMs: Date.now(), durationS: e.duration };
              }}
            />
            {noCamera ? (
              // No lens (the simulator): the note sits in the middle of the stage, as on Scan.
              <View style={styles.stageMiddle} pointerEvents="none">
                <StageBubble prompt={bubble} centered />
              </View>
            ) : (
              <StageBubble prompt={bubble} recording={phase === 'recording'} />
            )}
            {phase === 'recording' ? (
              <View style={styles.shutterSlot}>
                <ShutterButton active label={t(COPY.judgeCam.stop)} onPress={() => void stop()} />
              </View>
            ) : null}
          </Stage>
        ) : (
          <Stage style={styles.centerStage}>
            <QuietButton
              label={t(COPY.scan.allowCamera)}
              onPress={() => void requestPermission()}
            />
          </Stage>
        )}
        <View style={styles.gapLg} />
        {phase === 'standby' && arm === undefined ? (
          <PrimaryButton
            testID="cam-start"
            label={t(COPY.judgeCam.start)}
            disabled={!permission?.granted}
            onPress={() => {
              setCount(3);
              setPhase('countdown');
            }}
          />
        ) : phase === 'sent' && (arm === undefined || failed) ? (
          <QuietButton
            testID="cam-retry"
            label={t(failed && arm ? COPY.ruling.retry : COPY.judgeCam.start)}
            onPress={() => void retry()}
          />
        ) : null}
      </Page>
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------

export function RulingScreen({
  view,
  result,
  reason,
  judgeLabel,
  title,
  note,
  detail,
  appealDeadlineMs,
  busy,
  alert,
  onGG,
  onAppeal,
  onRematch,
  rematchBusy = false,
  tag,
}: {
  view: BetView;
  result: MyResult;
  reason: string;
  /** Who ruled: "Judge" (default), "Gemini" for a market bet (Beat 6), "Announcer" for a dance. */
  judgeLabel?: string | undefined;
  /** The headline in place of RESULT_TITLE (a dance off's "Too close to call"). */
  title?: string | undefined;
  /** One line under the claim (a dance off's refund: "Both stakes go back."). */
  note?: string | null | undefined;
  /** Under the call: a dance off's per-move breakdown (../dance DanceResultBreakdown). */
  detail?: ReactNode;
  /** BetResolved.appeal_deadline (10 s window). */
  appealDeadlineMs: number;
  busy: boolean;
  alert?: string | null;
  onGG: () => void;
  /** Omitted when appeals are off (the live panel is cut from the demo): no "I appeal!". */
  onAppeal?: (() => void) | undefined;
  /** Double or nothing, once the bet is over (a void round's refund is done): DANCE-OFF §7. */
  onRematch?: (() => void) | undefined;
  rematchBusy?: boolean;
  tag?: string | undefined;
}) {
  const now = useNow(200);
  // The ruling's own moment (both phones); the payout haptic comes later, from DemoApp.
  useEffect(() => feel('ruled'), []);
  const left = appealDeadlineMs - now;
  // A moment, on both phones: the call in the serif on black, under an aurora of the result
  // (green won, red lost, white for no contest). The money waits for the payout.
  return (
    <MomentScreen
      aurora={result === 'won' ? 'in' : result === 'lost' ? 'out' : 'neutral'}
      top={<TopBar tag={tag} />}
      footer={
        <>
          <View>
            <InfoRow label={t(COPY.ruling.finalIn)} value={countdownLabel(left)} />
            <DrainBar endsAtMs={appealDeadlineMs} windowMs={APPEAL_WINDOW_MS} />
            <InfoRow label={t(COPY.live.pot)} value={view.potUsd} />
          </View>
          <AlertLine message={alert ?? null} />
          {result === 'lost' ? (
            <>
              {/* GG pays the other side now: a swipe up, the same deliberate gesture as the lock. */}
              <SwipeToConfirm
                testID="ruling-gg"
                label={t(COPY.ruling.gg)}
                hint={t(COPY.terms.swipeHint)}
                busy={busy}
                disabled={!canConcede(result, appealDeadlineMs, now)}
                onComplete={onGG}
              />
              {onAppeal && canAppeal(view, result, appealDeadlineMs, now) ? (
                <QuietButton
                  testID="ruling-appeal"
                  label={t(COPY.ruling.appeal)}
                  onPress={onAppeal}
                />
              ) : null}
            </>
          ) : onRematch ? (
            <PrimaryButton
              testID="ruling-rematch"
              label={t(COPY.rematch.button)}
              busy={rematchBusy}
              onPress={onRematch}
            />
          ) : (
            <View style={styles.waiting}>
              <DotsLabel text={t(COPY.ruling.waiting)} variant="value" />
            </View>
          )}
        </>
      }
    >
      <View style={styles.momentWords} accessibilityLiveRegion="polite">
        <MomentHeadline>{title ?? RESULT_TITLE[result]}</MomentHeadline>
        <DataText muted style={styles.centerText}>
          {view.claim}
        </DataText>
        {note ? <BodyText style={styles.centerText}>{note}</BodyText> : null}
      </View>
      {/* Why: the judge's own words, in its voice. */}
      <View style={styles.call}>
        <Label variant="small">{judgeLabel ?? t(COPY.ruling.judge)}</Label>
        <DataText variant="spokenSmall" style={styles.centerText}>
          {reason}
        </DataText>
      </View>
      {detail ? <View style={styles.detail}>{detail}</View> : null}
    </MomentScreen>
  );
}

export function RedoScreen({
  attemptNo,
  maxAttempts,
  tip,
  onReady,
  tag,
}: {
  attemptNo: number;
  maxAttempts: number;
  tip: string;
  onReady: () => void;
  tag?: string | undefined;
}) {
  useEffect(() => feel('redo'), []);
  return (
    <Screen>
      <TopBar tag={tag} />
      <Page>
        <StatusHero title={RESULT_TITLE.redo} loud />
        <AttemptDots current={attemptNo} total={maxAttempts} />
        <Section label={t(COPY.ruling.tip)}>
          <BodyText>{tip}</BodyText>
        </Section>
        <View style={styles.flex} />
        <PrimaryButton testID="redo-ready" label={t(COPY.ruling.ready)} onPress={onReady} />
      </Page>
    </Screen>
  );
}

export type PayoutPhase = 'processed' | 'confirmed' | 'reverted';

export function PayoutScreen({
  view,
  won,
  balanceCents,
  phase,
  onRetry,
  onHome,
  onRematch,
  rematchBusy = false,
  alert,
  tag,
}: {
  view: BetView;
  won: boolean;
  balanceCents: number;
  phase: PayoutPhase;
  onRetry: () => void;
  onHome: () => void;
  /** Double or nothing, once the bet is over (DANCE-OFF §7): any bet type, a new challenge. */
  onRematch?: (() => void) | undefined;
  rematchBusy?: boolean;
  alert?: string | null;
  tag?: string | undefined;
}) {
  // micro-USDC → cents, for the figure that counts up.
  const winCents = Number(BigInt(view.theirStake) / 10_000n);
  // The balance is one quiet grey line under the hero, never a second big figure.
  const balance = <BalanceLine cents={balanceCents} pending={won && phase === 'processed'} />;
  return (
    <MomentScreen
      top={<TopBar tag={tag} />}
      footer={
        phase === 'reverted' ? (
          <PrimaryButton label={t(COPY.ruling.retry)} onPress={onRetry} />
        ) : (
          <>
            {onRematch ? <AlertLine message={alert ?? null} /> : null}
            <PrimaryButton
              testID="payout-home"
              label={t(COPY.ruling.backHome)}
              disabled={won && phase === 'processed'}
              onPress={onHome}
            />
            {onRematch ? (
              <QuietButton
                testID="payout-rematch"
                label={t(COPY.rematch.button)}
                busy={rematchBusy}
                onPress={onRematch}
              />
            ) : null}
          </>
        )
      }
    >
      {won ? (
        phase === 'reverted' ? (
          // The same rhythm as won / lost: about 28 pt from the title to the balance line.
          <View style={styles.failedWords}>
            <StatusHero mark="cross" title={t(COPY.ruling.payoutFailed)} end />
            {balance}
          </View>
        ) : (
          // The signature: a giant green figure counting up under a green aurora.
          <MomentGroup glow="in">
            <MomentHeadline>{RESULT_TITLE.won}</MomentHeadline>
            <MomentMoney direction="in" cents={winCents} />
            {balance}
          </MomentGroup>
        )
      ) : (
        // The mirror image: red, static, the same aurora in red at a lower opacity.
        <MomentGroup glow="out">
          <MomentHeadline>{t(COPY.ruling.gg)}</MomentHeadline>
          <MomentMoney direction="out" text={signedUsd(`-${view.myStake}`)} />
          {balance}
        </MomentGroup>
      )}
      {won && phase !== 'reverted' ? (
        <View style={styles.payStatus}>
          {phase === 'processed' ? (
            <DotsLabel text={t(COPY.ruling.paying)} variant="value" />
          ) : (
            <Chip label={t(COPY.ruling.paid)} tone="accent" />
          )}
        </View>
      ) : null}
    </MomentScreen>
  );
}

// ---------------------------------------------------------------------------------------

export type TurnState = 'next' | 'now' | 'done';

export function HearingScreen({
  view,
  turns,
  myTurnOpen,
  turnEndsAtMs,
  judging,
  onTalkStart,
  onTalkEnd,
  tag,
}: {
  view: BetView;
  /** A's turn, then B's. */
  turns: readonly { name: string; state: TurnState }[];
  myTurnOpen: boolean;
  turnEndsAtMs: number | null;
  judging: boolean;
  onTalkStart: () => void;
  onTalkEnd: () => void;
  tag?: string | undefined;
}) {
  const now = useNow(200);
  const [talking, setTalking] = useState(false);
  const stateLabel: Record<TurnState, string> = {
    next: t(COPY.hearing.next),
    now: t(COPY.hearing.now),
    done: t(COPY.hearing.done),
  };
  return (
    <Screen>
      <TopBar title={t(COPY.hearing.title)} tag={tag} />
      <Page>
        <DataText variant="statement">{view.claim}</DataText>
        <View style={styles.turns}>
          {turns.map((tn) => (
            <View key={tn.name} style={styles.turn}>
              <Avatar name={tn.name} size={avatarSize.md} accent={tn.state === 'now'} />
              <DataText variant="rowMedium" style={styles.flex} lines={1}>
                {tn.name}
              </DataText>
              <Chip
                label={stateLabel[tn.state]}
                tone={tn.state === 'now' ? 'accent' : 'muted'}
                style={styles.rowChip}
              />
            </View>
          ))}
        </View>
        <View style={styles.center}>
          {judging ? (
            <DotsLabel text={t(COPY.hearing.judging)} variant="subtitle" />
          ) : turnEndsAtMs ? (
            // The turn clock: big thin tabular numerals.
            <Text style={type.display}>{countdownLabel(turnEndsAtMs - now)}</Text>
          ) : null}
        </View>
        {myTurnOpen ? (
          <Pressable
            testID="hearing-talk"
            accessibilityRole="button"
            accessibilityLabel={t(COPY.hearing.holdToTalk)}
            onPressIn={() => {
              setTalking(true);
              onTalkStart();
            }}
            onPressOut={() => {
              setTalking(false);
              onTalkEnd();
            }}
            style={styles.talk}
          >
            {/* The standard primary pill; while held, the hold's black sweep covers it. */}
            {talking ? <View style={styles.talkOn} pointerEvents="none" /> : null}
            <Label variant="button" style={styles.talkText}>
              {talking ? t(COPY.hearing.talking) : t(COPY.hearing.holdToTalk)}
            </Label>
          </Pressable>
        ) : null}
      </Page>
    </Screen>
  );
}

export type VoteState = 'voting' | 'upholds' | 'overturns' | 'abstains';

export function AppealScreen({
  seats,
  result,
  onContinue,
  tag,
}: {
  seats: readonly { name: string; vote: VoteState; reason: string | null }[];
  result: 'stands' | 'flipped' | null;
  onContinue: () => void;
  tag?: string | undefined;
}) {
  const voteLabel: Record<Exclude<VoteState, 'voting'>, string> = {
    upholds: t(COPY.appeal.upholds),
    overturns: t(COPY.appeal.overturns),
    abstains: t(COPY.appeal.abstains),
  };
  return (
    <Screen>
      <TopBar title={t(COPY.appeal.title)} tag={tag} />
      <Page>
        <View style={styles.seats}>
          {seats.map((s) => (
            <View key={s.name} style={styles.seat}>
              <View style={styles.seatHead}>
                <DataText variant="rowMedium" style={styles.flex}>
                  {s.name}
                </DataText>
                {s.vote === 'voting' ? (
                  <DotsLabel text={t(COPY.appeal.voting)} variant="small" align="end" />
                ) : (
                  <Chip
                    label={voteLabel[s.vote]}
                    tone={s.vote === 'overturns' ? 'accent' : 'muted'}
                    style={styles.rowChip}
                  />
                )}
              </View>
              {s.reason ? <DataText muted>{s.reason}</DataText> : null}
            </View>
          ))}
        </View>
        <View style={styles.center}>
          {result ? (
            <StatusHero
              mark={result === 'stands' ? undefined : 'check'}
              title={result === 'stands' ? t(COPY.appeal.stands) : t(COPY.appeal.flipped)}
              loud
            />
          ) : null}
        </View>
        <PrimaryButton label={t(COPY.appeal.continue)} disabled={!result} onPress={onContinue} />
      </Page>
    </Screen>
  );
}

export function MarketScreen({
  view,
  priceUsd,
  strikeUsd,
  side,
  expiryMs,
  replay = false,
  seedTrail,
  tag,
}: {
  view: BetView;
  priceUsd: string;
  /** Prices already seen, oldest first (the design preview's sample line); the live feed's ticks
   * are appended to it. */
  seedTrail?: readonly number[] | undefined;
  strikeUsd: string;
  /** "Up" or "Down": my side. */
  side: string;
  expiryMs: number;
  /** A REPLAY-feed bet (a recorded Gemini round): labelled. */
  replay?: boolean;
  tag?: string | undefined;
}) {
  const now = useNow(500);
  const trail = usePriceTrail(priceUsd, seedTrail);
  return (
    <Screen>
      <TopBar title={t(COPY.market.title)} tag={tag} />
      <Page>
        {replay ? (
          <View style={styles.chipSlot}>
            <Chip label={t(COPY.market.replay)} />
          </View>
        ) : null}
        <DataText variant="statement" style={replay ? styles.afterChip : undefined}>
          {view.claim}
        </DataText>
        {/* The price, Robinhood-style: grey label, big thin tabular numerals, then the ticks seen
            on this screen as a 2 pt line (green if up, red if down; hidden until two ticks). */}
        <View style={styles.priceBlock}>
          <Label variant="value">{t(COPY.market.price)}</Label>
          <RollingText text={priceUsd} style={type.balance} minScale={0.5} />
          <View style={styles.trail}>
            <Sparkline points={trail} />
          </View>
        </View>
        <View style={styles.rows}>
          <InfoRow label={t(COPY.market.strike)} value={strikeUsd} divider />
          <InfoRow label={t(COPY.market.side)} value={side} divider />
          <InfoRow label={t(COPY.market.odds)} value={view.odds ?? ''} divider />
          <InfoRow
            label={t(COPY.live.pot)}
            value={`${view.myStakeUsd} vs ${view.theirStakeUsd}`}
            divider
          />
          <InfoRow label={t(COPY.market.settlesIn)} value={countdownLabel(expiryMs - now)} />
        </View>
        <View style={styles.center}>
          <DotsLabel text={t(COPY.market.waiting)} variant="value" />
        </View>
      </Page>
    </Screen>
  );
}

/** Ticks kept for the market line: about two minutes at the feed's pace. */
const TRAIL_MAX = 120;

/**
 * The prices this screen has shown, oldest first (no new fetches: each new `priceUsd` the
 * screen receives is appended when it changes). "$97,312.50" → 97312.5; "—" is skipped.
 */
function usePriceTrail(priceUsd: string, seed?: readonly number[]): number[] {
  const [trail, setTrail] = useState<number[]>(() => [...(seed ?? [])]);
  useEffect(() => {
    const n = Number(priceUsd.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return;
    setTrail((prev) =>
      prev.at(-1) === n ? prev : [...prev, n].slice(Math.max(0, prev.length + 1 - TRAIL_MAX)),
    );
  }, [priceUsd]);
  return trail;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centerText: { textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.x2 },
  centerStage: { alignItems: 'center', justifyContent: 'center' },
  judging: { alignItems: 'center', gap: space.x1 },
  gapLg: { height: space.x3 },
  // Live
  vs: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pot: { alignItems: 'center', gap: half.x05 },
  shutterSlot: { position: 'absolute', left: 0, right: 0, bottom: space.x3 },
  // Moments (ruling, payout)
  momentWords: { alignSelf: 'stretch', alignItems: 'center', gap: space.x2 },
  /** The hero keeps 24 pt under its title; 4 more puts the balance ~28 pt below it. */
  failedWords: { alignSelf: 'stretch', alignItems: 'center', gap: half.x05 },
  call: { alignSelf: 'stretch', alignItems: 'center', gap: half.x05, paddingHorizontal: space.x2 },
  /** A dance off's breakdown, under the call. */
  detail: { alignSelf: 'stretch', marginTop: space.x2 },
  stageMiddle: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  /** "Paying…" / Paid, centred under the figure. */
  // A row, so the Chip's own alignSelf: 'flex-start' cannot pull it to the left edge.
  payStatus: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: space.x2,
  },
  waiting: { height: space.control, alignItems: 'center', justifyContent: 'center' },
  // Redo
  // Hearing
  turns: { marginTop: space.x3 },
  turn: {
    minHeight: space.row + space.x1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: half.x15 + half.x05,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.divider,
  },
  rowChip: { alignSelf: 'center' },
  talk: {
    height: space.control,
    borderRadius: radius.pill,
    backgroundColor: color.primaryAction,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  talkOn: {
    ...StyleSheet.absoluteFill,
    backgroundColor: palette.black,
    opacity: hold.progressOpacity,
  },
  talkText: { color: color.onPrimary },
  // Appeal
  seats: { marginTop: space.x1 },
  seat: {
    gap: space.x1,
    paddingVertical: space.x2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.divider,
  },
  seatHead: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  // Market
  chipSlot: { alignSelf: 'flex-start' },
  afterChip: { marginTop: half.x15 },
  priceBlock: { marginTop: space.x4, gap: half.x05 },
  trail: { marginTop: space.x2 },
  rows: { marginTop: space.x3 },
});
