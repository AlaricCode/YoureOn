// Beat 1 and Beat 2 screens:
//   ScanScreen       point the camera at a friend → "Challenge Jake?" with the head-to-head
//                    record (TASKS D4-M1, D4-M2; ARCHITECTURE §3.1, §3.7). No confident match
//                    shows nothing. "Pick from list" is the face_pick_list fallback (§7.1).
//   IncomingScreen   B's full-screen "Logan challenged you" with a haptic (D1-M4, D1-M6).
//                    Accept is not an authorization (API-CONTRACT §2.5).
//   NegotiateScreen  the judge negotiating the terms out loud, with live captions and the draft
//                    terms as they firm up (D2-M3; ARCHITECTURE §3.2). On A's phone, "Type it
//                    instead" swaps the judge for a short form (claim + stake, app/typedTerms):
//                    the card still arrives by the terms.proposed push; "Lock it in" confirms.
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Camera, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';

import { feel } from '../device/feedback';
import { signedUsd, type BetView } from '../bets/view';
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
import { Avatar, Card, Chip, DataText, DotsLabel, Page, Screen, TopBar } from '../ui/parts';
import { color, palette, radius, space, type } from '../ui/tokens';
import { COPY, fill, t } from './copy';

export interface FaceMatch {
  user: PreviewUser;
  headToHead: { wins: number; losses: number; net: string };
}

export function ScanScreen({
  onBack,
  match,
  onChallenge,
  onPickList,
  tag,
}: {
  onBack: () => void;
  /** Runs the room-scoped match on a still (POST /v1/rooms/:id/face-match); null = no match. */
  match: () => Promise<FaceMatch | null>;
  onChallenge: (user: PreviewUser) => void;
  onPickList: () => void;
  tag?: string | undefined;
}) {
  const permission = useCameraPermission();
  const photoOutput = usePhotoOutput({ containerFormat: 'jpeg', quality: 0.9 });
  const outputs = useMemo(() => [photoOutput], [photoOutput]);
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<FaceMatch | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (permission.hasPermission || asked || !permission.canRequestPermission) return;
    setAsked(true);
    void permission.requestPermission();
  }, [permission, asked]);

  const scan = async () => {
    setChecking(true);
    try {
      // No confident match shows nothing and stores nothing (BRIEF 5e).
      setFound(await match());
    } finally {
      setChecking(false);
    }
  };

  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.scan.title)} tag={tag} />
      <Page>
        {permission.hasPermission ? (
          <Stage>
            <Camera
              style={StyleSheet.absoluteFill}
              device="back"
              isActive={!found}
              outputs={outputs}
            />
            <StageBubble prompt={t(COPY.scan.point)} checking={checking} />
            {!found ? (
              <View style={styles.shutterSlot}>
                <ShutterButton onPress={() => void scan()} disabled={checking} label="Scan" />
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
          message={permission.hasPermission || !asked ? null : t(COPY.scan.cameraNeeded)}
        />
        {found ? (
          <Card style={styles.matchCard}>
            <View style={styles.matchHead}>
              <Avatar name={found.user.display_name} size={48} online={found.user.online} />
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
              onPress={() => onChallenge(found.user)}
            />
            <View style={styles.gap} />
            <QuietButton label={t(COPY.scan.notThem)} onPress={() => setFound(null)} />
          </Card>
        ) : (
          <QuietButton label={t(COPY.scan.pickList)} onPress={onPickList} />
        )}
      </Page>
    </Screen>
  );
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
  /** The card this form sent is on screen: show "Lock it in". */
  canConfirm: boolean;
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
  draft: Pick<BetView, 'claim' | 'myStakeUsd' | 'theirStakeUsd'> | null;
  /** Only on A's phone (only A sets the terms). */
  typed?: TypedTermsPanel | undefined;
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
      <DataText muted>{`${draft.myStakeUsd} vs ${draft.theirStakeUsd}`}</DataText>
    </Card>
  ) : null;

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
          </ScrollView>
          {typed.canConfirm ? (
            <PrimaryButton
              testID="typed-confirm"
              label={t(COPY.negotiate.lockItIn)}
              busy={typed.confirming}
              onPress={typed.onConfirm}
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
});
