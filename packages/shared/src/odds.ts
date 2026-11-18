// SCHEMAS §3.5, API-CONTRACT §2.19 — odds offers between the two parties, and the judge's
// history-grounded suggestion. Wire + realtime shapes and the pure fold every reader shares
// (the server's confirm gate, the phones, the stage).
//
// Model: the terms card (bet_terms_versions, terms.proposed) stays the only binding record; its
// Terms.stakes.a / .b ARE the odds (no new hashed field). An odds offer is a consent object in
// the bet's event log, keyed by the stakes pair:
//   odds.offered   {offer}                     a party (or the judge) proposes stakes a/b
//   odds.answered  {offer_id, party, answer}   accepted | countered | withdrawn | superseded
//   odds.agreed    {offer_id, stakes, …}       both accepted: these stakes are agreed
// Agreement is of a stakes pair, so it survives a re-proposal with identical stakes (an edge-case
// edit needs no re-consent). Both still hold to confirm the final card (terms_hash binds stakes).
import { z } from 'zod/v4';
import { HeadToHead } from './api';
import { ChallengeCategory } from './challenge-category';
import { OddsRatio } from './odds-math';
import { Hex32, IsoUtc, NText, Party, Uuid } from './primitives';
import { Attempts, Stake } from './terms';

export const OddsStakes = z.object({ a: Stake, b: Stake });
export type OddsStakes = z.infer<typeof OddsStakes>;

export const WinLoss = z.enum(['W', 'L']);

/** The performer's record the judge's suggestion is grounded in (settled bets, incl. seed rows). */
export const PerformerStats = z.object({
  performer: z.object({ party: Party, display_name: z.string() }),
  category: ChallengeCategory,
  category_label: z.string(),
  /** Every settled bet of the performer, as either party and any role. */
  overall: z.object({
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    pushes: z.number().int().nonnegative(),
  }),
  /** As the performer of a skill bet in this category: claims made / tried. */
  in_category: z.object({
    made: z.number().int().nonnegative(),
    tries: z.number().int().nonnegative(),
  }),
  /** As the performer of any skill bet. */
  as_performer: z.object({
    made: z.number().int().nonnegative(),
    tries: z.number().int().nonnegative(),
  }),
  /** Performer results (made = W), newest first. */
  recent: z.array(WinLoss).max(5),
  streak: z.object({ kind: WinLoss, n: z.number().int().positive() }).nullable(),
  /** The performer vs this opponent (face/service.ts headToHead). */
  h2h: HeadToHead,
  /** Any contributing row is labelled demo history (bets.is_seed): show "Demo history". */
  includes_seed: z.boolean(),
});
export type PerformerStats = z.infer<typeof PerformerStats>;

export const OddsSource = z.enum(['model', 'template', 'default']);

/** The judge's suggestion. Every number is computed in code; a model only words `reason`. */
export const OddsSuggestion = z.object({
  ratio: OddsRatio,
  favored: Party.nullable(),
  stakes: OddsStakes,
  /** P(the claim succeeds) after the attempt rule, rounded. */
  chance_pct: z.number().int().min(1).max(99),
  fair_ratio: z.number(),
  /** The rungs the ratio could be picked from. */
  allowed: z.array(OddsRatio).min(1).max(2),
  base_rate_pct: z.number().int().min(0).max(100),
  sample_meaningful: z.boolean(),
  stats: PerformerStats,
  reason: NText(160),
  source: OddsSource,
  model: z.string().nullable(),
  cache_key: Hex32,
});
export type OddsSuggestion = z.infer<typeof OddsSuggestion>;

export const OddsFrom = z.enum(['A', 'B', 'judge']);
export type OddsFrom = z.infer<typeof OddsFrom>;

