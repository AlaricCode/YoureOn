// "Call it off" (../app/callOff): a small text button in the top-left corner of every post-lock,
// pre-ruling screen (the top bar's left slot, empty on those screens), its confirm sheet, and
// the other phone's prompt. Drawn over the screen by DemoApp, so no screen changes its layout.
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Party } from '@youre-on/shared/primitives';

import { callOffName, callOffView, type CallOffView } from '../app/callOff';
import type { BetModel } from '../bets/store';
import { ConfirmSheet, Label, TextButton } from '../ui/kit';
import { useNow } from '../ui/parts';
import { half, palette, space } from '../ui/tokens';
import { COPY, fill, t } from './copy';

export function CallOffControl({
  view,
  theirName,
  askerName,
  busy,
  onAsk,
  onAnswer,
}: {
  view: CallOffView;
  /** The other party's display name (the confirm sheet: "{Other} has to agree"). */
  theirName: string;
  /** Who asked, when `view` is a prompt. */
  askerName: string;
  busy: boolean;
  /** "Call it off" confirmed on this phone: ask the other party. */
  onAsk: () => void;
  /** The other party asked: Agree (true) or Keep playing (false). */
  onAnswer: (agree: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const [confirming, setConfirming] = useState(false);
  if (view.kind === 'none') return null;
  return (
    <>
      {view.kind === 'ask' || view.kind === 'waiting' ? (
        <View
          style={[
            styles.corner,
            { top: insets.top + space.x1, left: insets.left + space.page - half.x15 },
          ]}
        >
          {view.kind === 'ask' ? (
            <TextButton
              testID="call-off"
              tone="muted"
              small
              dense
              label={t(COPY.callOff.button)}
              busy={busy}
              onPress={() => setConfirming(true)}
            />
          ) : (
            <View style={styles.waiting} testID="call-off-waiting">
              <Label variant="labelMedium" style={styles.muted}>
                {fill.waitingFor(theirName)}
              </Label>
            </View>
          )}
        </View>
      ) : null}
      <ConfirmSheet
        visible={confirming && view.kind === 'ask'}
        title={t(COPY.callOff.confirmTitle)}
        body={fill.callOffBody(theirName)}
        confirmLabel={t(COPY.callOff.button)}
        cancelLabel={t(COPY.callOff.keepPlaying)}
        busy={busy}
        onConfirm={() => {
          setConfirming(false);
          onAsk();
        }}
        onCancel={() => setConfirming(false)}
      />
      <ConfirmSheet
        visible={view.kind === 'prompt'}
        title={fill.callOffAsk(askerName)}
        body={t(COPY.callOff.refundBoth)}
        confirmLabel={t(COPY.callOff.agree)}
        cancelLabel={t(COPY.callOff.keepPlaying)}
        busy={busy}
        onConfirm={() => onAnswer(true)}
        onCancel={() => onAnswer(false)}
      />
    </>
  );
}

/**
 * The control for the bet on screen: the view from ../app/callOff on a 1 s clock (so a lapsed
 * request closes the prompt by itself), on the server's clock via `offsetMs`. `onCall` posts
 * POST /v1/bets/:id/call-off {agree}; its failure line goes to the app's alert.
 */
export function CallOffLayer({
  bet,
  me,
  judgeCam,
  offsetMs,
  onCall,
}: {
  bet: BetModel;
  me: Party;
  judgeCam: boolean;
  /** rt.clock.offsetMs: local + offset = the server's clock. */
  offsetMs: number;
  onCall: (agree: boolean) => Promise<void>;
}) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const view = callOffView(bet, { nowMs: now + offsetMs, judgeCam });
  const run = (agree: boolean) => {
    if (busy) return;
    setBusy(true);
    void onCall(agree).finally(() => setBusy(false));
  };
  const them: Party = me === 'A' ? 'B' : 'A';
  return (
    <CallOffControl
      view={view}
      theirName={callOffName(bet, them)}
      askerName={view.kind === 'prompt' ? callOffName(bet, view.by) : ''}
      busy={busy}
      onAsk={() => run(true)}
      onAnswer={run}
    />
  );
}

const styles = StyleSheet.create({
  corner: { position: 'absolute', zIndex: 10 },
  waiting: { height: space.x4, justifyContent: 'center', paddingHorizontal: half.x15 },
  muted: { color: palette.textSecondary },
});
