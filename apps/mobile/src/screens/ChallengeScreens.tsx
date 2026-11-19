// Beat 1 and Beat 2 screens:
//   ScanScreen       point the camera at a friend → "Challenge Jake?" with the head-to-head
//                    record (TASKS D4-M1, D4-M2; ARCHITECTURE §3.1, §3.7). No confident match
//                    shows "No match" and the room list (the face_pick_list fallback, §7.1).
//   IncomingScreen   B's full-screen "Logan challenged you" with a haptic (D1-M4, D1-M6).
//                    Accept is not an authorization (API-CONTRACT §2.5).
//   NegotiateScreen  the judge negotiating the terms out loud, with live captions and the draft
//                    terms as they firm up (D2-M3; ARCHITECTURE §3.2). On A's phone, "Type it
//                    instead" swaps the judge for a short form (claim + stake, app/typedTerms):
//                    the card still arrives by the terms.proposed push; "Lock it in" confirms.
//                    "Bet on Bitcoin" (Beat 6, app/marketTerms) swaps in the market panel: Up or
//                    Down, a stake, Gemini's live odds and the fair split, then the same card.
//                    "Dance off" (app/danceTerms, DANCE-OFF §6.2) swaps in the dance panel: one of
//                    the bundled routines and an even stake, then the same card.
import { File } from 'expo-file-system';
import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Camera, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';

import {
  cameraActive,
  initialScan,
  scanReducer,
  showsFallbackList,
  type ChallengeResult,
  type ScanMatch,
  type ScanOutcome,
} from '../app/scan';
import { feel } from '../device/feedback';
import { useVisionCameraPresence } from '../device/visionCamera';
import { countdownLabel, signedUsd, type BetView } from '../bets/view';
import { TypedOdds, type TypedOddsPanel } from '../odds/OddsControl';
import { OfferCard, type OddsOfferPanel } from '../odds/OfferCard';
import type { PreviewUser } from '../preview/data';
import {
  AlertLine,
  Hairline,
  Label,
  PrimaryButton,
  QuietButton,
  ShutterButton,
  Stage,
  StageBubble,
  TextButton,
} from '../ui/kit';
import {
  Avatar,
  Card,
  Chip,
  DataText,
  DotsLabel,
  InfoRow,
  MomentHeadline,
  MomentScreen,
  Page,
  PresenceDot,
  Screen,
  TopBar,
  useNow,
} from '../ui/parts';
import { JudgeOrb } from '../ui/JudgeOrb';
import { StakePicker } from '../ui/StakePicker';
import {
  avatarSize,
  border,
  color,
  half,
  material,
  palette,
  radius,
  space,
  type,
} from '../ui/tokens';
import { WAKE_COPY, wt } from '../wake/copy';
import { COPY, fill, SCAN_MISS_COPY, t } from './copy';

/**
 * Point the camera at someone in the room, tap the shutter: the phone embeds the face it is
 * pointed at and the server answers with one opted-in member of this room, or nothing. The
 * photo is deleted right after the scan. A match shows "Challenge Jake?"; the tap addresses
 * the challenge to Jake (who still authorizes on his own phone). No match shows "No match" and
 * the room list, so the challenge is one tap away either way.
 */