export const OddsOffer = z.object({
  offer_id: Uuid,
  /** Per-bet offer number: 1 + the count of earlier odds.offered. */
  n: z.number().int().min(1),
  /** The offer this one counters (or the parent of the one it superseded). */
  parent_id: Uuid.nullable(),
  from: OddsFrom,
  stakes: OddsStakes,
  /** ratioLabel(stakes): "3 to 1", "Even", "15 to 7". */
  ratio_label: z.string().max(16),
  /** Who puts in more (the favourite), null for even. */
  favored: Party.nullable(),
  /** The card when the offer was made; null for a judge suggestion while still DRAFTING. */
  terms_hash: Hex32.nullable(),
  suggestion: OddsSuggestion.nullable(),
  created_at: IsoUtc,
});
export type OddsOffer = z.infer<typeof OddsOffer>;

export const OddsAnswer = z.enum(['accepted', 'countered', 'withdrawn', 'superseded']);
export type OddsAnswer = z.infer<typeof OddsAnswer>;

export const OddsOfferedPayload = z.object({ offer: OddsOffer });
export const OddsAnsweredPayload = z.object({
  offer_id: Uuid,
  /** The party that answered; for 'superseded' / 'countered', the author of the new offer (or A for the judge). */
  party: Party,
  answer: OddsAnswer,
  /** The offer that countered / superseded this one. */
  by_offer_id: Uuid.nullable(),
});
export const OddsAgreedPayload = z.object({
  offer_id: Uuid,
  stakes: OddsStakes,
  ratio_label: z.string().max(16),
  /** The card (possibly recomposed with these stakes) both now confirm. */
  terms_hash: Hex32,
});

// ---- requests / responses (API-CONTRACT §2.19) -------------------------------------------------

/** Dollars like "15" or "7.50". */
const Usd = z.string().min(1).max(16);

export const OddsOfferRequest = z.union([
  z.object({ stakes_usd: z.object({ a: Usd, b: Usd }) }),
  z.object({ ratio: OddsRatio, favored: Party.nullable(), base_usd: Usd }),
]);
export type OddsOfferRequest = z.infer<typeof OddsOfferRequest>;

/** `n` is the offer number the phone showed (a stale tap is refused). */
export const OddsAcceptRequest = z.object({ n: z.number().int().min(1) });
export type OddsAcceptRequest = z.infer<typeof OddsAcceptRequest>;

/** The claim fields are used only while DRAFTING (typed form); TERMS_PROPOSED reads the card. */
export const OddsSuggestRequest = z.object({
  base_usd: Usd.optional(),
  claim: z.string().min(1).max(400).optional(),
  performer: Party.optional(),
  attempts: Attempts.optional(),
});
export type OddsSuggestRequest = z.infer<typeof OddsSuggestRequest>;

export const OddsOfferResponse = z.object({
  offer: OddsOffer,
  agreed: z.boolean(),
  terms_hash: Hex32.nullable(),
});
export type OddsOfferResponse = z.infer<typeof OddsOfferResponse>;

export const OddsSuggestResponse = z.object({ offer: OddsOffer, say: z.string() });
export type OddsSuggestResponse = z.infer<typeof OddsSuggestResponse>;

const bet = (id: string) => `/v1/bets/${encodeURIComponent(id)}/odds`;
export const oddsOfferPath = (betId: string) => `${bet(betId)}/offer`;
export const oddsAcceptPath = (betId: string, offerId: string) =>
  `${bet(betId)}/${encodeURIComponent(offerId)}/accept`;
export const oddsWithdrawPath = (betId: string, offerId: string) =>
  `${bet(betId)}/${encodeURIComponent(offerId)}/withdraw`;
export const oddsSuggestPath = (betId: string) => `${bet(betId)}/suggest`;

// ---- the fold ----------------------------------------------------------------------------------

export type OfferStatus = 'open' | 'agreed' | OddsAnswer;

export interface OddsState {
  /** The one open offer (at most one at a time). */
  open: OddsOffer | null;
  /** Who has accepted the open offer (an A/B offer's author counts as accepted). */
  accepted_by: Party[];
  /** Every agreed stakes pair, oldest first. */
  agreed: Array<{ a: string; b: string; offer_id: string; terms_hash: string | null }>;
  /** Every offer, oldest first. */
  history: OddsOffer[];
  status: Record<string, OfferStatus>;
  /** Count of odds.offered seen (the next offer's n is this + 1). */
  count: number;
}

