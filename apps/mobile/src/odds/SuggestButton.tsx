// "Suggest odds": ask the judge for odds on this bet (POST /v1/bets/:id/odds/suggest). The judge
// works them out from the performer's record; the answer is only an offer, which both still
// accept on their phones. In the typed form (nothing proposed yet) the suggestion fills the picker.
import { QuietButton } from '../ui/kit';
import { COPY, t } from '../screens/copy';

export interface SuggestPanel {
  busy: boolean;
  disabled?: boolean | undefined;
  onPress: () => void;
}

export function SuggestButton({ panel }: { panel: SuggestPanel }) {
  return (
    <QuietButton
      testID="odds-suggest"
      label={panel.busy ? t(COPY.odds.suggesting) : t(COPY.odds.suggestOdds)}
      busy={panel.busy}
      disabled={panel.disabled === true}
      onPress={panel.onPress}
    />
  );
}