export function ScanScreen({
  onBack,
  scan,
  onChallenge,
  members,
  onPickMember,
  onPickList,
  onOpen,
  tag,
  roomCode,
  lobby = false,
}: {
  onBack: () => void;
  /** Embeds the photo and runs the room-scoped match (app/scan runScan). */
  scan: (photoUrl: string) => Promise<ScanOutcome>;
  /** POST /v1/bets with challenge_method 'face' + the ticket; resolves how it went. */
  onChallenge: (match: ScanMatch) => Promise<ChallengeResult>;
  /** The fallback list: room members this phone can challenge (online, not me). */
  members: readonly PreviewUser[];
  /** A pick from the fallback list (challenge_method 'list'). */
  onPickMember: (user: PreviewUser) => void;
  /** "Pick from list": back to the room list. */
  onPickList: () => void;
  /** Called once when the screen opens (warm the model up). */
  onOpen?: (() => void) | undefined;
  tag?: string | undefined;
  /** This room's code, shown when nobody else is here to scan (never the lobby's). */
  roomCode?: string | undefined;
  /** The shared lobby (app/lobby): nobody else here means nobody else has the app open. */
  lobby?: boolean | undefined;
}) {
  const permission = useCameraPermission();
  // No camera (the simulator): <Camera> is never mounted (device/visionCamera).
  const presence = useVisionCameraPresence('back');
  const photoOutput = usePhotoOutput({ containerFormat: 'jpeg', quality: 0.9 });
  const outputs = useMemo(() => [photoOutput], [photoOutput]);
  const [state, dispatch] = useReducer(scanReducer, initialScan);
  const [asked, setAsked] = useState(false);
  const live = useRef(true);
  const opened = useRef(onOpen);

  useEffect(() => {
    live.current = true;
    opened.current?.();
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (permission.hasPermission || asked || !permission.canRequestPermission) return;
    setAsked(true);
    void permission.requestPermission();
  }, [permission, asked]);

  /** A scan or a challenge is running (a ref, so a double tap before the re-render is caught). */
  const busy = useRef(false);

  const shoot = async () => {
    if (busy.current || (state.phase !== 'idle' && state.phase !== 'found')) return;
    busy.current = true;
    dispatch({ type: 'scan' });
    let url: string | null = null;
    let outcome: ScanOutcome;
    try {
      const photo = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
      url = photo.filePath.startsWith('file://') ? photo.filePath : `file://${photo.filePath}`;
      outcome = await scan(url);
    } catch {
      outcome = { kind: 'miss', miss: 'failed' };
    } finally {
      // The photo is of someone else: it never outlives the scan (BRIEF 5e).
      if (url) deletePhoto(url);
      busy.current = false;
    }
    if (live.current) dispatch({ type: 'result', outcome });
  };

  const challenge = async (m: ScanMatch) => {
    if (busy.current || state.phase !== 'found') return;
    busy.current = true;
    dispatch({ type: 'challenge' });
    try {
      const r = await onChallenge(m);
      if (r !== 'ok' && live.current) dispatch({ type: 'challenge_failed', miss: r });
    } finally {
      busy.current = false;
    }
  };

  const found = state.phase === 'found' || state.phase === 'challenging' ? state.match : null;
  const checking = state.phase === 'checking';
  // Matching is room-scoped: in an empty room every scan is "No match", so say why instead.
  const alone = members.length === 0;
  const missLine = state.miss
    ? t(alone && state.miss === 'no_match' ? COPY.scan.emptyRoom : SCAN_MISS_COPY[state.miss])
    : null;
  const joinHint = !alone
    ? null
    : lobby
      ? t(COPY.scan.openApp)
      : roomCode
        ? fill.joinCode(roomCode)
        : null;
  const fallback = showsFallbackList(state);

  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.scan.title)} tag={tag} />
      <Page>
        {permission.hasPermission && presence !== 'present' ? (
          <Stage style={styles.center}>
            {presence === 'none' ? (
              <StageBubble prompt={t(COPY.judgeCam.noCamera)} centered />
            ) : null}
          </Stage>
        ) : permission.hasPermission ? (
          <Stage>
            <Camera
              style={StyleSheet.absoluteFill}
              device="back"
              isActive={cameraActive(state)}
              outputs={outputs}
            />
            <StageBubble prompt={t(COPY.scan.point)} checking={checking} />
            {!found ? (
              <View style={styles.shutterSlot}>
                <ShutterButton
                  onPress={() => void shoot()}
                  disabled={checking}
                  label={t(COPY.home.scan)}
                />
              </View>
            ) : null}
          </Stage>
        ) : (
          <Stage style={styles.center}>
            <View style={styles.access}>
              {permission.canRequestPermission ? (
                <QuietButton
                  label={t(COPY.scan.allowCamera)}
                  onPress={() => void permission.requestPermission()}
                />
              ) : (
                <QuietButton
                  label={t(COPY.scan.openSettings)}
                  onPress={() => void Linking.openSettings()}
                />
              )}
            </View>
          </Stage>
        )}
        <AlertLine
          testID="scan-alert"
          message={permission.hasPermission || !asked ? missLine : t(COPY.scan.cameraNeeded)}
        />
        {found ? (
          <Card style={styles.matchCard}>
            <Hairline style={styles.matchRule} />
            <View style={styles.matchHead}>
              <Avatar name={found.user.display_name} size={avatarSize.lg} />
              <View style={styles.matchText}>
                <DataText variant="subtitle">
                  {fill.challengeName(found.user.display_name)}
                </DataText>
                <DataText muted>
                  {fill.headToHead(
                    found.headToHead.wins,
                    found.headToHead.losses,
                    found.user.display_name,
                    signedUsd(found.headToHead.net),
                  )}
                </DataText>
              </View>
            </View>
            <PrimaryButton
              testID="scan-challenge"
              label={t(COPY.home.challenge)}
              busy={state.phase === 'challenging'}
              onPress={() => void challenge(found)}
            />
            <View style={styles.stackGap} />
            <QuietButton
              label={t(COPY.scan.notThem)}
              disabled={state.phase === 'challenging'}
              onPress={() => dispatch({ type: 'not_them' })}
            />
          </Card>
        ) : fallback ? (
          <View style={styles.fallback}>
            <Label variant="heading" style={styles.fallbackHead}>
              {t(COPY.scan.pickList)}
            </Label>
            <ScrollView style={styles.fallbackList}>
              {members.length === 0 ? (
                <DataText muted>{joinHint ?? t(COPY.home.empty)}</DataText>
              ) : (
                members.map((m, i) => (
                  <View
                    key={m.user_id}
                    style={[styles.member, i < members.length - 1 && styles.memberRule]}
                  >
                    <Avatar name={m.display_name} size={avatarSize.md} online={m.online} />
                    <DataText variant="heading" style={styles.flex} lines={1}>
                      {m.display_name}
                    </DataText>
                    <QuietButton
                      small
                      testID={`scan-pick-${m.user_id}`}
                      label={t(COPY.home.challenge)}
                      onPress={() => onPickMember(m)}
                    />
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        ) : (
          <>
            {joinHint ? <DataText muted>{joinHint}</DataText> : null}
            <QuietButton label={t(COPY.scan.pickList)} onPress={onPickList} />
          </>
        )}
      </Page>
    </Screen>
  );
}

function deletePhoto(url: string): void {
  try {
    new File(url).delete();
  } catch {
    // best effort: the OS clears the temp directory anyway
  }
}

export function IncomingScreen({
  challenger,
  roomName,
  rematch = false,
  onAccept,
  onDecline,
  tag,
}: {
  challenger: string;
  roomName: string;
  /** The invite follows a finished bet (bet.invited rematch_of): "Double or nothing". */
  rematch?: boolean;
  onAccept: () => void;
  onDecline: () => void;
  tag?: string | undefined;
}) {
  useEffect(() => feel('challengeArrived'), []);
  return (
    <MomentScreen
      aurora="neutral"
      top={<TopBar tag={tag} />}
      footer={
        <>
          <PrimaryButton
            testID="incoming-accept"
            label={t(COPY.incoming.accept)}
            onPress={onAccept}
          />
          <QuietButton
            testID="incoming-decline"
            label={t(COPY.incoming.decline)}
            onPress={onDecline}
          />
        </>
      }
    >
      {/* The challenger's disc, then the line in bold, in a column 32 pt in from each edge so
          "challenged you" never runs edge to edge. */}
      {rematch ? (
        <View style={styles.rematchTag} testID="incoming-rematch">
          <Chip label={t(COPY.rematch.incoming)} tone="accent" />
        </View>
      ) : null}
      <Avatar name={challenger} size={avatarSize.hero} />
      <MomentHeadline size="lg" lines={3} inset={space.x4}>
        {fill.challenged(challenger)}
      </MomentHeadline>
      {/* The room, with the green live dot: this is happening now, in the room. */}
      <View style={styles.live}>
        <PresenceDot online />
        <DataText muted lines={1}>
          {roomName}
        </DataText>
      </View>
    </MomentScreen>
  );
}

export interface Caption {
  who: 'judge' | 'a' | 'b';
  text: string;
}

/** A's "Bet on Bitcoin" panel (app/marketTerms MarketState, flattened for the screen). */
export interface MarketTermsPanel {
  open: boolean;
  side: 'UP' | 'DOWN';
  stakeUsd: number;
  stakes: readonly number[];
  /** null while the first quote is on its way. */
  quote: {
    ok: boolean;
    refusal: string | null;
    upPct: number | null;
    strikeUsd: string | null;
    priceUsd: string | null;
    /** "$6.10 vs $3.90" (mine first) */
    split: string | null;
    lockableUntilMs: number | null;
    /** The server's REPLAY feed (a recorded Gemini round): shown as such. */
    replay: boolean;
    /** Refused: when the next round opens (local clock), if known. */
    nextWindowMs: number | null;
  } | null;
  sending: boolean;
  confirming: boolean;
  canSubmit: boolean;
  canConfirm: boolean;
  waitingFor: string | null;
  note: string | null;
  onOpen: () => void;
  onClose: () => void;
  onSide: (side: 'UP' | 'DOWN') => void;
  onStake: (usd: number) => void;
  onSubmit: () => void;
  onConfirm: () => void;
}

/** A's "Dance off" panel (app/danceTerms DanceState, flattened for the screen). */
export interface DanceTermsPanel {
  open: boolean;
  /** The bundled routines (app/danceTerms DANCE_ROUTINE_CHOICES). */
  routines: readonly { id: string; title: string; song: string; bpm: number; seconds: number }[];
  routineId: string;
  stakeUsd: number;
  stakes: readonly number[];
  /** The claim the card will read (null while the pick is not a routine and an amount). */
  preview: string | null;
  sending: boolean;
  confirming: boolean;
  canSubmit: boolean;
  canConfirm: boolean;
  waitingFor: string | null;
  note: string | null;
  onOpen: () => void;
  onClose: () => void;
  onRoutine: (id: string) => void;
  onStake: (usd: number) => void;
  onSubmit: () => void;
  onConfirm: () => void;
}

/**
 * A's judge before it starts (app/wakeGate): it waits for "Jarvis" (../wake) or a tap. The line
 * is the wake status (wake/copy STATUS_COPY: 'Say “Jarvis”', 'Go ahead', 'Mic access off', …).
 */
export interface NegotiateWake {
  line: string | null;
  onTapToTalk: () => void;
  /** Only while the mic or speech permission is off: opens the Settings app. */
  onOpenSettings?: (() => void) | undefined;
}

/** A's typed-terms form (app/typedTerms TypedState, flattened for the screen). */
export interface TypedTermsPanel {
  mode: 'voice' | 'typed';
  /** The judge is available to switch back to. */
  canVoice: boolean;
  claim: string;
  stakeUsd: number;
  stakes: readonly number[];
  sending: boolean;
  confirming: boolean;
  canSubmit: boolean;
  /** The card this form sent is on screen and B accepted: show "Lock it in". */
  canConfirm: boolean;
  /** The card is on screen but B has not accepted yet: "Waiting for <name>" (disabled). */
  waitingFor: string | null;
  /** A judge line or short error from the server (already copy-checked). */
  note: string | null;
  onOpen: () => void;
  onVoice: () => void;
  onClaim: (text: string) => void;
  onStake: (usd: number) => void;
  onSubmit: () => void;
  onConfirm: () => void;
  /** The odds picker and "Suggest odds" (odds/useOdds useTypedOdds). */
  odds?: TypedOddsPanel | undefined;
}

export function NegotiateScreen({
  view,
  captions,
  speaking,
  hasMic,
  micMuted,
  draft,
  typed,
  market,
  dance,
  odds,
  wake,
  onBack,
  onDecline,
  tag,
  voice = true,
}: {
  view: Pick<BetView, 'myName' | 'theirName' | 'me'>;
  captions: readonly Caption[];
  /** The judge is talking (vs listening). */
  speaking: boolean;
  /** Only A's phone runs the voice session (ARCHITECTURE §3.2). */
  hasMic: boolean;
  micMuted: boolean;
  /** The proposed terms, once the judge reads them back; null while still negotiating. */
  draft:
    | (Pick<BetView, 'claim' | 'myStakeUsd' | 'theirStakeUsd'> &
        Partial<Pick<BetView, 'mySide' | 'ratio'>>)
    | null;
  /** Only on A's phone (only A sets the terms). */
  typed?: TypedTermsPanel | undefined;
  /** Only on A's phone, with the Gemini relay on: Beat 6. */
  market?: MarketTermsPanel | undefined;
  /** Only on A's phone, with EXPO_PUBLIC_DANCE on: the Dance Off panel. */
  dance?: DanceTermsPanel | undefined;
  /** Both phones: the odds offer / counter / judge's suggestion (odds/useOdds useOddsPanel). */
  odds?: OddsOfferPanel | undefined;
  /** Only on A's phone, while its judge waits for "Jarvis" or "Tap to talk". */
  wake?: NegotiateWake | undefined;
  onBack?: (() => void) | undefined;
  onDecline: () => void;
  tag?: string | undefined;
  /**
   * A voice judge runs (EXPO_PUBLIC_VOICE). Without one nobody is listening or reading back:
   * this phone waits for the typed terms, then for the other party to lock them in.
   */
  voice?: boolean;
}) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const nameOf = (who: Caption['who']) =>
    who === 'judge'
      ? t(COPY.ruling.judge)
      : (who === 'a') === (view.me === 'A')
        ? view.myName
        : view.theirName;

  const typing = typed?.mode === 'typed';
  const offerCard = odds ? <OfferCard panel={odds} /> : null;
  /** An odds offer (or its counter sheet, or the agreed odds) is showing, not just its buttons. */
  const offerOut = Boolean(odds && (odds.card || odds.counter || odds.agreed));
  /** A card is on the table: the judge's head becomes one compact row, the terms get the room. */
  const compact = offerOut || draft !== null;
  const draftCard = draft ? (
    <Card raised style={styles.draft}>
      <View style={styles.draftHead}>
        <Label variant="small">{t(COPY.negotiate.draft)}</Label>
        {typing || !voice ? null : <DotsLabel text={t(COPY.negotiate.readBack)} variant="small" />}
      </View>
      <DataText variant="statementSmall">{draft.claim}</DataText>
      <Hairline style={styles.draftRule} />
      <DataText variant="amount">
        {`${draft.myStakeUsd} vs ${draft.theirStakeUsd}${draft.ratio ? ` · ${draft.ratio}` : ''}${draft.mySide ? ` · you ${draft.mySide}` : ''}`}
      </DataText>
    </Card>
  ) : null;

  if (market?.open)
    return <MarketPanel market={market} draftCard={draftCard} onDecline={onDecline} tag={tag} />;
  if (dance?.open)
    return <DancePanel dance={dance} draftCard={draftCard} onDecline={onDecline} tag={tag} />;
  const danceOpen = dance ? (
    <QuietButton testID="dance-open" label={t(COPY.dance.open)} onPress={dance.onOpen} />
  ) : null;

  if (typed && typing)
    return (
      <Screen>
        <TopBar onBack={onBack} title={t(COPY.negotiate.title)} tag={tag} />
        {/* "Send terms" and "Lock it in" stay above the keyboard while the claim is edited. */}
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Page>
            <ScrollView
              style={styles.flex}
              contentContainerStyle={styles.form}
              keyboardShouldPersistTaps="handled"
            >
              <Label variant="small" style={styles.fieldLabel}>
                {t(COPY.negotiate.theBet)}
              </Label>
              <ClaimField
                testID="typed-claim"
                label={t(COPY.negotiate.theBet)}
                value={typed.claim}
                onChangeText={typed.onClaim}
                editable={!typed.sending && !typed.confirming}
              />
              <Label variant="small" style={styles.fieldLabel}>
                {t(COPY.negotiate.stake)}
              </Label>
              <StakePicker
                options={typed.stakes}
                value={typed.stakeUsd}
                onChange={typed.onStake}
                testIDPrefix="typed-stake-"
              />
              {typed.odds ? <TypedOdds panel={typed.odds} /> : null}
              {typed.note ? <DataText muted>{typed.note}</DataText> : null}
              {offerCard}
              {draftCard}
              {market ? (
                <QuietButton
                  testID="market-open"
                  label={t(COPY.market.open)}
                  onPress={market.onOpen}
                />
              ) : null}
              {danceOpen}
            </ScrollView>
            <View style={styles.actions}>
              {typed.canConfirm ? (
                <PrimaryButton
                  testID="typed-confirm"
                  label={t(COPY.negotiate.lockItIn)}
                  busy={typed.confirming}
                  onPress={typed.onConfirm}
                />
              ) : typed.waitingFor !== null ? (
                <PrimaryButton
                  testID="typed-waiting"
                  label={fill.waitingFor(typed.waitingFor)}
                  disabled
                  onPress={() => undefined}
                />
              ) : (
                <PrimaryButton
                  testID="typed-send"
                  label={t(COPY.negotiate.send)}
                  busy={typed.sending}
                  disabled={!typed.canSubmit}
                  onPress={typed.onSubmit}
                />
              )}
              {typed.canVoice ? (
                <QuietButton label={t(COPY.negotiate.useVoice)} onPress={typed.onVoice} />
              ) : null}
              <TextButton
                small
                tone="danger"
                label={t(COPY.negotiate.decline)}
                onPress={onDecline}
              />
            </View>
          </Page>
        </KeyboardAvoidingView>
      </Screen>
    );

  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.negotiate.title)} tag={tag} />
      <Page>
        <View style={compact ? styles.judgeHeadCompact : styles.judgeHead}>
          {/* With a card on the table the orb steps back, so the terms have the room. */}
          <JudgeOrb
            size={compact ? JUDGE_ORB_SMALL : JUDGE_ORB}
            speaking={speaking}
            listening={voice && !speaking}
            label={t(COPY.ruling.judge)}
          />
          <View style={compact ? styles.judgeStatusCompact : styles.judgeStatus}>
            {!voice ? (
              <DotsLabel
                text={draft ? fill.waitingFor(view.theirName) : t(COPY.negotiate.waitingTerms)}
                variant="value"
              />
            ) : speaking ? (
              <DotsLabel text={t(COPY.negotiate.speaking)} variant="value" />
            ) : wake ? (
              <Label testID="wake-line" variant="value">
                {wake.line ?? wt(WAKE_COPY.hint)}
              </Label>
            ) : (
              <DotsLabel text={t(COPY.negotiate.listening)} variant="value" />
            )}
            {hasMic && !wake ? (
              <Chip
                label={micMuted ? t(COPY.negotiate.micMuted) : t(COPY.negotiate.micOn)}
                tone={micMuted ? 'muted' : 'accent'}
                style={compact ? undefined : styles.chipCentred}
              />
            ) : null}
          </View>
        </View>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          contentContainerStyle={styles.captions}
          // What was just said is at the end; an odds offer is at the top, and it is what the
          // screen is asking about, so that is what stays in view.
          onContentSizeChange={() =>
            offerOut
              ? scroll.current?.scrollTo({ y: 0, animated: true })
              : scroll.current?.scrollToEnd({ animated: true })
          }
        >
          {/* With a card on the table only the line being said now stays, and none at all next
              to an odds offer (its card carries the judge's reason): the cards are the
              conversation's result, and they must fit on the screen. */}
          {(offerOut ? [] : compact ? captions.slice(-1) : captions).map((c, i) => (
            <View key={compact ? captions.length - 1 : i} style={styles.caption}>
              <DataText variant="small" muted>
                {nameOf(c.who)}
              </DataText>
              {c.who === 'judge' ? (
                <DataText variant="spoken">{c.text}</DataText>
              ) : (
                <DataText variant="row" style={styles.said}>
                  {c.text}
                </DataText>
              )}
            </View>
          ))}
          {/* The cards scroll with what was said, so nothing is ever pushed off the screen. */}
          {offerCard}
          {draftCard}
        </ScrollView>
        <View style={styles.actions}>
          {wake ? (
            <PrimaryButton
              testID="wake-tap"
              label={wt(WAKE_COPY.tapToTalk)}
              onPress={wake.onTapToTalk}
            />
          ) : null}
          {wake?.onOpenSettings ? (
            <TextButton
              small
              testID="wake-settings"
              label={wt(WAKE_COPY.openSettings)}
              onPress={wake.onOpenSettings}
            />
          ) : null}
          {typed ? (
            <QuietButton
              testID="typed-open"
              label={t(COPY.negotiate.typeIt)}
              onPress={typed.onOpen}
            />
          ) : null}
          {market ? (
            <QuietButton testID="market-open" label={t(COPY.market.open)} onPress={market.onOpen} />
          ) : null}
          {danceOpen}
          <TextButton small tone="danger" label={t(COPY.negotiate.decline)} onPress={onDecline} />
        </View>
      </Page>
    </Screen>
  );
}

