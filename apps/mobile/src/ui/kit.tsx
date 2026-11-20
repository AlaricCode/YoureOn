// UI kit for party screens ("Limelight", ./tokens): step header with back chevron and progress
// bars, a title with a short explanation, the prompt bubble over the camera with an animated
// "Checking…", red fix-it lines, the check badge, the shutter, pill buttons, a text field and a
// Yes/No confirmation sheet. Every color, size and duration comes from ./tokens; copy follows
// ./copyRule.
//
// White asks, green answers: the primary pill, a ticked box, a focused field and a done step are
// white; green is kept for what is on (a saved tick, a switch that is on). Everything is soft:
// filled, borderless, round, with bold labels.
//
// Backdrops: what a component sits on changes how it draws, without new props at the call site.
// The page is black; a ConfirmSheet, a raised Card or the camera Stage is glass ("raised"), so
// a text field in it takes the next step up instead of vanishing. Read it with useBackdrop().
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { columnFor, type Column } from './column';
import { PressScale } from './press';
import { isDisplay, typographic } from './typography';
import {
  border,
  color,
  dp,
  half,
  material,
  palette,
  radius,
  space,
  stroke as glyph,
  type,
  type TypeToken,
} from './tokens';

// ---------------------------------------------------------------------------------------
// Backdrop
// ---------------------------------------------------------------------------------------

export type Backdrop = 'page' | 'raised';

const BackdropContext = createContext<Backdrop>('page');

/** Declares what its children sit on ('raised' inside a sheet, raised card or the stage). */
export function BackdropProvider({ value, children }: { value: Backdrop; children: ReactNode }) {
  return <BackdropContext.Provider value={value}>{children}</BackdropContext.Provider>;
}

export function useBackdrop(): Backdrop {
  return useContext(BackdropContext);
}

/** The colour of the surface under the component (for cut-out rings around presence dots). */
export function useBackdropColor(): string {
  return useBackdrop() === 'raised' ? palette.surface : palette.background;
}

// ---------------------------------------------------------------------------------------
// Column
// ---------------------------------------------------------------------------------------

/**
 * The content column for this window (./column): the window itself on a phone, a centred
 * phone-width column on an iPad. Screens (ui/parts Screen, MomentScreen) apply it; anything
 * placed against the window's own edges (a sheet, a corner control) uses its `inset`.
 */
export function useColumn(): Column {
  const { width, height } = useWindowDimensions();
  return columnFor(width, height);
}

// ---------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------

/**
 * UI copy: 1-3 words (copy rule). At headline sizes it is set with real apostrophes; VoiceOver
 * and the e2e flows still get the text as written.
 */
export function Label({
  children,
  variant = 'label',
  style,
  lines = 1,
  testID,
}: {
  children: string;
  variant?: TypeToken;
  style?: StyleProp<TextStyle>;
  /** Lines before the tail is cut (default 1); a sheet title that is contract copy wraps. */
  lines?: number;
  testID?: string;
}) {
  const shown = isDisplay(variant) ? typographic(children) : children;
  return (
    <Text
      testID={testID}
      style={[type[variant], style]}
      numberOfLines={lines}
      accessibilityLabel={shown === children ? undefined : children}
    >
      {shown}
    </Text>
  );
}

/** A step's one- or two-sentence explanation under its title (copy role `body`), grey. */
export function BodyText({ children, style }: { children: string; style?: StyleProp<TextStyle> }) {
  return <Text style={[type.body, style]}>{children}</Text>;
}

