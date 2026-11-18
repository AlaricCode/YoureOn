// Beat 3: the terms card and the lock (TASKS D2-M1, D2-M2, D2-M4; SCHEMAS §9.4; ARCHITECTURE
// §5.2). Both phones show the same card, rendered from the Terms alone. The hold stays off until
// the device policy passes; a full hold opens Face ID; "Decline" needs no Face ID and works until
// the second signature. The lock state lives in bets/lock.ts.
import { useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { declineEnabled, END_COPY, holdEnabled, type LockState } from '../bets/lock';
import { clockLabel, countdownLabel, type BetView } from '../bets/view';
import { AlertLine, CheckBadge, Label, PrimaryButton, TextButton } from '../ui/kit';
import {
  Appear,
  Avatar,
  Bullets,
  CountdownBar,
  DataText,
  DotsLabel,
  HoldToConfirm,
  InfoRow,
  MomentGroup,
  MomentHeadline,
  MomentScreen,
  Page,
  Reveal,
  Screen,
  Section,
  StatusHero,
  TopBar,
  useNow,
} from '../ui/parts';
import { avatarSize, color, half, palette, space, type } from '../ui/tokens';
import { COPY, fill, t } from './copy';

export function TermsCardScreen({
  view,
  lock,
  expiresAtMs,
  onHoldStart,
  onHoldComplete,
  onDecline,
  onContinue,
  tag,
}: {
  view: BetView;
  lock: LockState;
  /** AuthorizeRequest.expires_at: the accept countdown. */
  expiresAtMs: number;
  onHoldStart?: () => void;
  onHoldComplete: () => void;
  onDecline: () => void;
  /** After "Locked". */
  onContinue: () => void;
  tag?: string | undefined;
}) {
  const now = useNow(500);
  // The accept window as it stood when the card opened, for the draining bar.
  const windowMs = useRef(Math.max(1, expiresAtMs - Date.now())).current;
  const mine = lock.phase === 'signed' || lock.phase === 'locking';

  if (lock.phase === 'locked') {
    // The moment: the bet is on. Black, the word in thin white, the pot in thin white over a
    // soft green glow (a pot is not money moving up, so it is not green), "pot" in grey.
    // Headline and pot rise together (the one reveal); nothing else moves.
    return (
      <MomentScreen
        top={<TopBar tag={tag} />}
        footer={<PrimaryButton label={t(COPY.terms.continue)} onPress={onContinue} />}
      >
        {/* The glow is drawn first, behind the headline, so "Locked" stays pure white. */}
        <MomentGroup glow="in" style={styles.moment}>
          <MomentHeadline>{t(COPY.terms.locked)}</MomentHeadline>
          <Reveal style={styles.momentMoney}>
            <Text
              style={[type.money, styles.centerText]}
              accessibilityLabel={`${view.potUsd} pot`}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.5}
            >
              {view.potUsd}
              <Text style={styles.potWord}>{' pot'}</Text>
            </Text>
          </Reveal>
        </MomentGroup>
      </MomentScreen>
    );
  }

  const status = (() => {
    switch (lock.phase) {
      case 'checking':
        return <DotsLabel text={t(COPY.terms.checking)} variant="value" />;
      case 'locking':
        return <DotsLabel text={t(COPY.terms.locking)} variant="value" />;
      case 'signed':
        return <DataText style={styles.centerText}>{fill.youreIn(view.theirName)}</DataText>;
      default:
        return lock.theirsIn ? (
          <DataText style={styles.centerText}>{fill.theyreIn(view.theirName)}</DataText>
        ) : (
          <DataText muted style={styles.centerText}>
            {t(COPY.terms.nothingMoves)}
          </DataText>
        );
    }
  })();

  const alert =
    lock.phase === 'refused'
      ? t(COPY.terms.refused)
      : lock.authFailed
        ? t(COPY.terms.faceIdFailed)
        : lock.sendFailed
          ? t(COPY.app.failed)
          : null;

  return (
    <Screen>
      <TopBar title={t(COPY.terms.title)} tag={tag} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll}>
        <DataText variant="statement">{view.claim}</DataText>

        <View style={styles.parties}>
          <Party
            name={view.myName}
            label={t(COPY.terms.you)}
            stake={view.myStakeUsd}
            signed={mine}
            accent
          />
          <DataText muted style={styles.vs}>
            vs
          </DataText>
          <Party
            name={view.theirName}
            label={view.theirName}
            stake={view.theirStakeUsd}
            signed={lock.theirsIn}
          />
        </View>

        <Section label={t(COPY.terms.counts)}>
          <Bullets items={view.success} />
        </Section>
        {view.failure.length ? (
          <Section label={t(COPY.terms.doesnt)}>
            <Bullets items={view.failure} />
          </Section>
        ) : null}
        {view.edgeCases.length ? (
          <Section label={t(COPY.terms.edge)}>
            {view.edgeCases.map((e, i) => (
              <View key={i} style={styles.edge}>
                <DataText variant="labelStrong">{e.question}</DataText>
                <DataText muted>{e.answer}</DataText>
              </View>
            ))}
          </Section>
        ) : null}

        <View style={styles.rows}>
          {view.mySide ? <InfoRow label={t(COPY.market.side)} value={view.mySide} divider /> : null}
          {view.lineUsd ? (
            <InfoRow label={t(COPY.market.line)} value={view.lineUsd} divider />
          ) : null}
          <InfoRow label={t(COPY.terms.evidence)} value={view.evidence} divider />
          {view.kind === 'skill' ? (
            <InfoRow label={t(COPY.terms.tries)} value={view.attempts} divider />
          ) : null}
          {view.odds ? <InfoRow label={t(COPY.terms.odds)} value={view.odds} divider /> : null}
          <InfoRow label={t(COPY.terms.deadline)} value={clockLabel(view.deadline)} divider />
          <InfoRow label={t(COPY.terms.code)} value={view.termsCode} />
        </View>
      </ScrollView>

      <View style={styles.dock}>
        {/* The list fades out under the dock instead of being cut mid-line. */}
        <View style={styles.fade} pointerEvents="none">
          <Svg width="100%" height={FADE}>
            <Defs>
              <LinearGradient id="dockFade" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={palette.background} stopOpacity={0} />
                <Stop offset="1" stopColor={palette.background} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100%" height={FADE} fill="url(#dockFade)" />
          </Svg>
        </View>
        <InfoRow label={t(COPY.terms.timeLeft)} value={countdownLabel(expiresAtMs - now)} />
        <CountdownBar fraction={(expiresAtMs - now) / windowMs} />
        <View style={styles.status}>{status}</View>
        <AlertLine message={alert} testID="terms-alert" />
        {lock.phase === 'signed' || lock.phase === 'locking' ? null : (
          <HoldToConfirm
            testID="terms-hold"
            label={fill.holdToLock(view.myStakeUsd)}
            disabled={!holdEnabled(lock)}
            onStart={onHoldStart}
            onComplete={onHoldComplete}
          />
        )}
        <View style={styles.gap} />
        <TextButton
          tone="muted"
          testID="terms-decline"
          label={t(COPY.terms.decline)}
          disabled={!declineEnabled(lock) && lock.phase !== 'refused'}
          onPress={onDecline}
        />
      </View>
    </Screen>
  );
}