export const emptyOdds = (): OddsState => ({
  open: null,
  accepted_by: [],
  agreed: [],
  history: [],
  status: {},
  count: 0,
});

const authorOf = (o: OddsOffer): Party[] => (o.from === 'judge' ? [] : [o.from]);
const covers = (s: readonly Party[]) => s.includes('A') && s.includes('B');

/** Applies one event (any type; non-odds events are ignored). Returns a new state. */
export function oddsReducer(state: OddsState, ev: { type: string; payload: unknown }): OddsState {
  if (ev.type === 'odds.offered') {
    const p = OddsOfferedPayload.safeParse(ev.payload);
    if (!p.success) return state;
    const offer = p.data.offer;
    if (state.status[offer.offer_id]) return state;
    const status = { ...state.status };
    // At most one open offer: a new one implicitly closes the old one.
    if (state.open && status[state.open.offer_id] === 'open')
      status[state.open.offer_id] = 'superseded';
    status[offer.offer_id] = 'open';
    return {
      ...state,
      open: offer,
      accepted_by: authorOf(offer),
      history: [...state.history, offer],
      status,
      count: state.count + 1,
    };
  }
  if (ev.type === 'odds.answered') {
    const p = OddsAnsweredPayload.safeParse(ev.payload);
    if (!p.success) return state;
    const { offer_id, party, answer } = p.data;
    const cur = state.status[offer_id];
    if (!cur || cur !== 'open') return state;
    const isOpen = state.open?.offer_id === offer_id;
    if (answer === 'accepted') {
      if (!isOpen) return state;
      const acc = state.accepted_by.includes(party)
        ? state.accepted_by
        : [...state.accepted_by, party];
      if (!covers(acc)) return { ...state, accepted_by: acc };
      const o = state.open!;
      return {
        ...state,
        open: null,
        accepted_by: [],
        agreed: [
          ...state.agreed,
          { a: o.stakes.a, b: o.stakes.b, offer_id: o.offer_id, terms_hash: o.terms_hash },
        ],
        status: { ...state.status, [offer_id]: 'agreed' },
      };
    }
    return {
      ...state,
      open: isOpen ? null : state.open,
      accepted_by: isOpen ? [] : state.accepted_by,
      status: { ...state.status, [offer_id]: answer },
    };
  }
  if (ev.type === 'odds.agreed') {
    const p = OddsAgreedPayload.safeParse(ev.payload);
    if (!p.success) return state;
    const { offer_id, stakes, terms_hash } = p.data;
    const agreed = state.agreed.some((x) => x.offer_id === offer_id)
      ? state.agreed.map((x) => (x.offer_id === offer_id ? { ...x, terms_hash } : x))
      : [...state.agreed, { a: stakes.a, b: stakes.b, offer_id, terms_hash }];
    const isOpen = state.open?.offer_id === offer_id;
    return {
      ...state,
      open: isOpen ? null : state.open,
      accepted_by: isOpen ? [] : state.accepted_by,
      agreed,
      status: { ...state.status, [offer_id]: 'agreed' },
    };
  }
  return state;
}

/** Folds a bet's events (oldest first). */
export function foldOdds(events: Iterable<{ type: string; payload: unknown }>): OddsState {
  let s = emptyOdds();
  for (const e of events) s = oddsReducer(s, e);
  return s;
}

/** True when both parties agreed exactly these stakes. */
export function agreedFor(state: OddsState, stakes: { a: string; b: string }): boolean {
  return state.agreed.some((x) => x.a === stakes.a && x.b === stakes.b);
}

/** Who may still accept the open offer: the parties not in accepted_by. */
export function awaitingParties(state: OddsState): Party[] {
  if (!state.open) return [];
  return (['A', 'B'] as const).filter((p) => !state.accepted_by.includes(p));
}