// ---------------------------------------------------------------------------------------
// Buttons: full pills, 56 pt, Geist 700 17. The primary is white; the rest are soft grey.
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
  ink,
  offBox,
  offInk,
  face = 'button',
  hitSlop,
}: ButtonProps & {
  /** Extra touch area around a compact (32 pt) text button, so it still takes a 44 pt tap. */
  hitSlop?: number;
  box: StyleProp<ViewStyle>;
  ink: string;
  /**
   * The label's type: 17/600 (`button`), 17/500 (`buttonQuiet`, plain text buttons) or 15/500
   * (`labelMedium`, the small in-row and quiet-exit actions).
   */
  face?: 'button' | 'buttonQuiet' | 'labelMedium';
  /** Disabled look at full opacity (instead of dimming `box`). */
  offBox?: StyleProp<ViewStyle>;
  offInk?: string;
}) {
  const enabled = !disabled && !busy && onPress !== undefined;
  const off = !enabled && !busy && offBox !== undefined;
  // PressScale: the pill gives a touch under the finger (0.97, UI thread); off buttons stay still.
  return (
    <PressScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled, busy: Boolean(busy) }}
      onPress={enabled ? onPress : undefined}
      hitSlop={hitSlop}
      style={[styles.button, off ? offBox : box, !enabled && !busy && !off && styles.dimmed]}
    >
      {busy ? (
        <ActivityIndicator color={ink} />
      ) : (
        <Text style={[type[face], { color: off ? (offInk ?? ink) : ink }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </PressScale>
  );
}

/**
 * The one filled action on a screen: a white pill with black text. Disabled, it is the glass
 * pill with dim text at full opacity (a dimmed white reads as a grey button, not an off one).
 */
export function PrimaryButton(p: ButtonProps) {
  return (
    <BaseButton
      {...p}
      box={styles.primary}
      ink={color.onPrimary}
      offBox={styles.secondary}
      offInk={palette.textTertiary}
    />
  );
}

/**
 * A secondary action: a soft grey pill with white text. `small` is the 36 pt in-row pill
 * (white 15/600, 16 pt sides), e.g. "Challenge" on a room row.
 */
export function QuietButton({ small = false, ...p }: ButtonProps & { small?: boolean }) {
  return small ? (
    <BaseButton
      {...p}
      box={[styles.secondary, styles.small]}
      ink={palette.text}
      face="labelMedium"
    />
  ) : (
    <BaseButton {...p} box={styles.secondary} ink={palette.text} />
  );
}

/**
 * A tertiary action: text only, no fill (44 pt tall). White 17/600 by default (it asks, so it
 * is not green); `tone="danger"` is red (e.g. "Back out"), `tone="muted"` grey, `tone="plain"`
 * white 17/500 ("Skip for now", "Back").
 */
export function TextButton({
  tone = 'accent',
  small = false,
  dense = false,
  ...p
}: ButtonProps & {
  tone?: 'accent' | 'danger' | 'muted' | 'plain';
  /** 15/500 instead of 17 (a quiet exit under other actions). */
  small?: boolean;
  /** 32 pt tall (44 pt touch area) so two stacked text actions sit close together. */
  dense?: boolean;
}) {
  const ink =
    tone === 'danger' ? palette.danger : tone === 'muted' ? palette.textSecondary : palette.text;
  return (
    <BaseButton
      {...p}
      box={dense ? [styles.text, styles.dense] : styles.text}
      hitSlop={dense ? 6 : undefined}
      ink={ink}
      face={small ? 'labelMedium' : tone === 'plain' ? 'buttonQuiet' : 'button'}
    />
  );
}

/**
 * A destructive action: red text on a glass pill; `filled` is a red pill with black text
 * ("Yes, delete").
 */
export function DangerButton({ filled = false, ...p }: ButtonProps & { filled?: boolean }) {
  return filled ? (
    <BaseButton {...p} box={styles.dangerFilled} ink={color.onDanger} />
  ) : (
    <BaseButton {...p} box={styles.secondary} ink={palette.danger} />
  );
}

// ---------------------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------------------

/** A tick drawn with borders (no icon font, no emoji). */
export function Tick({ size, tint }: { size: number; tint: string }) {
  const stroke = Math.max(glyph.glyph, Math.round(size * 0.14));
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

/**
 * A round badge with a tick ("Face saved", the per-photo flash): a glass disc with a green
 * tick, lit by a green ring (it answers: something was saved). Pass `fill={palette.accent}` for
 * a solid green disc (the tick turns black).
 */
export function CheckBadge({ size, fill = palette.fill }: { size: number; fill?: string }) {
  const solid = fill === palette.accent;
  const tick = solid ? color.onAccent : palette.accent;
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: fill,
          alignItems: 'center',
          justifyContent: 'center',
        },
        solid ? null : { backgroundImage: material.disc, boxShadow: material.ringOn },
      ]}
    >
      <Tick size={size * 0.42} tint={tick} />
    </View>
  );
}

/** A back chevron drawn with borders. White by default. */
export function ChevronLeft({ tint = palette.text }: { tint?: string } = {}) {
  return (
    <View
      style={{
        width: dp(12),
        height: dp(12),
        borderLeftWidth: glyph.glyph,
        borderBottomWidth: glyph.glyph,
        borderColor: tint,
        transform: [{ translateX: 3 }, { rotate: '45deg' }],
      }}
    />
  );
}

/**
 * The back button used by StepHeader and TopBar: a bare white chevron, its left edge on the page
 * margin, with a 44 pt touch area (hitSlop).
 */
