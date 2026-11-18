// SCHEMAS §2 — Terms, the only binding record. terms_hash = sha256(JCS(Terms)) goes onchain.
// Hashed records use z.strictObject (unknown keys are errors) and have no optional keys.
import { z } from 'zod/v4';
import { CENT, MAX_ODDS_RATIO, MAX_STAKE, MIN_STAKE } from './constants';
import { GeminiStrike, pctFromPrice, splitPot } from './gemini';
import { jcs, hashJcs } from './jcs';
import { fromMicro, isMicroUsdcString, MicroUsdc } from './money';
import {
  BetId,
  DisplayName,
  Hex32,
  IsoUtc,
  IsoUtcWholeSecond,
  NText,
  Party,
  Pubkey,
  sha256Hex,
} from './primitives';

export const AttemptRule = z.enum(['single', 'first_success', 'best_of', 'all_of']);
export type AttemptRule = z.infer<typeof AttemptRule>;

export const Attempts = z
  .strictObject({ count: z.number().int().min(1).max(5), rule: AttemptRule })
  .superRefine((a, ctx) => {
    if ((a.rule === 'single') !== (a.count === 1))
      ctx.addIssue({ code: 'custom', message: "count = 1 iff rule = 'single'" });
    if (a.rule === 'best_of' && a.count % 2 === 0)
      ctx.addIssue({ code: 'custom', message: 'best_of needs an odd count' });
  });

export const EdgeCase = z.strictObject({
  question: NText(160),
  answer: NText(160),
  asked_by: z.literal('judge'),
});

export const Stake = MicroUsdc.refine((s) => {
  if (!isMicroUsdcString(s)) return true; // already reported by MicroUsdc
  const n = BigInt(s);
  return n >= MIN_STAKE && n <= MAX_STAKE && n % CENT === 0n;
}, 'stake: whole cents, MIN_STAKE..max_stake');
export const Stakes = z.strictObject({ a: Stake, b: Stake, currency: z.literal('USDC') });

/** P(YES) as Gemini quotes it, 0.05..0.95 with exactly 2 dp. */
const PRICE_PCT_RE = /^0\.(0[5-9]|[1-8][0-9]|9[0-5])$/;
export const PricePct = z.string().regex(PRICE_PCT_RE, '0.05..0.95, exactly 2 dp');

/** camelCase: mirrors Gemini. Copied from a GeminiMarketSnapshot, never typed by the LLM. */
export const MarketRef = z.strictObject({
  venue: z.literal('gemini'),
  /** e.g. "BTC05M2611211810" (from the API). */
  eventTicker: z.string().min(1).max(64),
  /** e.g. "GEMI-BTC05M2611211810-UP" (from the API, never built). */
  instrumentSymbol: z.string().min(1).max(64),
  /** Party A's side; B holds the other. */
  side: z.enum(['YES', 'NO']),
  priceAtLock: PricePct,
  priceSource: z.enum(['mid', 'last_in_spread']),
  quotedAt: IsoUtc,
  strike: GeminiStrike,
  expiry: IsoUtcWholeSecond,
});
export type MarketRef = z.infer<typeof MarketRef>;

export const EscrowRef = z.strictObject({
  cluster: z.enum(['devnet', 'localnet']),
  program_id: Pubkey,
  mint: Pubkey,
});
export const TermsParty = z.strictObject({ pubkey: Pubkey, display_name: DisplayName });

