// Sign-up (TASKS D0-M4 placeholder): the first screen a new phone sees. It asks for a name and
// the 18+ attestation (BRIEF 5c guardrail), nothing else: no email, no password, no wallet words.
// The phone's own key is the login (API-CONTRACT §2.1), so a returning user, even after a
// reinstall, never sees this screen. Face enrollment is offered right after (D3-M3).
import { useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import {
  AlertLine,
  BodyText,
  CheckRow,
  Label,
  PrimaryButton,
  QuietButton,
  TextField,
} from '../ui/kit';
import { AppMark } from '../ui/brand';
import { OperatorHold, Screen } from '../ui/parts';
import { half, space } from '../ui/tokens';
import { SignupApiError, type SignedUpUser, type SignupApi } from './api';
import { SIGNUP_COPY } from './copy';
import {
  MAX_NAME_LENGTH,
  NAME_PROBLEM_LABEL,
  nameProblem,
  signupErrorLabel,
  signupFields,
} from './form';

export function SignupScreen({
  api,
  preview = false,
  onSignedUp,
  onDemo,
  onTitleLongPress,
}: {
  api: SignupApi;
  /** Running on the stand-in server: tag the screen "Preview". */
  preview?: boolean;
  onSignedUp: (user: SignedUpUser) => void;
  /** DEMO_MODE: take over a seeded demo account instead (API-CONTRACT §2.1 demo-claim). */
  onDemo?: (() => void) | undefined;
  /** Hidden operator gesture (diagnostics / preview). */
  onTitleLongPress?: (() => void) | undefined;
}) {
  const [name, setName] = useState('');
  const [attestedAt, setAttestedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);

  const problem = nameProblem(name);
  const ready = problem === null && attestedAt !== null;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setAlert(null);
    try {
      onSignedUp(await api.signup(signupFields(name, attestedAt)));
    } catch (e) {
      setAlert(e instanceof SignupApiError ? signupErrorLabel(e.code) : signupErrorLabel(''));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.top}>
          {preview ? <Label variant="small">{SIGNUP_COPY.previewTag}</Label> : null}
        </View>
        <View style={styles.body}>
          {/* The brand switch above the name, decorative only: the title already says it. */}
          <View
            style={styles.mark}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <AppMark width={MARK_WIDTH} lit />
          </View>
          {/* The name of the app, said once, big and bold. */}
          <OperatorHold onHold={onTitleLongPress}>
            <Label variant="hero">{SIGNUP_COPY.title}</Label>
          </OperatorHold>
          <BodyText style={styles.gap}>{SIGNUP_COPY.body}</BodyText>
          <View style={styles.form}>
            <TextField
              testID="signup-name"
              label={SIGNUP_COPY.nameLabel}
              placeholder={SIGNUP_COPY.namePlaceholder}
              value={name}
              onChangeText={(t) => {
                setName(t);
                setAlert(null);
              }}
              maxLength={MAX_NAME_LENGTH + 8}
              onSubmitEditing={() => void submit()}
            />
            <View style={styles.check}>
              <CheckRow
                testID="signup-age"
                label={SIGNUP_COPY.ageCheck}
                checked={attestedAt !== null}
                onToggle={() => setAttestedAt(attestedAt ? null : new Date())}
              />
            </View>
          </View>
          {/* The empty space between the form and Continue: tapping it puts the keyboard away. */}
          <Pressable style={styles.flex} onPress={Keyboard.dismiss} accessible={false} />
          <AlertLine
            testID="signup-alert"
            message={alert ?? (problem === 'too_long' ? NAME_PROBLEM_LABEL.too_long : null)}
          />
          <PrimaryButton
            testID="signup-continue"
            label={SIGNUP_COPY.continue}
            disabled={!ready}
            busy={busy}
            onPress={() => void submit()}
          />
          {onDemo ? (
            <View style={styles.secondary}>
              <QuietButton testID="signup-demo" label={SIGNUP_COPY.demo} onPress={onDemo} />
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The switch mark at the top of the first screen: small, so the title stays the hero. */
const MARK_WIDTH = space.x7;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: {
    height: space.x6,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingHorizontal: space.page,
  },
  body: { flex: 1, paddingHorizontal: space.page, paddingBottom: space.x2 },
  mark: { marginTop: space.x2, marginBottom: space.x3, alignSelf: 'flex-start' },
  gap: { marginTop: half.x15 },
  // The name field and the 18+ box sit right under the tagline; Continue stays at the bottom.
  form: { marginTop: space.x5 },
  check: { marginTop: space.x3 },
  secondary: { marginTop: space.x1 },
});