export function BackButton({
  onPress,
  testID,
}: {
  onPress?: (() => void) | undefined;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Back"
      onPress={onPress}
      hitSlop={{ top: 10, bottom: 10, left: 12, right: 20 }}
      style={({ pressed }) => [styles.back, pressed && styles.pressed]}
    >
      <ChevronLeft />
    </Pressable>
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
        <Text testID={testID} style={[type.labelMedium, styles.alert]} numberOfLines={1}>
          {message}
        </Text>
      ) : null}
    </View>
  );
}

/** A full-width hairline divider (#1C1C1F, StyleSheet.hairlineWidth). */
export function Hairline({ style }: { style?: StyleProp<ViewStyle> } = {}) {
  return <View style={[styles.hairline, style]} />;
}

// ---------------------------------------------------------------------------------------
// Step screens
// ---------------------------------------------------------------------------------------

/** Back chevron on the left, one thin progress segment per step; an optional tag on the right. */
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
      <BackButton testID="step-back" onPress={onBack} />
      <View style={styles.segments}>
        {Array.from({ length: count }, (_, i) => (
          <View
            key={i}
            style={[styles.segment, { backgroundColor: i <= step ? palette.text : palette.rim }]}
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
      {secondary ? <View style={styles.secondaryAction}>{secondary}</View> : null}
    </View>
  );
}

/** "I consent": a checkbox (white when checked); the whole row is tappable. */
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
        {checked ? <Tick size={dp(12)} tint={color.onPrimary} /> : null}
      </View>
      <Label variant="labelMedium">{label}</Label>
    </Pressable>
  );
}

/**
 * A labelled one-line text field ("Your name"); the label sits above, never inside. A soft
 * well (one step up inside a raised sheet), radius 18; focused, it gets a 2 pt white outline.
 */
export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  autoFocus,
  onSubmitEditing,
  testID,
  autoCapitalize = 'words',
  textContentType = 'givenName',
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  maxLength?: number;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  testID?: string;
  /** Defaults suit a name; a code field wants 'characters' and no autofill ('none'). */
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  textContentType?: 'givenName' | 'none';
}) {
  const [focused, setFocused] = useState(false);
  const raised = useBackdrop() === 'raised';
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
        placeholderTextColor={palette.textTertiary}
        maxLength={maxLength}
        autoFocus={autoFocus}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        textContentType={textContentType}
        returnKeyType="done"
        keyboardAppearance="dark"
        selectionColor={palette.text}
        cursorColor={palette.text}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.field,
          { backgroundColor: raised ? palette.fill : palette.surface },
          { borderColor: focused ? color.borderFocused : 'transparent' },
        ]}
      />
    </View>
  );
}

/** A labelled on/off row ("Face matching"), green when on. */
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
      <Label variant="labelMedium">{label}</Label>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: palette.fill, true: palette.accent }}
        ios_backgroundColor={palette.fill}
        thumbColor={palette.text}
      />
    </View>
  );
}

/** A row with a label and a grey value on the right, plus a green tick ("Face · Saved"). */
export function SavedRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Label variant="labelMedium">{label}</Label>
      <View style={styles.rowRight}>
        <Text style={type.value}>{value}</Text>
        <Tick size={dp(12)} tint={palette.accent} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------------
// Camera stage
// ---------------------------------------------------------------------------------------

/** The rounded camera / phrase area (glass, radius 20). Children see a raised backdrop. */
export function Stage({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <BackdropProvider value="raised">
      <View style={[styles.stage, style]}>{children}</View>
    </BackdropProvider>
  );
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

/** The translucent black pill at the top of the camera with the current prompt. */
export function StageBubble({
  prompt,
  checking = false,
  recording = false,
  centered = false,
}: {
  prompt: string;
  checking?: boolean;
  recording?: boolean;
  /**
   * In the middle of the stage (a "No camera" note), not 16 pt under its top edge: plain grey
   * 15/500 text, no pill (a quiet note, not the heaviest thing on the screen).
   */
  centered?: boolean;
}) {
  if (centered && !checking && !recording) {
    return (
      <View style={styles.stageNote} testID="stage-bubble">
        <Text style={[type.section, styles.stageNoteText]}>{prompt}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.bubble, centered && styles.bubbleCentered]} testID="stage-bubble">
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />
      {checking ? (
        <CheckingLabel />
      ) : recording ? (
        <View style={styles.recording}>
          <View style={styles.redDot} />
          <Text style={type.heading}>{prompt}</Text>
        </View>
      ) : (
        <Text style={type.heading}>{prompt}</Text>
      )}
    </View>
  );
}