export const TermsV1 = z
  .strictObject({
    schema_version: z.literal(1),
    bet_id: BetId,
    escrow: EscrowRef,
    party_a: TermsParty,
    party_b: TermsParty,
    type: z.enum(['skill', 'real_world']),
    claim: NText(200),
    performer: Party.nullable(),
    yes_party: Party,
    attempts: Attempts,
    success_criteria: z.array(NText(160)).min(1).max(5),
    failure_criteria: z.array(NText(160)).max(5),
    edge_cases: z.array(EdgeCase).max(4),
    evidence_source: z.enum(['camera', 'gemini']),
    market: MarketRef.nullable(),
    stakes: Stakes,
    deadline: IsoUtcWholeSecond,
    created_at: IsoUtc,
  })
  .superRefine((t, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (t.party_a.pubkey === t.party_b.pubkey) bad(['party_b', 'pubkey'], 'A and B must differ');
    if (Date.parse(t.deadline) <= Date.parse(t.created_at))
      bad(['deadline'], 'deadline must be after created_at');
    if (t.type === 'skill') {
      if (t.evidence_source !== 'camera') bad(['evidence_source'], "skill => 'camera'");
      if (t.market !== null) bad(['market'], 'skill => null');
      if (t.performer === null) bad(['performer'], 'skill => required');
      // Odds (widened in place, no version bump, SCHEMAS §11): unequal stakes are allowed up to
      // MAX_ODDS_RATIO : 1. Equal stakes hash exactly as before.
      if (isMicroUsdcString(t.stakes.a) && isMicroUsdcString(t.stakes.b)) {
        const a = BigInt(t.stakes.a);
        const b = BigInt(t.stakes.b);
        const hi = a > b ? a : b;
        const lo = a > b ? b : a;
        if (hi > MAX_ODDS_RATIO * lo) bad(['stakes'], 'skill => odds at most 10:1');
      }
    } else {
      if (t.evidence_source !== 'gemini') bad(['evidence_source'], "real_world => 'gemini'");
      if (t.performer !== null) bad(['performer'], 'real_world => null');
      if (t.attempts.rule !== 'single') bad(['attempts'], "real_world => 'single'");
      if (t.market === null) return bad(['market'], 'real_world => required');
      if (t.yes_party !== (t.market.side === 'YES' ? 'A' : 'B'))
        bad(['yes_party'], 'must match market.side');
      if (Date.parse(t.deadline) < Date.parse(t.market.expiry))
        bad(['deadline'], 'must be >= market.expiry');
      // Zod 4 runs this refinement even when a nested regex failed; those are already reported.
      if (
        !isMicroUsdcString(t.stakes.a) ||
        !isMicroUsdcString(t.stakes.b) ||
        !PRICE_PCT_RE.test(t.market.priceAtLock)
      )
        return;
      const pot = BigInt(t.stakes.a) + BigInt(t.stakes.b);
      const fair = splitPot(pot, t.market.side, pctFromPrice(t.market.priceAtLock)); // §8
      if (fromMicro(fair.a) !== t.stakes.a || fromMicro(fair.b) !== t.stakes.b)
        bad(['stakes'], 'stakes != fair split of pot at priceAtLock');
    }
  });
/** Later: z.discriminatedUnion('schema_version', [TermsV1, TermsV2]) (§11 rule 2). */
export const Terms = TermsV1;
export type Terms = z.infer<typeof Terms>;

/** Presentation-only (not hashed). */
export const TermsPresentation = z.object({
  title: z.string().max(40),
  readback: z.string().max(400),
  stakes_display: z.string().max(40),
  odds_display: z.string().max(12).nullable(),
  party_a_avatar_url: z.url().nullable(),
  party_b_avatar_url: z.url().nullable(),
});
export type TermsPresentation = z.infer<typeof TermsPresentation>;

/** Every client that parses an envelope recomputes the hash; a mismatch fails the parse. */
export const TermsEnvelope = z
  .object({ terms: Terms, terms_hash: Hex32, presentation: TermsPresentation })
  .refine((e) => hashJcs(e.terms) === e.terms_hash, {
    message: 'terms_hash mismatch',
    path: ['terms_hash'],
  });
export type TermsEnvelope = z.infer<typeof TermsEnvelope>;

/** Strict parse → JCS → SHA-256. Throws on unknown keys and on unnormalized text. */
export function computeTermsHash(input: unknown): {
  terms: Terms;
  canonical: string;
  terms_hash: string;
} {
  const terms = Terms.parse(input);
  const canonical = jcs(terms);
  return { terms, canonical, terms_hash: sha256Hex(canonical) };
}

/** The "terms code" shown on the card: the first 8 hex chars of terms_hash (brief 5f). */
export const termsCode = (termsHash: string): string => Hex32.parse(termsHash).slice(0, 8);
