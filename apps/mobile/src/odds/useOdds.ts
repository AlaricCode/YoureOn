// The odds panels for the negotiate screen, as two hooks so DemoApp wires them in a line each:
//   useOddsPanel   both phones: the open offer (Accept / Counter / Withdraw), the counter sheet,
//                  "Suggest odds" and "Offer odds" while the card is on the table, "Odds agreed".
//   useTypedOdds   A's typed form: the odds picker next to the stake chips, and "Suggest odds",
//                  which before the first proposal fills the picker from the judge's suggestion.
// Everything they decide is in app/odds (pure, tested); these only hold the in-flight bits.
import { useCallback, useEffect, useState } from 'react';

import { MAX_STAKE } from '@youre-on/shared/constants';
import type { Party } from '@youre-on/shared/primitives';

import {
  acceptOdds,
  controlOf,
  controlStakes,
  offerCardView,
  oddsAgreedShown,
  oddsApply,
  offerOdds,
  readout,
  suggestOdds,
  typedSuggestBody,
  withdrawOdds,
  type OddsControl,
} from '../app/odds';
import { TYPED_STAKES_USD, typedStakes, type TypedEvent, type TypedState } from '../app/typedTerms';
import type { BetModel } from '../bets/store';
import type { YoApi } from '../net/api';
import { isCopyOk } from '../ui/copyRule';
import type { TypedOddsPanel } from './OddsControl';
import type { OddsOfferPanel } from './OfferCard';

type OddsApi = Pick<YoApi, 'offerOdds' | 'acceptOdds' | 'withdrawOdds' | 'suggestOdds'>;

const sayOrNull = (s: string) => (isCopyOk(s, 'body') ? s : null);

export function useOddsPanel(i: {
  api: OddsApi;
  bet: BetModel | null;
  me: Party | null;
  theirName: string;
  onFailed?: () => void;
}): OddsOfferPanel | undefined {
  const { api, bet, me, theirName, onFailed } = i;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [counter, setCounter] = useState<OddsControl | null>(null);
  const betId = bet?.bet_id ?? null;
  useEffect(() => {
    setBusy(false);
    setNote(null);
    setCounter(null);
  }, [betId]);

  const run = useCallback(
    async (f: () => Promise<{ ok: true } | { ok: false; note: string }>, after?: () => void) => {
      setBusy(true);
      setNote(null);
      const r = await f();
      setBusy(false);
      if (r.ok) after?.();
      else {
        setNote(r.note);
        onFailed?.();
      }
    },
    [onFailed],
  );

  const terms = bet?.envelope?.terms ?? null;
  if (!bet || !me || !terms || !oddsApply(terms)) return undefined;
  const input = { odds: bet.odds, me, state: bet.state, terms };
  const card = offerCardView(input);
  const agreed = oddsAgreedShown(input);
  const onTable = bet.state === 'TERMS_PROPOSED';
  const sheet = counter ? controlStakes(counter, me, MAX_STAKE) : null;
  const id = bet.bet_id;

  return {
    card,
    agreed,
    busy,
    note,
    counter: counter
      ? {
          control: counter,
          readout: sheet?.ok ? readout(sheet.stakes, me, theirName) : (sheet?.note ?? null),
          bases: TYPED_STAKES_USD,
          disabled: busy,
          onChange: setCounter,
        }
      : null,
    suggest:
      onTable && !card && !agreed
        ? {
            busy,
            onPress: () =>
              void run(async () => {
                const r = await suggestOdds({ api }, { betId: id, body: {} });
                return r.ok ? { ok: true } : r;
              }),
          }
        : null,
    canPropose: onTable && !card && !agreed,
    onAccept: () => {
      if (!card) return;
      void run(() => acceptOdds({ api }, { betId: id, offerId: card.offerId, n: card.n }));
    },
    onCounter: () => setCounter(card ? card.counterFrom : controlOf(terms.stakes, me)),
    onSend: () => {
      if (!sheet) return;
      if (!sheet.ok) return setNote(sheet.note);
      void run(
        () => offerOdds({ api }, { betId: id, stakes: sheet.stakes }),
        () => setCounter(null),
      );
    },
    onCancel: () => setCounter(null),
    onWithdraw: () => {
      if (!card) return;
      void run(() => withdrawOdds({ api }, { betId: id, offerId: card.offerId }));
    },
  };
}

export function useTypedOdds(i: {
  api: OddsApi;
  bet: BetModel | null;
  typed: TypedState;
  dispatch: (e: TypedEvent) => void;
  theirName: string;
  /** Only while the form is up (A's phone, typed mode). */
  enabled: boolean;
}): TypedOddsPanel | undefined {
  const { api, bet, typed, dispatch, theirName, enabled } = i;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const betId = bet?.bet_id ?? null;
  useEffect(() => {
    setBusy(false);
    setNote(null);
  }, [betId]);
  if (!enabled || !bet || typed.bet_id !== bet.bet_id) return undefined;

  const frozen =
    typed.phase === 'sending' || typed.phase === 'confirming' || typed.phase === 'confirmed';
  const stakes = typedStakes(typed);
  // Nothing proposed yet: the suggestion fills the picker. Once the card is out, the judge's
  // offer goes to both phones (the offer card) instead.
  const drafting = bet.state === 'DRAFTING' || bet.envelope === null;
  const suggest = async () => {
    setBusy(true);
    setNote(null);
    const r = await suggestOdds(
      { api },
      { betId: bet.bet_id, body: drafting ? typedSuggestBody(typed.claim, typed.stakeUsd) : {} },
    );
    setBusy(false);
    if (!r.ok) return setNote(r.note);
    if (drafting) dispatch({ type: 'odds', control: controlOf(r.offer.stakes, 'A') });
    setNote(sayOrNull(r.say));
  };

  return {
    control: {
      control: typed.odds,
      readout: stakes.ok ? readout(stakes.stakes, 'A', theirName) : stakes.note,
      disabled: frozen,
      onChange: (control) => dispatch({ type: 'odds', control }),
    },
    suggest: {
      busy,
      disabled: frozen || typed.claim.trim().length === 0,
      onPress: () => void suggest(),
    },
    note,
  };
}