/** Round capture button: a white ring and disc; while recording, a small red square inside. */
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
          borderRadius: active ? radius.sm : inner / 2,
          backgroundColor: disabled ? palette.textTertiary : active ? palette.danger : palette.text,
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
  // On an iPad the sheet is as wide as the column the screens sit in, centred at the bottom.
  const column = useColumn();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.sheetBackdrop} onPress={onCancel} accessibilityLabel="Close">
        <View style={[StyleSheet.absoluteFill, styles.backdropTint]} />
      </Pressable>
      <BackdropProvider value="raised">
        <View style={[styles.sheet, column.wide && { width: column.width, alignSelf: 'center' }]}>
          <View style={styles.grabber} />
          {/* Up to 3 lines: "{Name} wants to call it off. Refund both?" must show whole. */}
          <Label variant="subtitle" lines={3}>
            {title}
          </Label>
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
      </BackdropProvider>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------

const styles = StyleSheet.create({
  flex: { flex: 1 },
  button: {
    height: space.control,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.x3,
  },
  dimmed: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
  primary: { backgroundColor: color.primaryAction, boxShadow: material.bloomPrimary },
  secondary: { backgroundColor: palette.fill },
  text: { backgroundColor: 'transparent', height: dp(44), paddingHorizontal: half.x15 },
  small: { height: space.x4 + half.x05, paddingHorizontal: space.x2 },
  dense: { height: space.x4 },
  dangerFilled: { backgroundColor: color.destructive },
  alertSlot: { height: space.x4, alignItems: 'center', justifyContent: 'center' },
  alert: { color: color.fixable },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: color.divider },
  header: {
    height: space.x7,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.page,
    gap: space.x2,
  },
  back: {
    width: dp(24),
    height: dp(44),
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  segments: { flex: 1, flexDirection: 'row', gap: half.x05 },
  segment: { flex: 1, height: glyph.bar, borderRadius: glyph.bar / 2 },
  tagSlot: { minWidth: space.x1, alignItems: 'flex-end', paddingRight: space.page },
  step: { flex: 1, paddingHorizontal: space.page, paddingBottom: space.x2, paddingTop: space.x1 },
  stepBody: { marginTop: space.x1 },
  stepContent: { flex: 1, marginTop: space.x4 },
  stepContentTight: { marginTop: space.x3 },
  secondaryAction: { marginTop: space.x1 },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: half.x15,
    paddingVertical: space.x1,
    alignSelf: 'flex-start',
  },
  box: {
    width: space.x3,
    height: space.x3,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: color.selected },
  boxOff: { borderWidth: 2, borderColor: palette.textTertiary },
  row: {
    minHeight: space.row,
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
    borderRadius: radius.pill,
    overflow: 'hidden',
    paddingHorizontal: space.x3,
    paddingVertical: half.x15,
    marginTop: space.x2,
  },
  bubbleCentered: { marginTop: 0 },
  stageNote: { alignSelf: 'center', paddingHorizontal: space.x3 },
  stageNoteText: { textAlign: 'center' },
  scrim: { backgroundColor: palette.background, opacity: 0.72 },
  recording: { flexDirection: 'row', alignItems: 'center', gap: space.x1 },
  redDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.danger },
  shutter: {
    width: space.x8 + space.x1,
    height: space.x8 + space.x1,
    borderRadius: (space.x8 + space.x1) / 2,
    borderWidth: 3,
    borderColor: palette.text,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  fieldLabel: { marginBottom: space.x1 },
  field: {
    fontFamily: type.input.fontFamily,
    fontSize: type.input.fontSize,
    fontWeight: type.input.fontWeight,
    height: space.control,
    borderRadius: radius.md,
    borderWidth: border.focused,
    paddingHorizontal: space.x2,
    color: palette.text,
  },
  sheetBackdrop: { flex: 1 },
  backdropTint: { backgroundColor: palette.background, opacity: 0.72 },
  sheet: {
    backgroundColor: palette.surface,
    backgroundImage: material.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.page,
    paddingTop: half.x15,
    paddingBottom: space.x5,
  },
  grabber: {
    alignSelf: 'center',
    width: space.x5,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.textTertiary,
    marginBottom: space.x3,
  },
  sheetButtons: { flexDirection: 'row', gap: half.x15, marginTop: space.x4 },
});
