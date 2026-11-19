// The GG moment and the spoken review request on the phones (./model decides, this renders).
// Built only from ui/kit and ui/parts primitives and tokens, so a restyle of those flows through.
//
//   RulingReview    wraps the ruling screen. When someone asked the judge to check the ruling
//                   again, the loser's phone gets ReviewSheet over it at once; every other view
//                   gets a tag in the top bar ('Review requested', then 'Ruling stands').
//   ReviewSheet     the loser only: the ruling, a countdown to confirm_by, "Check it again" (the
//                   existing appeal: tap + Face ID, device policy 'appeal') and "Keep ruling".
//                   Closes by itself at confirm_by, on the GG, or once the appeal went out; the
//                   ruling screen (GG / I appeal) is then exactly as before.
//   GgPayoutScreen  after the loser's GG, a moment like the payout. Winner: "Jake said GG" in
//                   bold under a green aurora, the win counting up, the record ticking
//                   over, Paying -> Paid. Loser: a calm "Good game" under a faint white light.
//                   Either may go again: "Double or nothing" (app/rematch, DANCE-OFF §7) once
//                   it is paid.
import { useEffect, useReducer, useRef, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { BetGgPayload } from '@youre-on/shared/gg';
import type { Party } from '@youre-on/shared/primitives';

import { countdownLabel, type BetView } from '../bets/view';
import { feel } from '../device/feedback';
import { COPY, t } from '../screens/copy';
import { AlertLine, Label, PrimaryButton, QuietButton } from '../ui/kit';
import {
  Appear,
  BalanceLine,
  centsToUsd,
  Chip,
  CountdownBar,
  DataText,
  DotsLabel,
  InfoRow,
  MomentGroup,
  MomentHeadline,
  MomentScreen,
  TopBar,
  useNow,
} from '../ui/parts';
import { half, material, palette, radius, space, type } from '../ui/tokens';
import { FAILURE_COPY, GG_COPY, gt, saidGG, streakLabel } from './copy';
import {
  confirmFailureOf,
  countUp,
  ggWinCents,
  initialReviewUi,
  myRecord,
  recordLabel,
  reviewLayer,
  reviewUiReducer,
  type GgFields,
  type ReviewUi,
  type ReviewUiEvent,
} from './model';

// ---------------------------------------------------------------------------------------
// The ruling route: sheet or tag
// ---------------------------------------------------------------------------------------

type UiAction = { review_id: string; e: ReviewUiEvent };
const uiReducer = (s: ReviewUi, a: UiAction) => reviewUiReducer(s, a.review_id, a.e);

/**
 * Renders the ruling screen through `children(tag)` and layers the review on top. `confirm` is
 * the appeal (it throws on a cancelled Face ID, a policy refusal or a send error: the sheet stays
 * up and the window runs on); `decline` is POST …/review/decline.
 */
export function RulingReview({
  bet,
  me,
  offsetMs,
  reason,
  confirm,
  decline,
  children,
}: {
  bet: GgFields & { state: string | null };
  me: Party | null;
  /** Server − local clock offset (the runtime clock's offsetMs). */
  offsetMs: number;
  /** The ruling's reason (already passed through the copy rule). */
  reason: string;
  confirm: () => Promise<unknown>;
  decline: () => Promise<unknown>;
  children: (tag: string | undefined) => ReactNode;
}) {
  const now = useNow(250);
  const [ui, dispatch] = useReducer(uiReducer, initialReviewUi);
  const layer = reviewLayer(bet, me, ui, now, offsetMs);
  const sheetFor = layer?.kind === 'sheet' ? layer.review_id : null;

  // The loser's phone asks for attention once per review.
  const buzzed = useRef<string | null>(null);
  useEffect(() => {
    if (sheetFor && buzzed.current !== sheetFor) {
      buzzed.current = sheetFor;
      feel('challengeArrived');
    }
  }, [sheetFor]);

  const run = async (review_id: string) => {
    dispatch({ review_id, e: { type: 'confirm_start' } });
    try {
      await confirm();
      dispatch({ review_id, e: { type: 'confirm_sent' } });
    } catch (err) {
      feel('failed');
      dispatch({ review_id, e: { type: 'confirm_failed', reason: confirmFailureOf(err) } });
    }
  };
  const keep = async (review_id: string) => {
    dispatch({ review_id, e: { type: 'decline_start' } });
    // The sheet is gone either way: the server lapses an unanswered review at confirm_by.
    await decline().catch(() => undefined);
    dispatch({ review_id, e: { type: 'decline_done' } });
  };

  const tag =
    layer?.kind === 'tag'
      ? gt(layer.tag === 'asked' ? GG_COPY.reviewAsked : GG_COPY.stands)
      : undefined;
  return (
    <>
      {children(tag)}
      {layer?.kind === 'sheet' ? (
        <ReviewSheet
          reason={reason}
          leftMs={layer.confirmByMs - now}
          spanMs={layer.spanMs}
          busy={layer.busy}
          alert={layer.failure ? (FAILURE_COPY[layer.failure]?.[0] ?? null) : null}
          onCheck={() => void run(layer.review_id)}
          onKeep={() => void keep(layer.review_id)}
        />
      ) : null}
    </>
  );
}

export function ReviewSheet({
  reason,
  leftMs,
  spanMs,
  busy,
  alert,
  onCheck,
  onKeep,
}: {
  reason: string;
  leftMs: number;
  spanMs: number;
  busy: 'confirm' | 'decline' | null;
  alert: string | null;
  onCheck: () => void;
  onKeep: () => void;
}) {
  return (
    // Not a Modal: a soft sheet over the lower half of the ruling screen, so the result and the
    // reason stay readable above it and nothing else on screen (the preview strip) is covered.
    // It sits above everything on that screen (zIndex): the ruling's swipe pill raises itself,
    // and used to draw over this sheet's "Check it again".
    <Appear style={styles.sheet}>
      <View testID="review-sheet" accessibilityViewIsModal>
        <View style={styles.grabber} />
        <Label variant="heading">{gt(GG_COPY.review)}</Label>
        <View style={styles.gapLg} />
        {/* What is being reviewed: the judge's own words. */}
        <DataText variant="spokenSmall">{reason}</DataText>
        <View style={styles.rows}>
          <InfoRow label={gt(GG_COPY.confirmIn)} value={countdownLabel(leftMs)} />
          <CountdownBar fraction={leftMs / spanMs} />
        </View>
        <AlertLine message={alert} />
        <PrimaryButton
          testID="review-check"
          label={gt(GG_COPY.checkAgain)}
          busy={busy === 'confirm'}
          disabled={busy !== null}
          onPress={onCheck}
        />
        <View style={styles.gap} />
        <QuietButton
          testID="review-keep"
          label={gt(GG_COPY.keepRuling)}
          busy={busy === 'decline'}
          disabled={busy !== null}
          onPress={onKeep}
        />
      </View>
    </Appear>
  );
}

// ---------------------------------------------------------------------------------------
// After the GG
// ---------------------------------------------------------------------------------------

export function GgPayoutScreen({
  view,
  gg,
  me,
  balanceCents,
  phase,
  onHome,
  onRematch,
  rematchBusy = false,
  alert,
  tag,
}: {
  view: BetView;
  gg: BetGgPayload;
  me: Party;
  balanceCents: number;
  /** 'processed' until PAID (the pending tint, "Paying"), then 'confirmed'. */
  phase: 'processed' | 'confirmed';
  onHome: () => void;
  /** Double or nothing (the bet is over): a new challenge, any bet type, at twice the stake. */
  onRematch?: (() => void) | undefined;
  rematchBusy?: boolean;
  alert?: string | null;
  tag?: string | undefined;
}) {
  const now = useNow(50);
  const t0 = useRef(now).current;
  const won = gg.by !== me;
  const winCents = won ? ggWinCents(gg, me, view.myStake) : 0;
  const shownWin = countUp(0, winCents, t0 + 300, now);
  const rec = myRecord(gg, me, now - t0);
  // The record and its chips: the rivalry, under the money.
  const record = rec ? (
    <View style={styles.recordBlock}>
      <View style={styles.record} testID="gg-record">
        <Label style={styles.muted}>{gt(GG_COPY.record)}</Label>
        <Appear key={rec.ticked ? 'after' : 'before'}>
          <DataText variant="amount">{recordLabel(rec)}</DataText>
        </Appear>
      </View>
      {rec.first || rec.streak >= 2 ? (
        <View style={styles.chips}>
          {rec.first ? <Chip label={gt(GG_COPY.firstMeeting)} /> : null}
          {rec.streak >= 2 ? (
            <Chip label={`${gt(GG_COPY.streak)} ${streakLabel(rec.streak)}`} tone="accent" />
          ) : null}
        </View>
      ) : null}
    </View>
  ) : null;
  return (
    <MomentScreen
      aurora={won ? 'in' : 'neutral'}
      top={<TopBar tag={tag} />}
      footer={
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
      }
    >
      {won ? (
        // They conceded: the same moment as a payout.
        <MomentGroup>
          <MomentHeadline size="lg">{saidGG(view.theirName)}</MomentHeadline>
          <Text
            style={[type.money, styles.win]}
            testID="gg-win"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.5}
          >
            {`+${centsToUsd(shownWin)}`}
          </Text>
          <BalanceLine cents={balanceCents} pending={phase === 'processed'} />
        </MomentGroup>
      ) : (
        // A calm ending: no red field, the stake stated once in grey.
        <MomentGroup>
          <MomentHeadline size="lg">{gt(GG_COPY.goodGame)}</MomentHeadline>
          <DataText variant="amount" muted style={styles.centerText}>
            {`−${view.myStakeUsd}`}
          </DataText>
          <BalanceLine cents={balanceCents} />
        </MomentGroup>
      )}
      {record}
      {won ? (
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

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Over everything on the ruling screen, the swipe pill included.
    zIndex: 2,
    backgroundColor: palette.surface,
    backgroundImage: material.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.page,
    paddingTop: half.x15,
    paddingBottom: space.x5,
  },
  grabber: {
    alignSelf: 'center',
    width: space.x5,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.textTertiary,
    marginBottom: space.x2,
  },
  gap: { height: space.x1 },
  gapLg: { height: half.x15 },
  rows: { marginTop: space.x3 },
  centerText: { textAlign: 'center' },
  win: { color: palette.accent, textAlign: 'center', alignSelf: 'stretch' },
  recordBlock: { alignItems: 'center', gap: half.x15 },
  record: { flexDirection: 'row', alignItems: 'baseline', gap: half.x15 },
  muted: { color: palette.textSecondary },
  chips: { flexDirection: 'row', gap: space.x1 },
  // A row, so a Chip's own alignSelf: 'flex-start' cannot pull it to the left edge.
  payStatus: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'center' },
});