/** Beat 6: Up or Down on Gemini's Bitcoin 5-minute contract, at Gemini's live odds. */
function MarketPanel({
  market,
  draftCard,
  onDecline,
  tag,
}: {
  market: MarketTermsPanel;
  draftCard: ReactNode;
  onDecline: () => void;
  tag?: string | undefined;
}) {
  const now = useNow(500);
  const q = market.quote;
  const frozen = market.sending || market.confirming;
  // The card (and a re-quote's "Odds moved") lands under the odds, below the fold on an iPhone 17
  // Pro: "Lock it in" sat under a card cut off mid-claim, or with only its "Draft terms" label
  // showing. Scroll it into view whenever it is there and the content grows.
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const hasCard = draftCard !== null;
  const upPct = q?.upPct ?? null;
  return (
    <Screen>
      <TopBar onBack={market.onClose} title={t(COPY.market.panel)} tag={tag} />
      <Page>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          contentContainerStyle={styles.form}
          onContentSizeChange={() => {
            if (hasCard) scroll.current?.scrollToEnd({ animated: true });
          }}
        >
          <View style={styles.sides} accessibilityRole="radiogroup">
            {(['UP', 'DOWN'] as const).map((side) => {
              const on = market.side === side;
              const pct = upPct === null ? null : side === 'UP' ? upPct : 100 - upPct;
              return (
                <Pressable
                  key={side}
                  testID={`market-side-${side}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: frozen }}
                  disabled={frozen}
                  onPress={() => market.onSide(side)}
                  style={({ pressed }) => [
                    styles.sideBox,
                    on && styles.sideOn,
                    frozen && styles.frozen,
                    pressed && !frozen && styles.pressed,
                  ]}
                >
                  <Text style={[type.labelMedium, !on && styles.offText]}>
                    {t(side === 'UP' ? COPY.market.up : COPY.market.down)}
                  </Text>
                  <Text style={[type.display, on ? styles.onPct : styles.offText]}>
                    {pct === null ? '—' : `${pct}%`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Label variant="small" style={styles.fieldLabel}>
            {t(COPY.market.stake)}
          </Label>
          <StakePicker
            options={market.stakes}
            value={market.stakeUsd}
            onChange={market.onStake}
            testIDPrefix="market-stake-"
            disabled={frozen}
          />
          <Card style={styles.marketCard}>
            <Hairline />
            {q === null ? (
              <DotsLabel text={t(COPY.market.pricing)} variant="small" />
            ) : q.ok ? (
              <>
                {q.replay ? (
                  <View style={styles.replay}>
                    <Chip label={t(COPY.market.replay)} />
                  </View>
                ) : null}
                <InfoRow label={t(COPY.market.split)} value={q.split ?? '—'} divider />
                <InfoRow label={t(COPY.market.line)} value={q.strikeUsd ?? '—'} divider />
                <InfoRow label={t(COPY.market.price)} value={q.priceUsd ?? '—'} divider />
                <InfoRow
                  label={t(COPY.market.closesIn)}
                  value={q.lockableUntilMs === null ? '—' : countdownLabel(q.lockableUntilMs - now)}
                />
              </>
            ) : (
              <>
                <DataText muted>{q.refusal ?? t(COPY.app.failed)}</DataText>
                {q.nextWindowMs !== null && q.nextWindowMs > now ? (
                  <InfoRow
                    label={t(COPY.market.nextRound)}
                    value={countdownLabel(q.nextWindowMs - now)}
                  />
                ) : null}
              </>
            )}
          </Card>
          {market.note ? <DataText muted>{market.note}</DataText> : null}
          {draftCard}
        </ScrollView>
        <View style={styles.actions}>
          {market.canConfirm ? (
            <PrimaryButton
              testID="market-confirm"
              label={t(COPY.negotiate.lockItIn)}
              busy={market.confirming}
              onPress={market.onConfirm}
            />
          ) : market.waitingFor !== null ? (
            <PrimaryButton
              testID="market-waiting"
              label={fill.waitingFor(market.waitingFor)}
              disabled
              onPress={() => undefined}
            />
          ) : (
            <PrimaryButton
              testID="market-send"
              label={t(COPY.market.propose)}
              busy={market.sending}
              disabled={!market.canSubmit}
              onPress={market.onSubmit}
            />
          )}
          {/* Two quiet exits, close together: "Back" white 17/500, "Back out" red 15/500. */}
          <View style={styles.exits}>
            <TextButton dense tone="plain" label={t(COPY.market.back)} onPress={market.onClose} />
            <TextButton
              dense
              small
              tone="danger"
              label={t(COPY.negotiate.decline)}
              onPress={onDecline}
            />
          </View>
        </View>
      </Page>
    </Screen>
  );
}

/**
 * Dance Off: one of the bundled routines (a card each: title, tempo; the chosen one is the
 * #1C1C1F tile with its tempo in green, like the market's side), an even stake, and the claim
 * the card will read. "Send terms" proposes; the card arrives by push; "Lock it in" confirms.
 */
function DancePanel({
  dance,
  draftCard,
  onDecline,
  tag,
}: {
  dance: DanceTermsPanel;
  draftCard: ReactNode;
  onDecline: () => void;
  tag?: string | undefined;
}) {
  const frozen = dance.sending || dance.confirming;
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const hasCard = draftCard !== null;
  return (
    <Screen>
      <TopBar onBack={dance.onClose} title={t(COPY.dance.panel)} tag={tag} />
      <Page>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          contentContainerStyle={styles.form}
          onContentSizeChange={() => {
            if (hasCard) scroll.current?.scrollToEnd({ animated: true });
          }}
        >
          <Label variant="small" style={styles.fieldLabel}>
            {t(COPY.dance.routine)}
          </Label>
          <View style={styles.routines} accessibilityRole="radiogroup">
            {dance.routines.map((r) => {
              const on = dance.routineId === r.id;
              return (
                <Pressable
                  key={r.id}
                  testID={`dance-routine-${r.id}`}
                  accessibilityRole="radio"
                  accessibilityLabel={r.title}
                  accessibilityState={{ selected: on, disabled: frozen }}
                  disabled={frozen}
                  onPress={() => dance.onRoutine(r.id)}
                  style={({ pressed }) => [
                    styles.routineCard,
                    on && styles.sideOn,
                    frozen && styles.frozen,
                    pressed && !frozen && styles.pressed,
                  ]}
                >
                  {/* Title, tempo, length only: no subtitle under a label (ui/copyRule rule 2). */}
                  <Text
                    style={[type.labelMedium, styles.flex, !on && styles.offText]}
                    numberOfLines={1}
                  >
                    {r.title}
                  </Text>
                  <Text style={[type.labelMedium, on ? styles.onPct : styles.offText]}>
                    {fill.routineMeta(r.bpm, r.seconds)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Label variant="small" style={styles.fieldLabel}>
            {t(COPY.dance.stake)}
          </Label>
          <StakePicker
            options={dance.stakes}
            value={dance.stakeUsd}
            onChange={dance.onStake}
            testIDPrefix="dance-stake-"
            disabled={frozen}
            // A double or nothing's suggestion can be cents ($4.96): "$4.96", never "$4.96000".
            format={(usd) => (Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`)}
          />
          {dance.preview && !hasCard ? (
            <Card style={styles.marketCard}>
              <Hairline />
              <Label variant="small">{t(COPY.dance.theBet)}</Label>
              <DataText variant="heading">{dance.preview}</DataText>
            </Card>
          ) : null}
          {dance.note ? <DataText muted>{dance.note}</DataText> : null}
          {draftCard}
        </ScrollView>
        <View style={styles.actions}>
          {dance.canConfirm ? (
            <PrimaryButton
              testID="dance-confirm"
              label={t(COPY.negotiate.lockItIn)}
              busy={dance.confirming}
              onPress={dance.onConfirm}
            />
          ) : dance.waitingFor !== null ? (
            <PrimaryButton
              testID="dance-waiting"
              label={fill.waitingFor(dance.waitingFor)}
              disabled
              onPress={() => undefined}
            />
          ) : (
            <PrimaryButton
              testID="dance-send"
              label={t(COPY.dance.propose)}
              busy={dance.sending}
              disabled={!dance.canSubmit}
              onPress={dance.onSubmit}
            />
          )}
          <View style={styles.exits}>
            <TextButton dense tone="plain" label={t(COPY.dance.back)} onPress={dance.onClose} />
            <TextButton
              dense
              small
              tone="danger"
              label={t(COPY.negotiate.decline)}
              onPress={onDecline}
            />
          </View>
        </View>
      </Page>
    </Screen>
  );
}

/**
 * The claim well: a #0F0F11 fill, radius 14, no outline; focused, a 1 pt green border (the kit
 * TextField's treatment, multi-line). Return puts the keyboard away instead of adding a line.
 */
function ClaimField({
  testID,
  label,
  value,
  onChangeText,
  editable,
}: {
  testID: string;
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  editable: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      testID={testID}
      accessibilityLabel={label}
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      multiline
      // One paragraph: Return puts the keyboard away instead of adding a line.
      returnKeyType="done"
      submitBehavior="blurAndSubmit"
      maxLength={200}
      autoCapitalize="sentences"
      keyboardAppearance="dark"
      selectionColor={palette.text}
      cursorColor={palette.text}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={[styles.claimField, { borderColor: focused ? color.borderFocused : 'transparent' }]}
    />
  );
}

// Limelight: content sits on black at the 20 pt margin; facts are hairline-divided rows, and
// only the things you could hold (the draft slip, a match) are soft panels. The judge is the orb.
/** The judge's sphere on the terms screen (its rings and halo scale with it). */
const JUDGE_ORB = 104;
/** The same once an offer or the draft is on the table. */
const JUDGE_ORB_SMALL = 44;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  stackGap: { height: half.x15 },
  actions: { gap: half.x15, paddingTop: space.x1, alignItems: 'stretch' },
  exits: { marginTop: -half.x05 },
  access: { alignSelf: 'stretch', paddingHorizontal: space.x3 },
  shutterSlot: { position: 'absolute', left: 0, right: 0, bottom: space.x3 },
  matchCard: { marginTop: space.x1 },
  matchRule: { marginBottom: space.x3 },
  matchHead: {
    flexDirection: 'row',
    gap: space.x2,
    alignItems: 'center',
    marginBottom: space.x3,
  },
  matchText: { flex: 1, gap: half.x05 },
  fallback: { maxHeight: space.x8 * 4 },
  fallbackHead: { marginBottom: space.x1 },
  fallbackList: { flexGrow: 0 },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: half.x15,
    minHeight: space.x8,
  },
  memberRule: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.divider },
  live: { flexDirection: 'row', alignItems: 'center', gap: space.x1, maxWidth: '100%' },
  judgeHead: { alignItems: 'center', gap: half.x15, paddingTop: space.x1, paddingBottom: space.x2 },
  judgeStatus: { alignItems: 'center', gap: half.x15 },
  // One row: the small orb (its halo is its own margin), then what it is doing and the mic.
  judgeHeadCompact: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  judgeStatusCompact: { alignItems: 'flex-start', gap: half.x05 + 2 },
  captions: { gap: space.x3, paddingVertical: space.x2 },
  caption: { gap: half.x05 },
  /** What a person said: grey, a step back from the judge's white line. */
  said: { color: palette.textSecondary },
  draft: { marginTop: space.x1, marginBottom: space.x1, gap: half.x15 },
  draftHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  draftRule: { marginTop: half.x05 },
  form: { gap: space.x1, paddingTop: space.x1, paddingBottom: space.x5 },
  fieldLabel: { marginTop: space.x2 },
  claimField: {
    ...type.input,
    minHeight: space.control * 2,
    borderRadius: radius.md,
    borderWidth: border.focused,
    backgroundColor: palette.surface,
    paddingHorizontal: space.x2,
    paddingTop: space.x2,
    paddingBottom: space.x2,
    textAlignVertical: 'top',
  },
  offText: { color: palette.textSecondary },
  onPct: { color: color.selected },
  frozen: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
  sides: { flexDirection: 'row', gap: half.x15 },
  // Up / Down: two soft tiles. The chosen one is a step lighter with its % in white; the other
  // is the plain panel with a grey %.
  sideBox: {
    flex: 1,
    height: space.control * 2,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: half.x05,
    backgroundColor: palette.surface,
  },
  sideOn: { backgroundColor: palette.rim, backgroundImage: material.glassRaised },
  chipCentred: { alignSelf: 'center' },
  replay: { alignItems: 'flex-start', paddingVertical: half.x15 },
  marketCard: { marginTop: space.x3 },
  // Dance Off: one row per routine (the chosen one is the soft grey tile).
  routines: { gap: half.x15 },
  routineCard: {
    minHeight: space.control + space.x2,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingHorizontal: space.x2,
    borderRadius: radius.lg,
    backgroundColor: palette.background,
  },
  rematchTag: { alignSelf: 'stretch', flexDirection: 'row', justifyContent: 'center' },
});
