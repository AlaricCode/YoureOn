// Beats 4-6 and the judge cam:
//   LiveScreen      after the lock: Locked → filming (try n) → judging (ARCHITECTURE §3.4)
//   JudgeCamScreen  the third phone: "3-2-1, Go", record up to 6 s with a big Stop, send the
//                   frames (TASKS D3-M1)
//   RulingScreen    the ruling with the 10 s window; the loser gets GG (tap + Face ID) and, on
//                   camera bets, "I appeal!" until 1 s before the window ends (D3-M2, D4-M3)
//   RedoScreen      "Run it back" with one filming tip (D3-M2)
//   PayoutScreen    the winner's payout at `processed`, pending tint until confirmed, revert
//                   after 5 s (SCHEMAS §9.2, API-CONTRACT §6.2); the loser's GG screen
//   HearingScreen   two 10 s push-to-talk turns, A then B (D4-M3, API-CONTRACT §2.11)
//   AppealScreen    the three-model panel voting live (D4-M3, SCHEMAS §7)
//   MarketScreen    a Gemini bet waiting for settlement (D4-M4)
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  canAppeal,
  canConcede,
  countdownLabel,
  RESULT_TITLE,
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
  Avatar,
  BalanceHeader,
  Card,
  Chip,
  DataText,
  DotsLabel,
  InfoRow,
  Page,
  Screen,
  Section,
  StatusHero,
  TopBar,
  useNow,
} from '../ui/parts';
import { palette, space, type } from '../ui/tokens';
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
  /** A's phone: the "Start" fallback for the judge's request_attempt (API-CONTRACT §2.9). */
  onStart?: (() => void) | undefined;
  startBusy?: boolean;
  tag?: string | undefined;
}) {
  const performerIsMe = view.performerName === view.myName;
  return (
    <Screen>
      <TopBar title={t(COPY.live.title)} tag={tag} />
      <Page>
        <DataText variant="title">{view.claim}</DataText>
        <Card style={styles.vs}>
          <Avatar name={view.myName} size={48} accent />
          <View style={styles.pot}>
            <Label variant="small">{t(COPY.live.pot)}</Label>
            <DataText variant="title">{view.potUsd}</DataText>
          </View>
          <Avatar name={view.theirName} size={48} />
        </Card>
        <View style={styles.center}>
          {phase === 'locked' ? (
            <StatusHero mark="check" title={t(COPY.live.locked)} />
          ) : phase === 'filming' ? (
            <StatusHero
              mark="ring"
              title={
                performerIsMe
                  ? t(COPY.live.yourTurn)
                  : fill.turn(view.performerName ?? view.theirName)
              }
              detail={`${t(COPY.live.filming)} · ${attemptNo}`}
            />
          ) : (
            <View style={styles.hero}>
              <DotsLabel text={t(COPY.live.judging)} variant="title" />
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

/** What a finished recording hands back: the clip file and how long it ran. */
export interface Clip {
  uri: string;
  durationMs: number;
  endedAtMs: number;
}

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
  const [failed, setFailed] = useState(false);
  const cam = useRef<CameraView | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recording = useRef<Promise<{ uri: string } | undefined> | null>(null);
  const startedAt = useRef(0);
  const armedFor = useRef<number | null>(null);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [permission, requestPermission]);

  // Server-armed: count down to go_at (whole seconds, at most 3).
  useEffect(() => {
    if (!arm || armedFor.current === arm.attemptNo) return;
    armedFor.current = arm.attemptNo;
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
    const wait = arm
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
        cam.current?.stopRecording();
        const out = await pending;
        const endedAtMs = Date.now();
        if (out?.uri) clip = { uri: out.uri, durationMs: endedAtMs - startedAt.current, endedAtMs };
      }
      await onSend(clip);
      setPhase('sent');
    } catch {
      setFailed(true);
      setPhase('sent');
    }
  }, [onSend]);

  // Start the camera recording on GO; Stop (or max_ms, at most 6 s) ends it.
  useEffect(() => {
    if (phase !== 'recording') return;
    const camera = cam.current;
    if (camera && ready && !recording.current) {
      startedAt.current = Date.now();
      recording.current = camera.recordAsync({ codec: 'avc1', maxDuration: MAX_RECORD_MS / 1000 });
    }
    const limit = Math.min(MAX_RECORD_MS, arm?.maxMs ?? MAX_RECORD_MS);
    stopTimer.current = setTimeout(() => void stop(), limit);
    return () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
    };
  }, [phase, stop, ready, arm]);

  const bubble =
    phase === 'standby'
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
              <DotsLabel text={t(COPY.judgeCam.sending)} variant="title" />
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
              facing="back"
              mode="video"
              mute
              videoQuality="720p"
              onCameraReady={() => setReady(true)}
            />
            <StageBubble prompt={bubble} recording={phase === 'recording'} />
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
          <QuietButton label={t(COPY.judgeCam.start)} onPress={() => setPhase('standby')} />
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
  appealDeadlineMs,
  busy,
  alert,
  onGG,
  onAppeal,
  tag,
}: {
  view: BetView;
  result: MyResult;
  reason: string;
  /** BetResolved.appeal_deadline (10 s window). */
  appealDeadlineMs: number;
  busy: boolean;
  alert?: string | null;
  onGG: () => void;
  /** Omitted when appeals are off (the live panel is cut from the demo): no "I appeal!". */
  onAppeal?: (() => void) | undefined;
  tag?: string | undefined;
}) {
  const now = useNow(200);
  const mark = result === 'won' ? 'check' : result === 'lost' ? 'cross' : 'ring';
  const left = appealDeadlineMs - now;
  return (
    <Screen>
      <TopBar tag={tag} />
      <Page>
        <StatusHero mark={mark} title={RESULT_TITLE[result]} detail={view.claim} />
        <Card>
          <Label variant="small" style={styles.cardLabel}>
            {t(COPY.ruling.judge)}
          </Label>
          <DataText>{reason}</DataText>
        </Card>
        <View style={styles.rows}>
          <InfoRow label={t(COPY.ruling.finalIn)} value={countdownLabel(left)} />
          <InfoRow label={t(COPY.live.pot)} value={view.potUsd} />
        </View>
        <View style={styles.flex} />
        <AlertLine message={alert ?? null} />
        {result === 'lost' ? (
          <>
            <PrimaryButton
              testID="ruling-gg"
              label={t(COPY.ruling.gg)}
              busy={busy}
              disabled={!canConcede(result, appealDeadlineMs, now)}
              onPress={onGG}
            />
            {onAppeal && canAppeal(view, result, appealDeadlineMs, now) ? (
              <>
                <View style={styles.gap} />
                <QuietButton
                  testID="ruling-appeal"
                  label={t(COPY.ruling.appeal)}
                  onPress={onAppeal}
                />
              </>
            ) : null}
          </>
        ) : (
          <View style={styles.waiting}>
            <DotsLabel text={t(COPY.ruling.waiting)} variant="label" />
          </View>
        )}
      </Page>
    </Screen>
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
  return (
    <Screen>
      <TopBar tag={tag} />
      <Page>
        <StatusHero
          mark="ring"
          title={RESULT_TITLE.redo}
          detail={`${attemptNo} / ${maxAttempts}`}
        />
        <Section label={t(COPY.ruling.tip)}>
          <Card>
            <BodyText>{tip}</BodyText>
          </Card>
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
  tag,
}: {
  view: BetView;
  won: boolean;
  balanceCents: number;
  phase: PayoutPhase;
  onRetry: () => void;
  onHome: () => void;
  tag?: string | undefined;
}) {
  const winAmount = view.theirStakeUsd;
  return (
    <Screen>
      <TopBar tag={tag} />
      <Page>
        <BalanceHeader cents={balanceCents} pending={won && phase === 'processed'} />
        <View style={styles.center}>
          {won ? (
            <StatusHero
              mark={phase === 'reverted' ? 'cross' : 'check'}
              title={phase === 'reverted' ? t(COPY.ruling.payoutFailed) : RESULT_TITLE.won}
              detail={phase === 'reverted' ? undefined : `+${winAmount}`}
            />
          ) : (
            <StatusHero mark="cross" title={t(COPY.ruling.gg)} detail={`−${view.myStakeUsd}`} />
          )}
          {won && phase !== 'reverted' ? (
            phase === 'processed' ? (
              <DotsLabel text={t(COPY.ruling.paying)} variant="label" />
            ) : (
              <Chip label={t(COPY.ruling.paid)} tone="accent" />
            )
          ) : null}
        </View>
        {phase === 'reverted' ? (
          <PrimaryButton label={t(COPY.ruling.retry)} onPress={onRetry} />
        ) : (
          <PrimaryButton
            testID="payout-home"
            label={t(COPY.ruling.backHome)}
            disabled={won && phase === 'processed'}
            onPress={onHome}
          />
        )}
      </Page>
    </Screen>
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
        <DataText variant="labelStrong">{view.claim}</DataText>
        <View style={styles.turns}>
          {turns.map((tn) => (
            <View key={tn.name} style={styles.turn}>
              <Avatar name={tn.name} size={36} accent={tn.state === 'now'} />
              <DataText style={styles.flex}>{tn.name}</DataText>
              <Chip label={stateLabel[tn.state]} tone={tn.state === 'now' ? 'accent' : 'muted'} />
            </View>
          ))}
        </View>
        <View style={styles.center}>
          {judging ? (
            <DotsLabel text={t(COPY.hearing.judging)} variant="title" />
          ) : turnEndsAtMs ? (
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
            style={[styles.talk, talking && styles.talkOn]}
          >
            <Label variant="labelStrong">
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
        {seats.map((s) => (
          <Card key={s.name} style={styles.seat}>
            <View style={styles.seatHead}>
              <DataText variant="labelStrong" style={styles.flex}>
                {s.name}
              </DataText>
              {s.vote === 'voting' ? (
                <DotsLabel text={t(COPY.appeal.voting)} variant="small" />
              ) : (
                <Chip
                  label={voteLabel[s.vote]}
                  tone={s.vote === 'overturns' ? 'accent' : 'muted'}
                />
              )}
            </View>
            {s.reason ? <DataText muted>{s.reason}</DataText> : null}
          </Card>
        ))}
        <View style={styles.center}>
          {result ? (
            <StatusHero
              mark={result === 'stands' ? 'ring' : 'check'}
              title={result === 'stands' ? t(COPY.appeal.stands) : t(COPY.appeal.flipped)}
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
  tag,
}: {
  view: BetView;
  priceUsd: string;
  strikeUsd: string;
  /** "Up" or "Down": my side. */
  side: string;
  expiryMs: number;
  tag?: string | undefined;
}) {
  const now = useNow(500);
  return (
    <Screen>
      <TopBar title={t(COPY.market.title)} tag={tag} />
      <Page>
        <DataText variant="labelStrong">{view.claim}</DataText>
        <View style={styles.priceBlock}>
          <Label variant="small">{t(COPY.market.price)}</Label>
          <Text style={type.display}>{priceUsd}</Text>
        </View>
        <View style={styles.rows}>
          <InfoRow label={t(COPY.market.strike)} value={strikeUsd} />
          <InfoRow label={t(COPY.market.side)} value={side} />
          <InfoRow label={t(COPY.market.odds)} value={view.odds ?? ''} />
          <InfoRow label={t(COPY.live.pot)} value={`${view.myStakeUsd} vs ${view.theirStakeUsd}`} />
          <InfoRow label={t(COPY.market.settlesIn)} value={countdownLabel(expiryMs - now)} />
        </View>
        <View style={styles.center}>
          <DotsLabel text={t(COPY.market.waiting)} variant="label" />
        </View>
      </Page>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.x2 },
  centerStage: { alignItems: 'center', justifyContent: 'center' },
  hero: { paddingVertical: space.x3 },
  gap: { height: space.x1 },
  gapLg: { height: space.x2 },
  vs: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.x3,
  },
  pot: { alignItems: 'center' },
  shutterSlot: { position: 'absolute', left: 0, right: 0, bottom: space.x2 },
  cardLabel: { marginBottom: 4, color: palette.accent },
  rows: { marginTop: space.x2 },
  waiting: { height: space.control, alignItems: 'center', justifyContent: 'center' },
  turns: { marginTop: space.x3, gap: space.x1 },
  turn: { flexDirection: 'row', alignItems: 'center', gap: space.x2, paddingVertical: 4 },
  talk: {
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  talkOn: { backgroundColor: palette.accent },
  seat: { marginTop: space.x2, gap: 4 },
  seatHead: { flexDirection: 'row', alignItems: 'center' },
  priceBlock: { marginTop: space.x3 },
});
