// Home (rooms: TASKS D1-M6, API-CONTRACT §2.3; balance: D3-M2, §2.14), bet history and the
// profile page (D5-M2).
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { signedUsd } from '../bets/view';
import type { HistoryItem, PreviewUser } from '../preview/data';
import { AlertLine, Label, PrimaryButton, QuietButton, TextField } from '../ui/kit';
import {
  Avatar,
  BalanceHeader,
  Chip,
  DataText,
  ListRow,
  Page,
  ReconnectBanner,
  Screen,
  Section,
  StatusHero,
  TopBar,
} from '../ui/parts';
import { palette, space } from '../ui/tokens';
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
}: {
  name: string;
  balanceCents: number;
  pending: boolean;
  inBetsUsd: string | null;
  room: { code: string; name: string } | null;
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
}) {
  const [code, setCode] = useState('');
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const join = async () => {
    setBusy(true);
    setAlert(null);
    const ok = await onJoin(code.trim().toUpperCase());
    setBusy(false);
    if (!ok) setAlert(t(COPY.home.badCode));
  };

  return (
    <Screen>
      <ReconnectBanner visible={offline} />
      <View style={styles.head}>
        <Pressable
          style={styles.flex}
          onLongPress={onTitleLongPress}
          delayLongPress={1200}
          accessible={false}
        >
          <BalanceHeader cents={balanceCents} pending={pending} inBetsUsd={inBetsUsd} />
        </Pressable>
        <Pressable
          testID="home-profile"
          accessibilityRole="button"
          accessibilityLabel={t(COPY.home.profile)}
          onPress={onProfile}
          hitSlop={8}
        >
          <Avatar name={name} size={40} />
        </Pressable>
        {tag ? (
          <Label variant="small" style={styles.tag}>
            {tag}
          </Label>
        ) : null}
      </View>
      <Page>
        {room ? (
          <>
            <View style={styles.roomHead}>
              <Label variant="small">{t(COPY.home.room)}</Label>
              <Chip label={room.code} />
            </View>
            <ScrollView style={styles.flex} contentContainerStyle={styles.list}>
              {members.length === 0 ? (
                <StatusHero mark="ring" title={t(COPY.home.empty)} />
              ) : (
                members.map((m) => (
                  <View key={m.user_id} style={styles.member}>
                    <Avatar name={m.display_name} online={m.online} />
                    <DataText style={styles.flex} lines={1}>
                      {m.display_name}
                    </DataText>
                    {m.online ? (
                      <View style={styles.challenge}>
                        <QuietButton
                          testID={`challenge-${m.user_id}`}
                          label={t(COPY.home.challenge)}
                          onPress={() => onChallenge(m)}
                        />
                      </View>
                    ) : (
                      <Chip label={t(COPY.home.offline)} />
                    )}
                  </View>
                ))
              )}
            </ScrollView>
            {onScan ? (
              <PrimaryButton testID="home-scan" label={t(COPY.home.scan)} onPress={onScan} />
            ) : null}
            <View style={styles.row}>
              <View style={styles.flex}>
                <QuietButton label={t(COPY.home.history)} onPress={onHistory} />
              </View>
              <View style={styles.flex}>
                <QuietButton label={t(COPY.home.leave)} onPress={onLeave} />
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={styles.flex} />
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
              onSubmitEditing={() => void join()}
            />
            <AlertLine message={alert} />
            <PrimaryButton
              testID="room-join"
              label={t(COPY.home.join)}
              disabled={code.trim().length < 4}
              busy={busy}
              onPress={() => void join()}
            />
            <View style={styles.row}>
              <View style={styles.flex}>
                <QuietButton label={t(COPY.home.create)} onPress={onCreate} />
              </View>
              <View style={styles.flex}>
                <QuietButton label={t(COPY.home.history)} onPress={onHistory} />
              </View>
            </View>
          </>
        )}
      </Page>
    </Screen>
  );
}

export function HistoryScreen({
  items,
  onBack,
}: {
  items: readonly HistoryItem[];
  onBack: () => void;
}) {
  const result = {
    won: t(COPY.history.won),
    lost: t(COPY.history.lost),
    void: t(COPY.history.voided),
  } as const;
  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.history.title)} />
      <Page>
        {items.length === 0 ? (
          <>
            <StatusHero mark="ring" title={t(COPY.history.empty)} />
            <View style={styles.flex} />
            <PrimaryButton label={t(COPY.ruling.backHome)} onPress={onBack} />
          </>
        ) : (
          <ScrollView>
            {items.map((it) => (
              <ListRow
                key={it.bet_id}
                left={<Avatar name={it.opponent} size={32} />}
                title={`${it.title} · ${it.opponent}`}
                value={`${result[it.outcome]} ${signedUsd(it.net)}`}
              />
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
  onFace: () => void;
  onHistory: () => void;
  onJudgeCam: () => void;
  onDemo: () => void;
}) {
  return (
    <Screen>
      <TopBar onBack={onBack} title={t(COPY.profile.title)} />
      <Page>
        <View style={styles.profileHead}>
          <Avatar name={name} size={72} accent />
          <DataText variant="title">{name}</DataText>
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
          <ListRow title={t(COPY.profile.judgeCam)} onPress={onJudgeCam} />
          <ListRow title={t(COPY.profile.demo)} onPress={onDemo} />
        </Section>
      </Page>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.page,
    gap: space.x2,
  },
  tag: { position: 'absolute', top: space.x1, right: space.page },
  roomHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.x1,
  },
  list: { paddingVertical: space.x1 },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x2,
    paddingVertical: space.x1,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.hairline,
  },
  challenge: { width: 120 },
  row: { flexDirection: 'row', gap: space.x1, marginTop: space.x1 },
  profileHead: { alignItems: 'center', gap: space.x2, marginTop: space.x2 },
});
