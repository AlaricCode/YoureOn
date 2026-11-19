// Pure core of the propose_terms webhook (API-CONTRACT §4.2–§4.3): evaluate the LLM's call and
// build the < 300 B reply the judge speaks. No I/O, so the server handler and the fixture
// runner give identical answers.
import { MAX_STAKE, MICRO_PER_USD, MIN_STAKE } from '../constants';
import { formatUsd } from '../money';
import type { GuardrailRefusal, TermsProposal } from '../negotiation';
import { matchRefusalCategory, prefilterRefusal, REFUSAL_QUIPS } from './guardrails';
import {
  mapProposeTermsArgs,
  missingFields,
  stakeIssue,
  type ArgIssue,
  type DraftIssue,
} from './propose-terms';

/** API-CONTRACT §4.2: JSON < 300 B, `say` ≤ 200 chars. */
export const TOOL_REPLY_MAX_BYTES = 299;
export const SAY_MAX_CHARS = 200;

export type ProposeEvaluation =
  | { kind: 'invalid'; issues: ArgIssue[] }
  | { kind: 'issue'; issue: DraftIssue; proposal: TermsProposal | null }
  | { kind: 'refused'; refusal: GuardrailRefusal; proposal: TermsProposal | null }
  | { kind: 'proposal'; proposal: TermsProposal; missing: Array<keyof TermsProposal> };

export interface EvaluateOptions {
  maxStake?: bigint;
  /**
   * SCHEMAS §2.2: real_world bets with our escrow are a devnet demo exception, and they need
   * the Gemini market service (D1-J3). Until both are on, real_world gets NO_MARKET.
   */
  realWorldEnabled?: boolean;
  /**
   * DANCE-OFF §1: a dance off is proposed only through POST /terms/dance (danceTermsArgs), never
   * by the voice agent. Default: allowed only for a projection with no `conversation_id`, which
   * every ElevenLabs webhook body carries; pass `true` from the /terms/dance route to be explicit.
   */
  allowDanceOff?: boolean;
}

/** The voice webhook body always carries the conversation id; the /terms/dance projection never. */
const fromConversation = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && 'conversation_id' in raw;

const ID_KEYS = new Set(['conversation_id', 'bet_id']);
function strings(v: unknown, out: string[] = [], key = ''): string[] {
  if (typeof v === 'string') {
    if (!ID_KEYS.has(key)) out.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) strings(x, out, k);
  return out;
}

/**
 * Order matters: a refusal outranks every other answer (an unsafe bet over the cap is refused,
 * not counter-proposed), and the prefilter also runs on unparseable calls.
 */
export function evaluateProposeTerms(raw: unknown, opts: EvaluateOptions = {}): ProposeEvaluation {
  const mapped = mapProposeTermsArgs(raw);
  if (!mapped.ok) {
    const category = matchRefusalCategory(strings(raw).join(' \n '));
    if (category)
      return {
        kind: 'refused',
        refusal: { refused: true, category, quip: REFUSAL_QUIPS[category] },
        proposal: null,
      };
    if (mapped.draftIssue) return { kind: 'issue', issue: mapped.draftIssue, proposal: null };
    return { kind: 'invalid', issues: mapped.issues };
  }
  const p = mapped.proposal;
  if (p.type === 'dance_off' && !(opts.allowDanceOff ?? !fromConversation(raw)))
    return {
      kind: 'invalid',
      issues: [{ path: 'type', message: 'dance_off only via /terms/dance' }],
    };
  const refusal = prefilterRefusal(p);
  if (refusal) return { kind: 'refused', refusal, proposal: p };
  const stake = stakeIssue(p, opts.maxStake ?? MAX_STAKE);
  if (stake) return { kind: 'issue', issue: stake, proposal: p };
  if (p.type === 'real_world' && !opts.realWorldEnabled)
    return {
      kind: 'issue',
      issue: { code: 'NO_MARKET', message: 'real_world bets are not enabled' },
      proposal: p,
    };
  return { kind: 'proposal', proposal: p, missing: missingFields(p) };
}

