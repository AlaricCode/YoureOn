// Home (rooms: TASKS D1-M6, API-CONTRACT §2.3; balance: D3-M2, §2.14), bet history and the
// profile page (D5-M2).
import { useEffect, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { homeMode } from '../app/lobby';
import { signedUsd } from '../bets/view';
import type { HistoryItem, PreviewUser } from '../preview/data';
import { AlertLine, Label, PrimaryButton, QuietButton, TextField } from '../ui/kit';
import {
  Avatar,
  BalanceHeader,
  DataText,
  ListRow,
  OperatorHold,
  Page,
  Screen,
  Section,
  StatusHero,
  TopBar,
} from '../ui/parts';
import { historyMode, press } from '../ui/polish';
import { PressScale } from '../ui/press';
import { SkeletonRows } from '../ui/Skeleton';
import {
  TABULAR,
  avatarSize,
  color,
  fontFamily,
  fontWeight,
  half,
  palette,
  space,
} from '../ui/tokens';
import { COPY, t } from './copy';

export function HomeScreen({
  name,
  balanceCents,
  pending,
  inBetsUsd,
  room,
  members,
  offline,
  tag,
  onJoin,
  onCreate,
  onLeave,
  onScan,
  onChallenge,
  onHistory,
  onProfile,
  onTitleLongPress,
  note,
  creating = false,
  lobbyJoining = false,
  series,
  change,
}: {
  name: string;
  balanceCents: number;
  pending: boolean;
  inBetsUsd: string | null;
  /** `lobby`: the shared lobby (app/lobby): "Everyone here", no code, "Private room". */
  room: { code: string; name: string; lobby?: boolean | undefined } | null;
  members: readonly PreviewUser[];
  offline: boolean;
  tag?: string | undefined;
  /** Resolves false when the code is unknown or expired. */
  onJoin: (code: string) => Promise<boolean>;
  onCreate: () => void;
  onLeave: () => void;
  /** Omitted when face scan is off: the "Scan a face" button is hidden. */
  onScan?: (() => void) | undefined;
  onChallenge: (user: PreviewUser) => void;
  onHistory: () => void;
  onProfile: () => void;
  /** Hidden operator gesture (diagnostics / preview). */
  onTitleLongPress?: (() => void) | undefined;
  /** Why the last "New room" or "Challenge" failed (it clears itself), or null. */
  note?: string | null | undefined;
  /** "New room" is in flight. */
  creating?: boolean | undefined;
  /** No room yet and the lobby join is in flight: the lobby shows, joining, not the code entry. */
  lobbyJoining?: boolean | undefined;
  /** Balance points (cents, oldest first) for the sparkline; hidden under 2 points. */
  series?: readonly number[] | null | undefined;
  /** Net change over those points, shown green / red under the balance; omitted when unknown. */
  change?: { readonly cents: number; readonly caption?: string } | null | undefined;
}) {
  const [code, setCode] = useState('');
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** "Private room" tapped in the lobby: today's code entry and "New room" show instead. */
  const [showPrivate, setShowPrivate] = useState(false);
  const inPrivateRoom = room !== null && room.lobby !== true;
  useEffect(() => {
    if (inPrivateRoom) setShowPrivate(false);
  }, [inPrivateRoom]);
  const mode = homeMode({ room, lobbyJoining, showPrivate });
  /** The code entry is over the lobby ("Back" returns to it), not the no-room fallback. */
  const lobbyAround = room?.lobby === true || (room === null && lobbyJoining);

  const memberRow = (m: PreviewUser) => (
    <View key={m.user_id} style={styles.member}>
      <Avatar name={m.display_name} size={avatarSize.md} online={m.online} />
      <DataText variant="heading" style={[styles.flex, styles.rowTitle]} lines={1}>
        {m.display_name}
      </DataText>
      {m.online ? (
        // A small grey pill, not green: green stays "the one action" (Scan a face).
        <QuietButton
          small
          testID={`challenge-${m.user_id}`}
          label={t(COPY.home.challenge)}
          onPress={() => onChallenge(m)}
        />
      ) : (
        // Presence is the dot on the disc; the word stays, quietly, in grey.
        <Label variant="small">{t(COPY.home.offline)}</Label>
      )}
    </View>
  );

  const join = async () => {
    setBusy(true);
    setAlert(null);
    const ok = await onJoin(code.trim().toUpperCase());
    setBusy(false);
    if (!ok) setAlert(t(COPY.home.badCode));
  };

  return (
    <Screen offline={offline}>
      {/* The balance leads, full width, on black; your avatar sits on its "Balance" label row. The
          operator tag (diagnostics builds only) gets a slim row above it. */}
      {tag ? (
        <View style={styles.top}>
          <Label variant="small">{tag}</Label>
        </View>
      ) : null}
      <OperatorHold style={styles.head} onHold={onTitleLongPress}>
        <BalanceHeader
          cents={balanceCents}
          pending={pending}
          inBetsUsd={inBetsUsd}
          change={change ?? null}
          series={series ?? null}
          trailing={
            <PressScale
              testID="home-profile"
              accessibilityRole="button"
              accessibilityLabel={t(COPY.home.profile)}
              onPress={onProfile}
              hitSlop={8}
              scaleTo={press.avatarScale}
            >
              <Avatar name={name} size={avatarSize.sm} />
            </PressScale>
          }
        />
      </OperatorHold>
      {/* The room code field sits at the bottom: keep it and "Join room" above the keyboard. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Page>
          {mode === 'lobby' ? (
            <>
              {/* The lobby: everyone with the app open. No code to read out; scan or tap. */}
              <View style={styles.roomHead}>
                <Label testID="lobby-title" variant="heading">
                  {t(COPY.home.everyone)}
                </Label>
              </View>
              <ScrollView
                style={styles.flex}
                contentContainerStyle={
                  room === null || members.length === 0 ? styles.listEmpty : styles.list
                }
              >
                {room === null ? (
                  <StatusHero mark="ring" title={t(COPY.home.joining)} />
                ) : members.length === 0 ? (
                  <StatusHero mark="ring" title={t(COPY.home.lobbyEmpty)} />
                ) : (
                  members.map(memberRow)
                )}
              </ScrollView>
              <AlertLine testID="home-alert" message={note ?? null} />
              <View style={styles.actions}>
                {onScan ? (
                  <PrimaryButton testID="home-scan" label={t(COPY.home.scan)} onPress={onScan} />
                ) : null}
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <QuietButton
                      testID="home-history"
                      label={t(COPY.home.history)}
                      onPress={onHistory}
                    />
                  </View>
                  <View style={styles.flex}>
                    <QuietButton
                      testID="home-private"
                      label={t(COPY.home.privateRoom)}
                      onPress={() => setShowPrivate(true)}
                    />
                  </View>
                </View>
              </View>
            </>
          ) : mode === 'room' && room ? (
            <>
              <View style={styles.roomHead}>
                <Label variant="heading">{t(COPY.home.room)}</Label>
                {/* The code friends read out loud: plain grey text on the "Room" baseline (a pill
                    would read as a button). */}
                <Label testID="room-code-chip" variant="labelMedium" style={styles.codeText}>
                  {room.code}
                </Label>
              </View>
              <ScrollView
                style={styles.flex}
                contentContainerStyle={members.length === 0 ? styles.listEmpty : styles.list}
              >
                {members.length === 0 ? (
                  <StatusHero mark="ring" title={t(COPY.home.empty)} />
                ) : (
                  members.map(memberRow)
                )}
              </ScrollView>
              <AlertLine testID="home-alert" message={note ?? null} />
              <View style={styles.actions}>
                {onScan ? (
                  <PrimaryButton testID="home-scan" label={t(COPY.home.scan)} onPress={onScan} />
                ) : null}
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <QuietButton
                      testID="home-history"
                      label={t(COPY.home.history)}
                      onPress={onHistory}
                    />
                  </View>
                  <View style={styles.flex}>
                    <QuietButton testID="room-leave" label={t(COPY.home.leave)} onPress={onLeave} />
                  </View>
                </View>
              </View>
            </>
          ) : (
            <>
              {/* The code field sits just under the balance (no dead black between); tapping the
                  empty space under it puts the keyboard away. */}
              <View style={styles.codeGroup}>
                <TextField
                  testID="room-code"
                  label={t(COPY.home.roomCode)}
                  placeholder="UBC26X"
                  value={code}
                  onChangeText={(v) => {
                    setCode(v);
                    setAlert(null);
                  }}
                  maxLength={12}
                  autoCapitalize="characters"
                  textContentType="none"
                  onSubmitEditing={() => void join()}
                />
                <AlertLine testID="home-alert" message={alert ?? note ?? null} />
              </View>
              <Pressable style={styles.flex} onPress={Keyboard.dismiss} accessible={false} />
              <View style={styles.actions}>
                <PrimaryButton
                  testID="room-join"
                  label={t(COPY.home.join)}
                  disabled={code.trim().length < 4}
                  busy={busy}
                  onPress={() => void join()}
                />
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <QuietButton
                      testID="room-create"
                      label={t(COPY.home.create)}
                      busy={creating}
                      onPress={onCreate}
                    />
                  </View>
                  <View style={styles.flex}>
                    {lobbyAround ? (
                      <QuietButton
                        testID="home-lobby"
                        label={t(COPY.home.back)}
                        onPress={() => {
                          Keyboard.dismiss();
                          setShowPrivate(false);
                          setAlert(null);
                        }}
                      />
                    ) : (
                      <QuietButton
                        testID="home-history"
                        label={t(COPY.home.history)}
                        onPress={onHistory}
                      />
                    )}
                  </View>
                </View>
              </View>
            </>
          )}
        </Page>
      </KeyboardAvoidingView>
    </Screen>
  );
}

