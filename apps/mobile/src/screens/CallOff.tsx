// "Call it off" (../app/callOff): a small text button in the top-left corner of every post-lock,
// pre-ruling screen (the top bar's left slot, empty on those screens), its confirm sheet, and
// the other phone's prompt. Drawn over the screen by DemoApp, so no screen changes its layout.
import { useEffect, useReducer, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Party } from '@youre-on/shared/primitives';

import {
  callOffConfirm,
  callOffCornerWidth,
  callOffLabels,
  callOffView,
  KEPT_PLAYING_NOTE_MS,
  keptPlayingBy,
  type CallOffGuard,
  type CallOffView,
} from '../app/callOff';
import type { BetModel } from '../bets/store';
import { ConfirmSheet, Label, TextButton } from '../ui/kit';
import { useNow } from '../ui/parts';
import { half, palette, radius, space } from '../ui/tokens';
import { COPY, fill, t } from './copy';

export function CallOffControl({
  view,
  theirName,
  askerName,
  keptPlaying = false,
  busy,
  onAsk,
  onAnswer,
}: {
  view: CallOffView;
  /** The other party's label (../app/callOffLabels; the confirm sheet: "{Other} has to agree"). */
  theirName: string;
  /** Who asked, when `view` is a prompt. */
  askerName: string;
  /** The other phone just tapped Keep playing on this phone's request: a short note. */
  keptPlaying?: boolean;
  busy: boolean;
  /** "Call it off" confirmed on this phone: ask the other party. */
  onAsk: () => void;
  /** The other party asked: Agree (true) or Keep playing (false). */
  onAnswer: (agree: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const left = insets.left + space.page - half.x15;
  // The sheet closes whenever the view leaves 'ask' (their request came in, the round started,
  // the upload landed): it never pops back up later without a tap.
  const [confirming, confirm] = useReducer(callOffConfirm, false);
  useEffect(() => confirm({ type: 'view', kind: view.kind }), [view.kind]);
  if (view.kind === 'none') return null;
  return (
    <>
      {keptPlaying ? (
        // Under the top bar, centred: the same raised pill as the app's toast.
        <View
          style={[styles.noteRow, { top: insets.top + space.x7 }]}
          pointerEvents="none"
          testID="call-off-kept-playing"
          accessibilityLiveRegion="polite"
        >
          <View style={styles.note}>
            <Label variant="labelMedium" lines={2} style={styles.noteText}>
              {fill.keptPlaying(theirName)}
            </Label>
          </View>
        </View>
      ) : null}
      {view.kind === 'ask' || view.kind === 'waiting' ? (
        // Never wider than the space left of the top bar's title: a long name's tail is cut.
        <View
          style={[
            styles.corner,
            { top: insets.top + space.x1, left, maxWidth: callOffCornerWidth(width, left) },
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
              onPress={() => confirm({ type: 'open' })}
            />
          ) : (
            <View style={styles.waiting} testID="call-off-waiting">
              <Label variant="labelMedium" style={styles.muted}>
                {fill.callOffWaiting(theirName)}
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
          confirm({ type: 'close' });
          onAsk();
        }}
        onCancel={() => confirm({ type: 'close' })}
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
 * POST /v1/bets/:id/call-off {agree, answer}; its failure line goes to the app's alert. `guard`
 * is the round running on this phone (../app/callOff CallOffGuard).
 */
export function CallOffLayer({
  bet,
  me,
  judgeCam,
  offsetMs,
  guard,
  onCall,
}: {
  bet: BetModel;
  me: Party;
  judgeCam: boolean;
  /** rt.clock.offsetMs: local + offset = the server's clock. */
  offsetMs: number;
  guard: CallOffGuard;
  /** `answer`: the prompt's Agree (never opens a request of this phone's own). */
  onCall: (agree: boolean, answer: boolean) => Promise<void>;
}) {
  const now = useNow(1000);
  const [busy, setBusy] = useState(false);
  const view = callOffView(bet, { nowMs: now + offsetMs, judgeCam, guard });
  // "Keep playing" on the other phone clears this phone's request: say so for a moment, instead
  // of the corner just flipping back to "Call it off".
  const prev = useRef(bet.callOff);
  const [keptUntil, setKeptUntil] = useState(0);
  useEffect(() => {
    if (keptPlayingBy(prev.current, bet.callOff, me))
      setKeptUntil(Date.now() + KEPT_PLAYING_NOTE_MS);
    prev.current = bet.callOff;
  }, [bet.callOff, me]);
  const run = (agree: boolean, answer: boolean) => {
    if (busy) return;
    setBusy(true);
    void onCall(agree, answer).finally(() => setBusy(false));
  };
  const them: Party = me === 'A' ? 'B' : 'A';
  const labels = callOffLabels(bet);
  return (
    <CallOffControl
      view={view}
      theirName={labels[them]}
      askerName={view.kind === 'prompt' ? labels[view.by] : ''}
      keptPlaying={now < keptUntil}
      busy={busy}
      onAsk={() => run(true, false)}
      onAnswer={(agree) => run(agree, agree)}
    />
  );
}

/**
 * A round screen reports where its round stands (../app/callOff CallOffGuard) to DemoApp, which
 * hands it to CallOffLayer; leaving the screen reports 'open'.
 */
export function useReportCallOffGuard(
  report: ((guard: CallOffGuard) => void) | undefined,
  guard: CallOffGuard,
): void {
  const ref = useRef(report);
  ref.current = report;
  useEffect(() => ref.current?.(guard), [guard]);
  useEffect(() => () => ref.current?.('open'), []);
}

const styles = StyleSheet.create({
  corner: { position: 'absolute', zIndex: 10 },
  noteRow: {
    position: 'absolute',
    zIndex: 10,
    left: space.page,
    right: space.page,
    alignItems: 'center',
  },
  note: {
    paddingVertical: half.x15,
    paddingHorizontal: space.x3,
    borderRadius: radius.pill,
    backgroundColor: palette.surface,
  },
  noteText: { textAlign: 'center' },
  waiting: { height: space.x4, justifyContent: 'center', paddingHorizontal: half.x15 },
  muted: { color: palette.textSecondary },
});