// ---- spoken templates -------------------------------------------------------------------

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) return String(n);
  if (n < 20) return ONES[n]!;
  const t = TENS[Math.floor(n / 10)]!;
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** "5000000" -> "five dollars"; "5200000" -> "$5.20"; "100000" -> "ten cents". */
export function spokenUsd(micro: string): string {
  const n = BigInt(micro);
  if (n % MICRO_PER_USD === 0n && n / MICRO_PER_USD <= 99n) {
    const d = Number(n / MICRO_PER_USD);
    return `${numberWords(d)} ${d === 1 ? 'dollar' : 'dollars'}`;
  }
  if (n < MICRO_PER_USD && n % 10_000n === 0n) {
    const c = Number(n / 10_000n);
    return `${numberWords(c)} ${c === 1 ? 'cent' : 'cents'}`;
  }
  return formatUsd(micro);
}

export function attemptsPhrase(a: TermsProposal['attempts']): string {
  switch (a.rule) {
    case 'single':
      return 'One try.';
    case 'first_success':
      return `Up to ${numberWords(a.count)} tries, first one that lands wins.`;
    case 'best_of':
      return `Best of ${numberWords(a.count)}.`;
    case 'all_of':
      return `${cap(numberWords(a.count))} in a row.`;
  }
}

/**
 * The spoken read-back: a server template over the proposal (API-CONTRACT §4.3: "`say` is a
 * server template over Terms, so the spoken read-back matches the card word for word").
 * Drops edge cases from the end, then the deadline, to fit SAY_MAX_CHARS.
 */
export function readbackSay(p: TermsProposal, names?: PartyNames): string {
  const head = [sentence(p.claim)];
  if (p.type === 'skill') head.push(attemptsPhrase(p.attempts));
  const edges = p.edge_cases.map((e) => sentence(e.answer));
  const deadline = p.deadline_minutes ? [`${cap(numberWords(p.deadline_minutes))} minutes.`] : [];
  const stake =
    p.type === 'skill'
      ? stakeSentence(p, names)
      : p.type === 'dance_off'
        ? DANCE_READBACK_TAIL
        : `${cap(spokenUsd(p.amount))} a side at even money, Gemini sets the odds.`;
  for (let keep = edges.length; keep >= 0; keep--) {
    for (const d of [deadline, []]) {
      const s = [...head, ...edges.slice(0, keep), ...d, stake].join(' ');
      if (s.length <= SAY_MAX_CHARS) return s;
    }
  }
  const s = [...head, stake].join(' ');
  return s.length <= SAY_MAX_CHARS ? s : `${s.slice(0, SAY_MAX_CHARS - 1)}…`;
}

/** A dance off's claim already says the stake ("$5 each"); its read-back adds the refund rule. */
export const DANCE_READBACK_TAIL = 'One round, even money. Too close to call is a refund.';

/** Display names for the read-back ("Logan puts in fifteen, Jake puts in five"). */
export interface PartyNames {
  a: string;
  b: string;
}

/** A skill proposal with unequal stakes (odds). */
export const hasOdds = (p: Pick<TermsProposal, 'type' | 'amount' | 'amount_b'>): boolean =>
  p.type === 'skill' && p.amount_b !== null && p.amount_b !== undefined && p.amount_b !== p.amount;

/** Spoken dollars without the unit word when whole ("fifteen"), else "$7.50". */
function spokenBare(micro: string): string {
  const n = BigInt(micro);
  if (n % MICRO_PER_USD === 0n && n / MICRO_PER_USD <= 99n)
    return numberWords(Number(n / MICRO_PER_USD));
  return spokenUsd(micro);
}

/**
 * "Five dollars each." or, with odds, "Logan puts in fifteen, Jake puts in five; winner takes
 * twenty." (names default to "The challenger" / "the other side").
 */
export function stakeSentence(p: TermsProposal, names?: PartyNames): string {
  if (!hasOdds(p)) return `${cap(spokenUsd(p.amount))} each.`;
  const a = names?.a.trim() || 'The challenger';
  const b = names?.b.trim() || 'the other side';
  const pot = (BigInt(p.amount) + BigInt(p.amount_b!)).toString();
  return `${cap(a)} puts in ${spokenBare(p.amount)}, ${b} puts in ${spokenBare(p.amount_b!)}; winner takes ${spokenBare(pot)}.`;
}