export function HistoryScreen({
  items,
  onBack,
  status = 'ready',
  onRetry,
}: {
  items: readonly HistoryItem[];
  onBack: () => void;
  /** The real app loads the list (GET /v1/me/bets); the preview passes it ready. */
  status?: 'loading' | 'ready' | 'failed';
  onRetry?: () => void;
}) {
  const result = {
    won: t(COPY.history.won),
    lost: t(COPY.history.lost),
    void: t(COPY.history.voided),
  } as const;
  // First load: skeleton rows. A reload with rows already shown is pull-to-refresh's spinner,
  // so the list never blanks.
  const { mode, refreshing } = historyMode(status, items.length);
  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.history.title)} />
      <Page>
        {mode === 'skeleton' ? (
          <SkeletonRows />
        ) : mode === 'error' ? (
          <>
            <View style={styles.centre}>
              <StatusHero mark="cross" title={t(COPY.app.offline)} />
            </View>
            <PrimaryButton testID="history-retry" label={t(COPY.app.failed)} onPress={onRetry} />
          </>
        ) : mode === 'empty' ? (
          <>
            <View style={styles.centre}>
              <StatusHero mark="ring" title={t(COPY.history.empty)} />
            </View>
            <PrimaryButton label={t(COPY.ruling.backHome)} onPress={onBack} />
          </>
        ) : (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={styles.historyList}
            refreshControl={
              onRetry ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRetry}
                  tintColor={palette.textSecondary}
                />
              ) : undefined
            }
          >
            {/* Hairline rows: who and what on the left; the amount (tabular, green / red) over
                the outcome on the right. */}
            {items.map((it) => (
              <View key={it.bet_id} style={styles.historyRow}>
                <Avatar name={it.opponent} size={avatarSize.md} />
                {/* The title sits on the amount's first baseline, not centred on the two lines. */}
                <View style={styles.historyText}>
                  <DataText variant="row" style={styles.flex} lines={1}>
                    {`${it.title} · ${it.opponent}${it.stakes ? ` · ${it.stakes}` : ''}`}
                  </DataText>
                  <View style={styles.historyResult}>
                    <DataText
                      variant="amount"
                      style={[styles.amount, { color: netColor[it.outcome] }]}
                      lines={1}
                    >
                      {signedUsd(it.net)}
                    </DataText>
                    <Label variant="small">{result[it.outcome]}</Label>
                  </View>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </Page>
    </Screen>
  );
}

export function ProfileScreen({
  name,
  faceOn,
  onBack,
  onFace,
  onHistory,
  onJudgeCam,
  onDemo,
}: {
  name: string;
  faceOn: boolean;
  onBack: () => void;
  /** Face enrollment / settings; omitted while the app has none: the row is then plain info. */
  onFace?: (() => void) | undefined;
  onHistory: () => void;
  onJudgeCam: () => void;
  onDemo: () => void;
}) {
  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.profile.title)} />
      {/* Scrolls: in landscape (the judge cam on its tripod) the last rows were cut off. */}
      <ScrollView style={styles.flex} contentContainerStyle={styles.profileScroll}>
        <View style={styles.profileHead}>
          <Avatar name={name} size={avatarSize.hero} />
          <DataText variant="figure" style={styles.profileName} lines={1}>
            {name}
          </DataText>
        </View>
        <Section label={t(COPY.profile.title)}>
          <ListRow title={t(COPY.profile.photo)} value={t(COPY.profile.none)} />
          <ListRow
            testID="profile-face"
            title={t(COPY.profile.face)}
            value={faceOn ? t(COPY.profile.on) : t(COPY.profile.off)}
            onPress={onFace}
          />
          <ListRow title={t(COPY.profile.history)} onPress={onHistory} />
        </Section>
        <Section label={t(COPY.profile.demo)}>
          <ListRow
            testID="profile-judge-cam"
            title={t(COPY.profile.judgeCam)}
            onPress={onJudgeCam}
          />
          <ListRow testID="profile-demo" title={t(COPY.profile.demo)} onPress={onDemo} />
        </Section>
      </ScrollView>
    </Screen>
  );
}