function Party({
  name,
  label,
  stake,
  signed = false,
  accent = false,
}: {
  name: string;
  label: string;
  stake: string;
  /** This party has locked in: a small tick on their avatar. */
  signed?: boolean;
  accent?: boolean;
}) {
  return (
    <View style={styles.party}>
      <View>
        <Avatar name={name} size={avatarSize.vs} accent={accent} />
        {signed ? (
          <Appear style={styles.signedTick}>
            <CheckBadge size={TICK} fill={palette.accent} />
          </Appear>
        ) : null}
      </View>
      <Label variant="labelMedium" style={styles.partyName}>
        {label}
      </Label>
      <DataText variant="figure" lines={1}>
        {stake}
      </DataText>
    </View>
  );
}

export function LockEndedScreen({
  reason,
  onHome,
  onReview,
  tag,
}: {
  reason: LockState['endReason'];
  onHome: () => void;
  onReview: () => void;
  tag?: string | undefined;
}) {
  const r = reason ?? 'declined';
  return (
    <Screen>
      <TopBar tag={tag} />
      <Page style={styles.center}>
        <StatusHero
          mark={r === 'terms_changed' ? undefined : 'cross'}
          title={END_COPY[r]}
          titleRole="contract"
          end
          neutral={r !== 'lock_failed'}
        />
      </Page>
      <Page style={styles.footer}>
        {r === 'terms_changed' ? (
          <PrimaryButton label={t(COPY.terms.review)} onPress={onReview} />
        ) : (
          <PrimaryButton label={t(COPY.terms.backHome)} onPress={onHome} />
        )}
      </Page>
    </Screen>
  );
}

const TICK = 20;
/** The fade at the dock's top edge. */
const FADE = space.x4;
/** The black cut-out between the signed tick and the avatar. */
const TICK_RING = 2;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  footer: { flex: 0 },
  gap: { height: space.x1 },
  moment: { alignSelf: 'stretch', alignItems: 'center', gap: space.x3 },
  momentMoney: { alignSelf: 'stretch' },
  // Room under the last line for the dock's fade, so it scrolls clear of it.
  scroll: { paddingHorizontal: space.page, paddingTop: space.x1, paddingBottom: space.x5 + FADE },
  // The two sides, flat on black between hairlines.
  parties: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: space.x3,
    paddingVertical: space.x3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: color.divider,
  },
  party: { flex: 1, alignItems: 'center', gap: half.x05 },
  /** On the avatars' centre line: 28 (half the 56 pt disc) less half the 22 pt line. */
  vs: { marginTop: avatarSize.vs / 2 - type.label.lineHeight / 2 },
  /** "pot" after the white figure: grey 22/400, no negative tracking. */
  potWord: { ...type.statement, color: palette.textSecondary, letterSpacing: 0 },
  partyName: { marginTop: half.x15 },
  signedTick: {
    position: 'absolute',
    right: -half.x05,
    bottom: -half.x05,
    borderRadius: TICK / 2 + TICK_RING,
    borderWidth: TICK_RING,
    borderColor: palette.background,
  },
  edge: { gap: half.x05, marginBottom: half.x15 },
  rows: {
    marginTop: space.x4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.divider,
  },
  // No hairline on top: the fade and the countdown bar already separate it from the list.
  dock: {
    paddingHorizontal: space.page,
    paddingTop: half.x05,
    paddingBottom: space.x1,
    backgroundColor: palette.background,
  },
  fade: { position: 'absolute', left: 0, right: 0, top: -FADE, height: FADE },
  status: { minHeight: space.x5, alignItems: 'center', justifyContent: 'center' },
});
