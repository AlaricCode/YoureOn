// The odds offer on both phones' negotiate screen, above the draft card:
//   a party's offer   "Jake offers 3 to 1: your $5 to win $20"  Accept / Counter (Withdraw for
//                      the author), "Waiting on Jake" once my side is in.
//   the judge's offer "Judge suggests 3:1", the performer's record ("Bottle flips 10–2 · vs Logan
//                      4–7"), the judge's reason (in its serif voice), "31% for Jake", and "Demo
//                      history" when seed rows went into it. Both tap Accept: the judge never sets
//                      terms by itself.
//   agreed            "Odds agreed" until the card is locked in.
// With no offer out, the card's own row offers "Suggest odds" and "Offer odds".
import { StyleSheet, View } from 'react-native';

import type { OfferCardView } from '../app/odds';
import { COPY, fill, t } from '../screens/copy';
import { Label, PrimaryButton, QuietButton } from '../ui/kit';
import { Card, Chip, DataText, DotsLabel } from '../ui/parts';
import { radius, space } from '../ui/tokens';
import { OddsControlView, type OddsControlPanel } from './OddsControl';
import { SuggestButton, type SuggestPanel } from './SuggestButton';

export interface OddsOfferPanel {
  card: OfferCardView | null;
  /** The card's (unequal) stakes are agreed by both. */
  agreed: boolean;
  /** An odds call is in flight. */
  busy: boolean;
  /** A short server answer (copy-checked), or null. */
  note: string | null;
  /** The counter sheet, while it is open. */
  counter: OddsControlPanel | null;
  /** "Suggest odds" (the card is on the table, nothing open), else null. */
  suggest: SuggestPanel | null;
  /** "Offer odds": open the sheet with no offer out (the card is on the table). */
  canPropose: boolean;
  onAccept: () => void;
  onCounter: () => void;
  onSend: () => void;
  onCancel: () => void;
  onWithdraw: () => void;
}

export function OfferCard({ panel }: { panel: OddsOfferPanel }) {
  const c = panel.card;
  const sheet = panel.counter ? (
    <View style={styles.sheet}>
      <OddsControlView panel={panel.counter} />
      <PrimaryButton
        testID="odds-send"
        label={t(COPY.odds.send)}
        busy={panel.busy}
        onPress={panel.onSend}
      />
      <QuietButton label={t(COPY.odds.cancel)} disabled={panel.busy} onPress={panel.onCancel} />
    </View>
  ) : null;
  const note = panel.note ? <DataText muted>{panel.note}</DataText> : null;

  if (!c) {
    if (panel.agreed && !sheet)
      return (
        <Card raised style={styles.card}>
          <View style={styles.head}>
            <Label variant="small">{t(COPY.odds.title)}</Label>
            <Chip testID="odds-agreed" label={t(COPY.odds.oddsAgreed)} tone="accent" />
          </View>
          {note}
        </Card>
      );
    if (!panel.suggest && !panel.canPropose && !sheet) return note;
    return (
      <View style={styles.bare}>
        {sheet ?? (
          <View style={styles.actions}>
            {panel.suggest ? (
              <View style={styles.flex}>
                <SuggestButton panel={panel.suggest} />
              </View>
            ) : null}
            {panel.canPropose ? (
              <View style={styles.flex}>
                <QuietButton
                  testID="odds-propose"
                  label={t(COPY.odds.offer)}
                  disabled={panel.busy}
                  onPress={panel.onCounter}
                />
              </View>
            ) : null}
          </View>
        )}
        {note}
      </View>
    );
  }

  return (
    <Card raised style={styles.card}>
      {c.header ? (
        <View style={styles.head}>
          <Label variant="labelMedium">{c.header}</Label>
          <View style={styles.chips}>
            {c.judge?.demo ? <Chip testID="odds-demo" label={t(COPY.odds.demoHistory)} /> : null}
            {c.judge?.byDefault ? <Chip label={t(COPY.odds.byDefault)} /> : null}
          </View>
        </View>
      ) : null}
      {c.judge ? (
        <>
          <DataText muted>{c.judge.stats}</DataText>
          {/* Why: the judge's own words, in its voice. */}
          <DataText variant="spokenSmall">{`“${c.judge.reason}”`}</DataText>
          <DataText variant="labelMedium">{c.judge.chance}</DataText>
        </>
      ) : (
        <DataText variant="labelStrong">{c.title}</DataText>
      )}
      <DataText muted>{c.toWin}</DataText>
      {sheet ?? (
        <>
          {c.canAccept ? (
            <PrimaryButton
              testID="odds-accept"
              label={t(COPY.odds.accept)}
              busy={panel.busy}
              onPress={panel.onAccept}
            />
          ) : c.waitingOn ? (
            <DotsLabel text={fill.waitingOn(c.waitingOn)} variant="small" />
          ) : null}
          <View style={styles.actions}>
            {c.canCounter ? (
              <View style={styles.flex}>
                <QuietButton
                  testID="odds-counter"
                  label={t(COPY.odds.counter)}
                  disabled={panel.busy}
                  onPress={panel.onCounter}
                />
              </View>
            ) : null}
            {c.canWithdraw ? (
              <View style={styles.flex}>
                <QuietButton
                  testID="odds-withdraw"
                  label={t(COPY.odds.withdraw)}
                  disabled={panel.busy}
                  onPress={panel.onWithdraw}
                />
              </View>
            ) : null}
          </View>
        </>
      )}
      {note}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // A glass card one size down from a slip: it sits between the captions and the draft.
  card: { marginBottom: space.x1, gap: space.x1, borderRadius: radius.lg, padding: space.x2 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chips: { flexDirection: 'row', gap: space.x1 },
  actions: { flexDirection: 'row', gap: space.x1 },
  sheet: { gap: space.x1 },
  bare: { gap: space.x1, marginBottom: space.x1 },
});