/** The amount's colour on the history list: money in green, money out red, a refund grey. */
const netColor = {
  won: color.positive,
  lost: color.negative,
  void: palette.textSecondary,
} as const;

/** One hairline under each row of a list. */
const rowDivider = {
  borderBottomWidth: StyleSheet.hairlineWidth,
  borderBottomColor: color.divider,
} as const;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centre: { flex: 1, justifyContent: 'center' },
  /** The profile name in Geist Light 34, like the big numerals. */
  profileName: { textAlign: 'center', letterSpacing: -0.6, fontVariant: [] },
  top: { height: space.x4, justifyContent: 'center', paddingHorizontal: space.page },
  head: { paddingHorizontal: space.page },
  /** 40 pt under the sparkline (the balance block keeps 16 pt of its own below it). */
  codeGroup: { marginTop: space.x3 },
  roomHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: space.x2,
    paddingBottom: space.x1,
    ...rowDivider,
  },
  codeText: { color: palette.textSecondary, letterSpacing: 0.5, fontVariant: TABULAR },
  list: { paddingBottom: space.x1 },
  listEmpty: { flexGrow: 1, justifyContent: 'center', paddingVertical: space.x3 },
  member: {
    minHeight: space.x8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: half.x15 + half.x05,
    ...rowDivider,
  },
  rowTitle: { fontFamily: fontFamily.medium, fontWeight: fontWeight.medium },
  actions: { gap: half.x15, paddingBottom: space.x1 },
  row: { flexDirection: 'row', gap: half.x15 },
  historyList: { paddingBottom: space.x3 },
  historyRow: {
    minHeight: space.x8 + space.x1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: half.x15 + half.x05,
    ...rowDivider,
  },
  historyText: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: half.x15 + half.x05,
  },
  historyResult: { alignItems: 'flex-end', gap: 2 },
  /** 22/400 thin numerals, tabular, like the balance. */
  amount: { fontVariant: TABULAR, letterSpacing: -0.3, textAlign: 'right' },
  profileHead: { alignItems: 'center', gap: space.x2, marginTop: space.x3 },
  profileScroll: { paddingHorizontal: space.page, paddingBottom: space.x4 },
});
