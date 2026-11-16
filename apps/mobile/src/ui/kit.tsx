// UI kit for party screens, ported from Verdict's Flutter widgets and its enroll redesign
// (branch enroll-redesign): step header with back arrow and progress bars, a title with a short
// explanation, the prompt bubble over the camera with an animated "Checking…", red fix-it lines,
// the check badge, the shutter, a red destructive button and a Yes/No confirmation sheet.
// Every color, size and duration comes from ./tokens; copy follows ./copyRule.
import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { color, palette, radius, space, type, type TypeToken } from './tokens';

// ---------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------

/** UI copy: 1-3 words (copy rule). */
export function Label({
  children,
  variant = 'label',
  style,
  testID,
}: {
  children: string;
  variant?: TypeToken;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <Text testID={testID} style={[type[variant], style]} numberOfLines={1}>
      {children}
    </Text>
  );
}

/** A step's one- or two-sentence explanation under its title (copy role `body`). */
export function BodyText({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

// ---------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------

type ButtonProps = {
  label: string;
  onPress?: (() => void) | undefined;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
};

function BaseButton({
  label,
  onPress,
  disabled,
  busy,
  testID,
  box,
  text,
  spinner,
}: ButtonProps & { box: ViewStyle; text: TextStyle; spinner: string }) {
  const enabled = !disabled && !busy && onPress !== undefined;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled, busy: Boolean(busy) }}
      onPress={enabled ? onPress : undefined}
      style={[styles.button, box, !enabled && styles.dimmed]}
    >
      {busy ? (
        <ActivityIndicator color={spinner} />
      ) : (
        <Text style={text} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** The one filled, accent-coloured action on a screen. */
export function PrimaryButton(p: ButtonProps) {
  return (
    <BaseButton
      {...p}
      box={styles.primary}
      text={{ ...type.labelStrong, color: color.onAccent }}
      spinner={palette.text}
    />
  );
}

/** A secondary action: hairline outline, no fill. */
export function QuietButton(p: ButtonProps) {
  return <BaseButton {...p} box={styles.quiet} text={type.label} spinner={palette.text} />;
}

/** A destructive action: red outline, or red fill for the final "Yes, delete". */
export function DangerButton({ filled = false, ...p }: ButtonProps & { filled?: boolean }) {
  return (
    <BaseButton
      {...p}
      box={filled ? styles.dangerFilled : styles.dangerOutline}
      text={{ ...type.labelStrong, color: filled ? palette.text : palette.danger }}
      spinner={filled ? palette.text : palette.danger}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------------------

/** A tick drawn with borders (no icon font, no emoji). */
function Tick({ size, tint }: { size: number; tint: string }) {
  const stroke = Math.max(2, Math.round(size * 0.12));
  return (
    <View
      style={{
        width: size * 0.9,
        height: size * 0.5,
        borderLeftWidth: stroke,
        borderBottomWidth: stroke,
        borderColor: tint,
        transform: [{ translateY: -size * 0.12 }, { rotate: '-45deg' }],
      }}
    />
  );
}

/** A round badge with a tick ("Face saved", the per-photo flash). */
export function CheckBadge({ size, fill = palette.accent }: { size: number; fill?: string }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: fill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Tick size={size * 0.42} tint={palette.text} />
    </View>
  );
}

function ChevronLeft() {
  return (
    <View
      style={{
        width: 11,
        height: 11,
        borderLeftWidth: 2,
        borderBottomWidth: 2,
        borderColor: palette.text,
        transform: [{ translateX: 3 }, { rotate: '45deg' }],
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------

/** A capture problem the user can fix, in red, in a fixed-height slot so nothing jumps. */
export function AlertLine({ message, testID }: { message: string | null; testID?: string }) {
  return (
    <View style={styles.alertSlot}>
      {message ? (
        <Text testID={testID} style={[type.label, { color: color.fixable }]} numberOfLines={1}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

export function Hairline() {
  return <View style={styles.hairline} />;
}

// ---------------------------------------------------------------------------------------
// Step screens
// ---------------------------------------------------------------------------------------

/** Back arrow on the left, one progress segment per step; an optional tag on the right. */
export function StepHeader({
  step,
  count,
  onBack,
  tag,
}: {
  step: number;
  count: number;
  onBack?: (() => void) | undefined;
  tag?: string;
}) {
  return (
    <View style={styles.header}>
      <Pressable
        testID="step-back"
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={onBack}
        hitSlop={8}
        style={styles.back}
      >
        <ChevronLeft />
      </Pressable>
      <View style={styles.segments}>
        {Array.from({ length: count }, (_, i) => (
          <View
            key={i}
            style={[
              styles.segment,
              {
                backgroundColor:
                  i < step ? palette.text : i === step ? palette.accent : palette.hairline,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.tagSlot}>{tag ? <Label variant="small">{tag}</Label> : null}</View>
    </View>
  );
}

/** One step: title, explanation, the step's content, then its error line and main button. */
export function StepScaffold({
  title,
  body,
  children,
  alert,
  action,
  secondary,
}: {
  title: string;
  /** One or two sentences under the title; omit when the content is the text (consent). */
  body?: string;
  children: ReactNode;
  alert?: string | null;
  action: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <View style={styles.step}>
      <Label variant="title">{title}</Label>
      {body ? <BodyText style={styles.stepBody}>{body}</BodyText> : null}
      <View style={[styles.stepContent, !body && styles.stepContentTight]}>{children}</View>
      <AlertLine message={alert ?? null} testID="step-alert" />
      {action}
      {secondary ? <View style={styles.secondary}>{secondary}</View> : null}
    </View>
  );
}

/** "I consent": a checkbox; the whole row is tappable. */
export function CheckRow({
  label,
  checked,
  onToggle,
  testID,
}: {
  label: string;
  checked: boolean;
  onToggle?: (() => void) | undefined;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !onToggle }}
      accessibilityLabel={label}
      onPress={onToggle}
      style={styles.checkRow}
    >
      <View style={[styles.box, checked ? styles.boxOn : styles.boxOff]}>
        {checked ? <Tick size={12} tint={palette.text} /> : null}
      </View>
      <Label variant="labelStrong">{label}</Label>
    </Pressable>
  );
}

/** A labelled one-line text field ("Your name"); the label sits above, never inside. */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  autoFocus,
  onSubmitEditing,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  testID?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <Label variant="small" style={styles.fieldLabel}>
        {label}
      </Label>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.textSecondary}
        maxLength={maxLength}
        autoFocus={autoFocus}
        autoCapitalize="words"
        autoCorrect={false}
        textContentType="givenName"
        returnKeyType="done"
        keyboardAppearance="dark"
        selectionColor={palette.accent}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.field, { borderColor: focused ? color.borderFocused : color.border }]}
      />
    </View>
  );
}

/** A labelled on/off row ("Face matching"). */
export function ToggleRow({
  label,
  value,
  onChange,
  disabled,
  testID,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.row}>
      <Label>{label}</Label>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: palette.hairline, true: palette.accent }}
        thumbColor={palette.text}
      />
    </View>
  );
}

/** A row with a label and a data value on the right, plus a tick ("Face · Saved"). */
export function SavedRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Label>{label}</Label>
      <View style={styles.rowRight}>
        <Text style={type.value}>{value}</Text>
        <Tick size={12} tint={palette.accent} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Camera stage
// ---------------------------------------------------------------------------------------

/** The rounded camera / phrase area. */
export function Stage({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.stage, style]}>{children}</View>;
}

/** "Checking" with dots that cycle . → .. → ... every 400 ms. */
export function CheckingLabel() {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setDots((d) => (d % 3) + 1), 400);
    return () => clearInterval(t);
  }, []);
  return (
    <View style={styles.checking} accessibilityLabel="Checking">
      <Text style={type.heading}>Checking</Text>
      <Text style={[type.heading, styles.dots]}>{'.'.repeat(dots)}</Text>
    </View>
  );
}

/** The translucent bubble at the top of the camera with the current prompt. */
export function StageBubble({
  prompt,
  checking = false,
  recording = false,
}: {
  prompt: string;
  checking?: boolean;
  recording?: boolean;
}) {
  return (
    <View style={styles.bubble} testID="stage-bubble">
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />
      {checking ? (
        <CheckingLabel />
      ) : recording ? (
        <View style={styles.recording}>
          <View style={styles.redDot} />
          <Text style={[type.heading, { color: palette.danger }]}>{prompt}</Text>
        </View>
      ) : (
        <Text style={type.heading}>{prompt}</Text>
      )}
    </View>
  );
}

/** Round capture button; while recording, a small square sits inside the ring. */
export function ShutterButton({
  onPress,
  disabled,
  active = false,
  label = 'Capture',
}: {
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  label?: string;
}) {
  const inner = active ? 24 : space.x8 - 4 - space.x1;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={disabled ? undefined : onPress}
      style={styles.shutter}
    >
      <View
        style={{
          width: inner,
          height: inner,
          borderRadius: active ? 5 : inner / 2,
          backgroundColor: disabled
            ? palette.textSecondary
            : active
              ? palette.accent
              : palette.text,
        }}
      />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------
// Confirmation sheet
// ---------------------------------------------------------------------------------------

/** A bottom sheet asking to confirm a destructive action: "No" and a red "Yes, delete". */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel = 'No',
  busy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.sheetBackdrop} onPress={onCancel} accessibilityLabel="Close">
        <View style={[StyleSheet.absoluteFill, styles.backdropTint]} />
      </Pressable>
      <View style={styles.sheet}>
        <Label variant="heading">{title}</Label>
        <BodyText style={styles.stepBody}>{body}</BodyText>
        <View style={styles.sheetButtons}>
          <View style={styles.flex}>
            <QuietButton testID="confirm-no" label={cancelLabel} onPress={onCancel} />
          </View>
          <View style={styles.flex}>
            <DangerButton
              testID="confirm-yes"
              filled
              label={confirmLabel}
              busy={Boolean(busy)}
              onPress={onConfirm}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { ...type.label, color: palette.textSecondary, lineHeight: 22 },
  button: {
    height: space.control,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.x2,
  },
  dimmed: { opacity: 0.4 },
  primary: { backgroundColor: color.primaryAction },
  quiet: { borderWidth: StyleSheet.hairlineWidth, borderColor: color.border },
  dangerOutline: { borderWidth: 1, borderColor: color.destructive },
  dangerFilled: { backgroundColor: color.destructive },
  alertSlot: { height: space.x3, alignItems: 'center', justifyContent: 'center' },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: color.divider },
  header: {
    height: space.x6 + space.x1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  back: { width: space.x6, height: space.x6, alignItems: 'center', justifyContent: 'center' },
  segments: { flex: 1, flexDirection: 'row', gap: 6 },
  segment: { flex: 1, height: 4, borderRadius: 2 },
  tagSlot: { minWidth: space.page, alignItems: 'flex-end', paddingRight: space.x2 },
  step: { flex: 1, paddingHorizontal: space.page, paddingBottom: space.x2 },
  stepBody: { marginTop: space.x1 },
  stepContent: { flex: 1, marginTop: space.x3 },
  stepContentTight: { marginTop: space.x2 },
  secondary: { marginTop: space.x1 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.x1 + 4,
    paddingVertical: space.x1,
    alignSelf: 'flex-start',
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: palette.accent },
  boxOff: { borderWidth: 1.5, borderColor: palette.textSecondary },
  row: {
    minHeight: space.x6 + space.x1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  stage: {
    flex: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: palette.surface,
  },
  checking: { flexDirection: 'row', alignItems: 'center' },
  dots: { width: 18 },
  bubble: {
    alignSelf: 'center',
    borderRadius: 16,
    overflow: 'hidden',
    paddingHorizontal: space.x2,
    paddingVertical: 10,
    marginTop: space.x2,
  },
  scrim: { backgroundColor: palette.background, opacity: 0.8 },
  recording: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  redDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.danger },
  shutter: {
    width: space.x8,
    height: space.x8,
    borderRadius: space.x8 / 2,
    borderWidth: 2,
    borderColor: palette.text,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  fieldLabel: { color: palette.textSecondary, marginBottom: 6 },
  field: {
    ...type.label,
    height: space.control,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.x2,
    color: palette.text,
  },
  sheetBackdrop: { flex: 1 },
  backdropTint: { backgroundColor: palette.background, opacity: 0.6 },
  sheet: {
    backgroundColor: palette.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.page,
    paddingTop: space.x3,
    paddingBottom: space.x5,
  },
  sheetButtons: { flexDirection: 'row', gap: space.x2, marginTop: space.x3 },
});
