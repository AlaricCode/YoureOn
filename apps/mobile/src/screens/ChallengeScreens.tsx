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
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
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
import { countdownLabel, signedUsd, type BetView } from '../bets/view';
import type { PreviewUser } from '../preview/data';
import {
  AlertLine,
  Label,
  PrimaryButton,
  QuietButton,
  ShutterButton,
  Stage,
  StageBubble,
} from '../ui/kit';
import {
  Avatar,
  Card,
  Chip,
  DataText,
  DotsLabel,
  InfoRow,
  Page,
  Screen,
  TopBar,
  useNow,
} from '../ui/parts';
import { color, palette, radius, space, type } from '../ui/tokens';
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
}) {
  const permission = useCameraPermission();
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
  const missLine = state.miss ? t(SCAN_MISS_COPY[state.miss]) : null;
  const fallback = showsFallbackList(state);

  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.scan.title)} tag={tag} />
      <Page>
        {permission.hasPermission ? (
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
            <View style={styles.matchHead}>
              <Avatar name={found.user.display_name} size={48} />
              <View style={styles.flex}>
                <DataText variant="heading">{fill.challengeName(found.user.display_name)}</DataText>
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
            <View style={styles.gap} />
            <QuietButton
              label={t(COPY.scan.notThem)}
              disabled={state.phase === 'challenging'}
              onPress={() => dispatch({ type: 'not_them' })}
            />
          </Card>
        ) : fallback ? (
          <View style={styles.fallback}>
            <Label variant="small" style={styles.fallbackHead}>
              {t(COPY.scan.pickList)}
            </Label>
            <ScrollView style={styles.fallbackList}>
              {members.length === 0 ? (
                <DataText muted>{t(COPY.home.empty)}</DataText>
              ) : (
                members.map((m) => (
                  <View key={m.user_id} style={styles.member}>
                    <Avatar name={m.display_name} size={32} online={m.online} />
                    <DataText style={styles.flex} lines={1}>
                      {m.display_name}
                    </DataText>
                    <View style={styles.memberAction}>
                      <QuietButton
                        testID={`scan-pick-${m.user_id}`}
                        label={t(COPY.home.challenge)}
                        onPress={() => onPickMember(m)}
                      />
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
          </View>
        ) : (
          <QuietButton label={t(COPY.scan.pickList)} onPress={onPickList} />
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
  onAccept,
  onDecline,
  tag,
}: {
  challenger: string;
  roomName: string;
  onAccept: () => void;
  onDecline: () => void;
  tag?: string | undefined;
}) {
  useEffect(() => feel('challengeArrived'), []);
  return (
    <Screen>
      <TopBar tag={tag} />
      <Page style={styles.center}>
        <Avatar name={challenger} size={112} accent />
        <DataText variant="display" style={styles.incomingTitle}>
          {fill.challenged(challenger)}
        </DataText>
        <DataText muted>{roomName}</DataText>
      </Page>
      <Page style={styles.footer}>
        <PrimaryButton
          testID="incoming-accept"
          label={t(COPY.incoming.accept)}
          onPress={onAccept}
        />
        <View style={styles.gap} />
        <QuietButton
          testID="incoming-decline"
          label={t(COPY.incoming.decline)}
          onPress={onDecline}
        />
      </Page>
    </Screen>
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
  onBack,
  onDecline,
  tag,
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
    | (Pick<BetView, 'claim' | 'myStakeUsd' | 'theirStakeUsd'> & Partial<Pick<BetView, 'mySide'>>)
    | null;
  /** Only on A's phone (only A sets the terms). */
  typed?: TypedTermsPanel | undefined;
  /** Only on A's phone, with the Gemini relay on: Beat 6. */
  market?: MarketTermsPanel | undefined;
  onBack?: (() => void) | undefined;
  onDecline: () => void;
  tag?: string | undefined;
}) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const nameOf = (who: Caption['who']) =>
    who === 'judge'
      ? t(COPY.ruling.judge)
      : (who === 'a') === (view.me === 'A')
        ? view.myName
        : view.theirName;

  const typing = typed?.mode === 'typed';
  const draftCard = draft ? (
    <Card style={styles.draft}>
      <View style={styles.draftHead}>
        <Label variant="small">{t(COPY.negotiate.draft)}</Label>
        {typing ? null : <DotsLabel text={t(COPY.negotiate.readBack)} variant="small" />}
      </View>
      <DataText variant="labelStrong">{draft.claim}</DataText>
      <DataText muted>
        {`${draft.myStakeUsd} vs ${draft.theirStakeUsd}${draft.mySide ? ` · you ${draft.mySide}` : ''}`}
      </DataText>
    </Card>
  ) : null;

  if (market?.open)
    return <MarketPanel market={market} draftCard={draftCard} onDecline={onDecline} tag={tag} />;

  if (typed && typing)
    return (
      <Screen>
        <TopBar onBack={onBack} title={t(COPY.negotiate.title)} tag={tag} />
        <Page>
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.form}
            keyboardShouldPersistTaps="handled"
          >
            <Label variant="small" style={styles.fieldLabel}>
              {t(COPY.negotiate.theBet)}
            </Label>
            <TextInput
              testID="typed-claim"
              accessibilityLabel={t(COPY.negotiate.theBet)}
              value={typed.claim}
              onChangeText={typed.onClaim}
              editable={!typed.sending && !typed.confirming}
              multiline
              maxLength={200}
              autoCapitalize="sentences"
              keyboardAppearance="dark"
              selectionColor={palette.accent}
              style={styles.claimField}
            />
            <Label variant="small" style={styles.fieldLabel}>
              {t(COPY.negotiate.stake)}
            </Label>
            <View style={styles.stakes} accessibilityRole="radiogroup">
              {typed.stakes.map((usd) => {
                const on = usd === typed.stakeUsd;
                return (
                  <Pressable
                    key={usd}
                    testID={`typed-stake-${usd}`}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => typed.onStake(usd)}
                    style={[styles.stake, on && styles.stakeOn]}
                  >
                    <Text style={[type.labelStrong, !on && styles.stakeOff]}>{`$${usd}`}</Text>
                  </Pressable>
                );
              })}
            </View>
            {typed.note ? <DataText muted>{typed.note}</DataText> : null}
            {draftCard}
            {market ? (
              <QuietButton
                testID="market-open"
                label={t(COPY.market.open)}
                onPress={market.onOpen}
              />
            ) : null}
          </ScrollView>
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
          <View style={styles.gap} />
          {typed.canVoice ? (
            <QuietButton label={t(COPY.negotiate.useVoice)} onPress={typed.onVoice} />
          ) : null}
          <QuietButton label={t(COPY.negotiate.decline)} onPress={onDecline} />
        </Page>
      </Screen>
    );

  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.negotiate.title)} tag={tag} />
      <Page>
        <View style={styles.judgeHead}>
          <View style={[styles.judgeRing, speaking && styles.judgeRingOn]}>
            <Label variant="heading">{t(COPY.ruling.judge)}</Label>
          </View>
          {speaking ? (
            <DotsLabel text={t(COPY.negotiate.speaking)} variant="label" />
          ) : (
            <DotsLabel text={t(COPY.negotiate.listening)} variant="label" />
          )}
          {hasMic ? (
            <Chip
              label={micMuted ? t(COPY.negotiate.micMuted) : t(COPY.negotiate.micOn)}
              tone={micMuted ? 'muted' : 'accent'}
            />
          ) : null}
        </View>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          contentContainerStyle={styles.captions}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {captions.map((c, i) => (
            <View key={i} style={styles.caption}>
              <DataText
                variant="small"
                style={c.who === 'judge' ? styles.judgeName : undefined}
                muted={c.who !== 'judge'}
              >
                {nameOf(c.who)}
              </DataText>
              <DataText>{c.text}</DataText>
            </View>
          ))}
        </ScrollView>
        {draftCard}
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
        <QuietButton label={t(COPY.negotiate.decline)} onPress={onDecline} />
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
  const upPct = q?.upPct ?? null;
  return (
    <Screen>
      <TopBar onBack={market.onClose} title={t(COPY.market.panel)} tag={tag} />
      <Page>
        <ScrollView style={styles.flex} contentContainerStyle={styles.form}>
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
                  style={[styles.sideBox, on && styles.sideOn]}
                >
                  <Text style={[type.heading, !on && styles.stakeOff]}>
                    {t(side === 'UP' ? COPY.market.up : COPY.market.down)}
                  </Text>
                  <Text style={[type.small, styles.stakeOff]}>
                    {pct === null ? '—' : `${pct}%`}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Label variant="small" style={styles.fieldLabel}>
            {t(COPY.market.stake)}
          </Label>
          <View style={styles.stakes} accessibilityRole="radiogroup">
            {market.stakes.map((usd) => {
              const on = usd === market.stakeUsd;
              return (
                <Pressable
                  key={usd}
                  testID={`market-stake-${usd}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: frozen }}
                  disabled={frozen}
                  onPress={() => market.onStake(usd)}
                  style={[styles.stake, on && styles.stakeOn]}
                >
                  <Text style={[type.labelStrong, !on && styles.stakeOff]}>{`$${usd}`}</Text>
                </Pressable>
              );
            })}
          </View>
          <Card style={styles.marketCard}>
            {q === null ? (
              <DotsLabel text={t(COPY.market.pricing)} variant="small" />
            ) : q.ok ? (
              <>
                {q.replay ? <Chip label={t(COPY.market.replay)} /> : null}
                <InfoRow label={t(COPY.market.split)} value={q.split ?? '—'} />
                <InfoRow label={t(COPY.market.line)} value={q.strikeUsd ?? '—'} />
                <InfoRow label={t(COPY.market.price)} value={q.priceUsd ?? '—'} />
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
        <View style={styles.gap} />
        <QuietButton label={t(COPY.market.back)} onPress={market.onClose} />
        <QuietButton label={t(COPY.negotiate.decline)} onPress={onDecline} />
      </Page>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  gap: { height: space.x1 },
  access: { alignSelf: 'stretch', paddingHorizontal: space.x3 },
  shutterSlot: { position: 'absolute', left: 0, right: 0, bottom: space.x2 },
  matchCard: { marginTop: space.x1 },
  fallback: { maxHeight: 220 },
  fallbackHead: { color: palette.textSecondary, marginBottom: space.x1 },
  fallbackList: { flexGrow: 0 },
  member: { flexDirection: 'row', alignItems: 'center', gap: space.x2, paddingVertical: 4 },
  memberAction: { width: 120 },
  matchHead: { flexDirection: 'row', gap: space.x2, alignItems: 'center', marginBottom: space.x2 },
  incomingTitle: { marginTop: space.x3, textAlign: 'center' },
  footer: { flex: 0 },
  judgeHead: { alignItems: 'center', gap: space.x1, paddingVertical: space.x2 },
  judgeRing: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 2,
    borderColor: palette.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
  judgeRingOn: { borderColor: palette.accent },
  captions: { gap: space.x2, paddingVertical: space.x2 },
  caption: { gap: 2 },
  judgeName: { color: palette.accent },
  draft: { marginBottom: space.x1, gap: space.x1, borderRadius: radius.lg },
  draftHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  form: { gap: space.x1, paddingVertical: space.x2 },
  fieldLabel: { color: palette.textSecondary, marginTop: space.x1 },
  claimField: {
    ...type.label,
    minHeight: space.control * 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    paddingHorizontal: space.x2,
    paddingVertical: space.x1,
    color: palette.text,
    textAlignVertical: 'top',
  },
  stakes: { flexDirection: 'row', gap: space.x1 },
  stake: {
    flex: 1,
    height: space.control,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stakeOn: { borderColor: palette.accent, backgroundColor: palette.surface },
  stakeOff: { color: palette.textSecondary },
  sides: { flexDirection: 'row', gap: space.x1 },
  sideBox: {
    flex: 1,
    height: space.control * 2,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  sideOn: { borderColor: palette.accent, backgroundColor: palette.surface },
  marketCard: { marginTop: space.x2, gap: space.x1, borderRadius: radius.lg },
});
