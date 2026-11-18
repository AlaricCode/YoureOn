// Beat 3: the terms card and the lock (TASKS D2-M1, D2-M2, D2-M4; SCHEMAS §9.4; ARCHITECTURE
// §5.2). Both phones show the same card, rendered from the Terms alone. The hold stays off until
// the device policy passes; a full hold opens Face ID; "Decline" needs no Face ID and works until
// the second signature. The lock state lives in bets/lock.ts.
import { useRef } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { declineEnabled, END_COPY, holdEnabled, type LockState } from '../bets/lock';
import { clockLabel, countdownLabel, type BetView } from '../bets/view';
import { AlertLine, Label, PrimaryButton, QuietButton } from '../ui/kit';
import {
  Appear,
  Avatar,
  Bullets,
  CountdownBar,
  Card,
  DataText,
  DotsLabel,
  HoldToConfirm,
  InfoRow,
  Page,
  Screen,
  Section,
  StatusBadge,
  StatusHero,
  TopBar,
  useNow,
} from '../ui/parts';
import { color, palette, space } from '../ui/tokens';
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
    return (
      <Screen>
        <TopBar tag={tag} />
        <Page style={styles.center}>
          <StatusHero
            mark="check"
            title={t(COPY.terms.locked)}
            detail={`${view.potUsd} pot`}
            pulse
          />
        </Page>
        <Page style={styles.footer}>
          <PrimaryButton label={t(COPY.terms.continue)} onPress={onContinue} />
        </Page>
      </Screen>
    );
  }

  const status = (() => {
    switch (lock.phase) {
      case 'checking':
        return <DotsLabel text={t(COPY.terms.checking)} variant="label" />;
      case 'locking':
        return <DotsLabel text={t(COPY.terms.locking)} variant="label" />;
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
        : null;

  return (
    <Screen>
      <TopBar title={t(COPY.terms.title)} tag={tag} />
      <ScrollView style={styles.flex} contentContainerStyle={styles.scroll}>
        <DataText variant="title">{view.claim}</DataText>

        <Card style={styles.parties}>
          <Party
            name={view.myName}
            label={t(COPY.terms.you)}
            stake={view.myStakeUsd}
            signed={mine}
            accent
          />
          <DataText muted>vs</DataText>
          <Party
            name={view.theirName}
            label={view.theirName}
            stake={view.theirStakeUsd}
            signed={lock.theirsIn}
          />
        </Card>

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
          <InfoRow label={t(COPY.terms.evidence)} value={view.evidence} />
          <InfoRow label={t(COPY.terms.tries)} value={view.attempts} />
          {view.odds ? <InfoRow label={t(COPY.terms.odds)} value={view.odds} /> : null}
          <InfoRow label={t(COPY.terms.deadline)} value={clockLabel(view.deadline)} />
          <InfoRow label={t(COPY.terms.code)} value={view.termsCode} />
        </View>
      </ScrollView>

      <View style={styles.dock}>
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
        <QuietButton
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
        <Avatar name={name} size={48} accent={accent} />
        {signed ? (
          <Appear style={styles.signedTick}>
            <StatusBadge mark="check" size={20} />
          </Appear>
        ) : null}
      </View>
      <Label>{label}</Label>
      <DataText variant="heading">{stake}</DataText>
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
          mark={r === 'terms_changed' ? 'ring' : 'cross'}
          title={END_COPY[r]}
          titleRole="contract"
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  footer: { flex: 0 },
  gap: { height: space.x1 },
  scroll: { paddingHorizontal: space.page, paddingBottom: space.x3 },
  parties: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginTop: space.x3,
  },
  party: { alignItems: 'center', gap: 4 },
  signedTick: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: palette.surface,
  },
  edge: { gap: 2, marginBottom: space.x1 },
  rows: {
    marginTop: space.x3,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.divider,
    paddingTop: space.x1,
  },
  dock: {
    paddingHorizontal: space.page,
    paddingTop: space.x1,
    paddingBottom: space.x2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.hairline,
    backgroundColor: palette.background,
  },
  status: { minHeight: space.x5, alignItems: 'center', justifyContent: 'center' },
});