export function issueSay(issue: DraftIssue, maxStake: bigint = MAX_STAKE): string {
  switch (issue.code) {
    case 'STAKE_ABOVE_MAX':
      return `Max is ${spokenUsd(maxStake.toString())} a person.`;
    case 'STAKE_BELOW_MIN':
      return `Minimum is ${spokenUsd(MIN_STAKE.toString())} a person.`;
    case 'DEADLINE_TOO_FAR':
      return 'Forty-five minutes, tops. Pick a shorter deadline.';
    case 'NO_MARKET':
      return 'No Bitcoin market on the docket right now. Make it a skill bet.';
    case 'MARKET_UNFAIR':
      return "Those odds aren't fair. Pick another round.";
    case 'AMBIGUOUS':
      return 'How much each, in dollars?';
    case 'ODDS_TOO_LONG':
      return 'Ten to one, tops. Pick shorter odds.';
    default:
      return 'Fix the terms and try again.';
  }
}

// ---- reply objects -----------------------------------------------------------------------

export type ToolReply = { ok: boolean } & Record<string, unknown>;

const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o)).length;

/** Shrinks a reply until it serializes under TOOL_REPLY_MAX_BYTES: drops trailing `bad` entries, then trims `say`. */
export function fitReply<T extends ToolReply>(reply: T): T {
  const r: ToolReply = { ...reply };
  if (Array.isArray(r.bad)) r.bad = [...(r.bad as string[])];
  while (bytes(r) > TOOL_REPLY_MAX_BYTES && Array.isArray(r.bad) && r.bad.length > 1)
    (r.bad as string[]).pop();
  if (Array.isArray(r.bad) && bytes(r) > TOOL_REPLY_MAX_BYTES) {
    const b = r.bad as string[];
    b[0] = b[0]!.slice(0, Math.max(10, b[0]!.length - (bytes(r) - TOOL_REPLY_MAX_BYTES) - 1));
  }
  while (typeof r.say === 'string' && bytes(r) > TOOL_REPLY_MAX_BYTES && r.say.length > 1)
    r.say = `${r.say.slice(0, -2)}…`;
  return r as T;
}

export interface ReplyContext {
  /** Draft revision for a valid proposal (server state; the handler assigns it). */
  rev?: number;
  /** terms_code once Terms are composed and hashed (D1-J1); omitted before that. */
  code?: string;
  maxStake?: bigint;
  /** Party display names for an odds read-back (the handler loads them). */
  names?: PartyNames;
}

/** API-CONTRACT §4.3 response shapes. */
export function proposeTermsReply(ev: ProposeEvaluation, ctx: ReplyContext = {}): ToolReply {
  switch (ev.kind) {
    case 'invalid':
      return fitReply({
        ok: false,
        fix: 'INVALID',
        say: 'Run that by me again. I need clean terms.',
        bad: ev.issues.map((i) => `${i.path || '(body)'}: ${i.message}`),
      });
    case 'issue':
      return fitReply({ ok: false, fix: ev.issue.code, say: issueSay(ev.issue, ctx.maxStake) });
    case 'refused':
      return fitReply({
        ok: false,
        refused: ev.refusal.category,
        say: ev.refusal.quip,
        next: 'end',
      });
    case 'proposal': {
      const base: ToolReply = { ok: true };
      if (ctx.rev !== undefined) base.rev = ctx.rev;
      if (ctx.code !== undefined) base.code = ctx.code;
      base.say = readbackSay(ev.proposal, ctx.names);
      // Odds are agreed on the phones (Accept), never by a spoken yes.
      if (hasOdds(ev.proposal)) base.odds = 'tap_accept';
      if (ev.missing.length) {
        base.missing = ev.missing;
        base.next = 'ask';
      } else base.next = 'readback';
      return fitReply(base);
    }
  }
}
