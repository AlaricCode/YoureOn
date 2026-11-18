// The display strings of a concede / appeal SignRequest card (API-CONTRACT §2.18 `SignRequest.card`).
// The device policy (G2, device-policy.ts cardEquals) refuses to sign unless the server's card
// equals the phone's own rendering of it, so the server's builder and the phone MUST both call
// this one function. Every string comes from the binding Terms; `countdown_ends_at` is the bet's
// appeal_deadline (unix seconds, BetSnapshot.deadlines) as IsoUtc, which both sides know.
import { formatUsd, type MicroUsdc } from './money';
import { otherParty, type Party } from './primitives';
import { termsCode, type Terms } from './terms';
import type { SignRequest } from './api';

export type SignCardKind = SignRequest['kind'];

export function renderSignCard(a: {
  kind: SignCardKind;
  terms: Terms;
  terms_hash: string;
  /** The signing party (the loser). */
  me: Party;
  /** BetSnapshot.deadlines.appeal_deadline (unix seconds). */
  appeal_deadline: number;
}): SignRequest['card'] {
  const { terms, me } = a;
  const them = otherParty(me);
  const name = (p: Party) => (p === 'A' ? terms.party_a : terms.party_b).display_name;
  const stake = (p: Party): MicroUsdc => (p === 'A' ? terms.stakes.a : terms.stakes.b);
  const pot = (BigInt(terms.stakes.a) + BigInt(terms.stakes.b)).toString();
  let odds: string | null = null;
  if (terms.type === 'real_world') {
    const mine = BigInt(stake(me));
    const total = BigInt(pot);
    const pct = Number((mine * 100n + total / 2n) / total);
    odds = `${pct}/${100 - pct}`;
  }
  const concede = a.kind === 'concede';
  return {
    title: concede ? 'GG' : 'Appeal',
    prompt_message: concede ? `Pay ${name(them)}` : 'Appeal the ruling',
    hold_label: concede ? 'Hold to pay' : 'Hold to appeal',
    stakes_line: formatUsd(stake(me)),
    pot_line: formatUsd(pot),
    odds_display: odds,
    terms_code: termsCode(a.terms_hash),
    countdown_ends_at: new Date(a.appeal_deadline * 1000).toISOString(),
  };
}
