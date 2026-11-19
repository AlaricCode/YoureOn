// The odds picker: Even / 2:1 / 3:1 / 5:1, "I give" / "I get", and a readout of both stakes
// ("You $15 · Jake $5"). In the typed form the stake chips above it are the base (the smaller
// stake); in the counter sheet it brings its own base chips. State and maths live in app/odds.
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  ODDS_PRESETS,
  pickBase,
  pickDir,
  pickPreset,
  type OddsControl as Control,
} from '../app/odds';
import { COPY, t } from '../screens/copy';
import { Label } from '../ui/kit';
import { DataText } from '../ui/parts';
import { color, palette, radius, space, TABULAR, type } from '../ui/tokens';
import { SuggestButton, type SuggestPanel } from './SuggestButton';

export interface OddsControlPanel {
  control: Control;
  /** "You $15 · Jake $5", or a short note when the picker can't make the stakes. */
  readout: string | null;
  /** Base chips (dollars) for the counter sheet; the typed form has its own stake chips. */
  bases?: readonly number[] | undefined;
  disabled?: boolean | undefined;
  onChange: (c: Control) => void;
}

export function OddsControlView({ panel }: { panel: OddsControlPanel }) {
  const c = panel.control;
  const off = panel.disabled === true;
  return (
    <View style={styles.wrap}>
      <Label variant="small" style={styles.label}>
        {t(COPY.odds.title)}
      </Label>
      <View style={styles.row} accessibilityRole="radiogroup">
        {ODDS_PRESETS.map((p) => (
          <Seg
            key={p}
            testID={`odds-preset-${p}`}
            text={p === 'Even' ? t(COPY.odds.even) : p}
            on={c.preset === p}
            disabled={off}
            onPress={() => panel.onChange(pickPreset(c, p))}
          />
        ))}
        {c.preset === 'custom' ? (
          <Seg testID="odds-preset-custom" text={t(COPY.odds.custom)} on disabled onPress={null} />
        ) : null}
      </View>
      <View style={styles.row} accessibilityRole="radiogroup">
        <Seg
          testID="odds-dir-give"
          text={t(COPY.odds.iGive)}
          on={c.preset !== 'Even' && c.dir === 'give'}
          disabled={off || c.preset === 'Even'}
          onPress={() => panel.onChange(pickDir(c, 'give'))}
        />
        <Seg
          testID="odds-dir-get"
          text={t(COPY.odds.iGet)}
          on={c.preset !== 'Even' && c.dir === 'get'}
          disabled={off || c.preset === 'Even'}
          onPress={() => panel.onChange(pickDir(c, 'get'))}
        />
      </View>
      {panel.bases ? (
        <>
          <Label variant="small" style={styles.label}>
            {t(COPY.odds.base)}
          </Label>
          <View style={styles.row} accessibilityRole="radiogroup">
            {panel.bases.map((usd) => (
              <Seg
                key={usd}
                testID={`odds-base-${usd}`}
                text={`$${usd}`}
                on={c.preset !== 'custom' && c.baseUsd === usd}
                disabled={off}
                onPress={() => panel.onChange(pickBase(c, usd))}
              />
            ))}
          </View>
        </>
      ) : null}
      {panel.readout ? <DataText muted>{panel.readout}</DataText> : null}
    </View>
  );
}

/** A's typed form: the picker under the stake chips, then "Suggest odds" and its answer. */
export interface TypedOddsPanel {
  control: OddsControlPanel;
  suggest: SuggestPanel | null;
  /** The judge's line for the suggestion, or a short error (copy-checked). */
  note: string | null;
}

export function TypedOdds({ panel }: { panel: TypedOddsPanel }) {
  return (
    <View style={styles.wrap}>
      <OddsControlView panel={panel.control} />
      {panel.suggest ? <SuggestButton panel={panel.suggest} /> : null}
      {panel.note ? <DataText muted>{panel.note}</DataText> : null}
    </View>
  );
}

function Seg({
  text,
  on,
  disabled,
  onPress,
  testID,
}: {
  text: string;
  on: boolean;
  disabled: boolean;
  onPress: (() => void) | null;
  testID: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected: on, disabled }}
      disabled={disabled || onPress === null}
      onPress={onPress ?? undefined}
      style={({ pressed }) => [
        styles.seg,
        { backgroundColor: on ? color.selected : palette.fill },
        disabled && !on && styles.segDim,
        pressed && !disabled && styles.segPressed,
      ]}
    >
      <Text
        style={[type.rowMedium, { color: on ? color.onPrimary : palette.text }, styles.segInk]}
        numberOfLines={1}
      >
        {text}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.x1 },
  label: { color: palette.textSecondary, marginTop: space.x1 },
  row: { flexDirection: 'row', gap: space.x1 },
  // Limelight chips (ui/parts ChoiceChip): glass pills, the selected one white with black ink.
  seg: {
    flex: 1,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segInk: { fontVariant: TABULAR },
  segDim: { opacity: 0.4 },
  segPressed: { opacity: 0.7 },
});
