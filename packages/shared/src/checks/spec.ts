// SAM 3.1 camera checks, predicate set 'p1' (design final.md): the spec Claude compiles from the
// agreed terms and both parties confirm before Face ID. It is hashed inside TermsV2 (§1), so:
// strict objects, no optional keys (absence is an explicit null), no free numbers apart from
// `count`, and flat (spec -> assertion -> predicate, §6). What each predicate means and EVERY
// threshold live in the evaluator (./evaluate.ts) under the PREDICATE_SET literal; changing any of
// them ships as 'p2', and terms that say 'p1' are evaluated by p1 code forever.
import { z } from 'zod/v4';
import { jcs } from '../jcs';
import { NText } from '../primitives';

export const PREDICATE_SET = 'p1' as const;
/** §6: SAM allows 4 prompts; 3 keeps warm latency <= ~10.5 s with one prompt of headroom. */
export const MAX_ENTITIES = 3;
export const MAX_ASSERTIONS = 6;
/** §6: count is 1..6 (a 3-2-1 cup pyramid). */
export const MAX_ENTITY_COUNT = 6;
/** §1: describeChecks() fits TermsPresentation.readback. */
export const READBACK_MAX_CHARS = 400;

export const EntityKey = z.string().regex(/^[a-z][a-z0-9_]{0,15}$/, 'key: a-z0-9_, 1-16 chars');
/** SAM text prompt: a plain noun phrase, 1-4 lowercase words ("bottle", "trash can"). Never a state. */
export const SamPrompt = NText(40).regex(/^[a-z]+(?:[ '-][a-z]+){0,3}$/, '1-4 lowercase words');

/** §5: an entity is a prompt plus a count, referenced only by key. Never a SAM id. */
export const Entity = z.strictObject({
  key: EntityKey,
  prompt: SamPrompt,
  /** Physical instances the bet involves (3 cans). */
  count: z.number().int().min(1).max(MAX_ENTITY_COUNT),
});
export type Entity = z.infer<typeof Entity>;

/** §2 windows: start = frames 0-1, end = the last 3, landing = isLandingFrame(). */
export const VisibleWindow = z.enum(['start', 'end', 'landing']);
export type VisibleWindow = z.infer<typeof VisibleWindow>;
/** last_Ns = frames with t >= lastSampleMs - N s. */
export const TouchWindow = z.enum(['end', 'landing', 'last_2s', 'last_3s', 'last_5s']);
export type TouchWindow = z.infer<typeof TouchWindow>;
export const Of = z.enum(['any', 'all']);

/** §4: the 9 predicates. Every one is three-valued; none is ever sufficient for MET. */
export const Predicate = z.discriminatedUnion('p', [
  z.strictObject({ p: z.literal('visible'), e: EntityKey, window: VisibleWindow }),
  z.strictObject({ p: z.literal('at_rest'), e: EntityKey, ref: EntityKey.nullable() }),
  z.strictObject({ p: z.literal('upright'), e: EntityKey }),
  z.strictObject({
    p: z.literal('moved_from_start'),
    e: EntityKey,
    of: Of,
    ref: EntityKey.nullable(),
  }),
  z.strictObject({ p: z.literal('stacked'), e: EntityKey }),
  z.strictObject({ p: z.literal('touching'), a: EntityKey, b: EntityKey, window: TouchWindow }),
  z.strictObject({ p: z.literal('on_top'), a: EntityKey, b: EntityKey }),
  z.strictObject({ p: z.literal('ends_at'), a: EntityKey, b: EntityKey }),
  z.strictObject({ p: z.literal('switched_sides'), a: EntityKey, b: EntityKey }),
]);
export type Predicate = z.infer<typeof Predicate>;
export type PredicateName = Predicate['p'];

/**
 * §7. gate: must be TRUE for any decisive verdict to stand (false/unknown => REDO). Only `visible`.
 * need: necessary for MET (false/unknown => a MET becomes REDO). Never touches NOT_MET.
 */
export const Role = z.enum(['gate', 'need']);
export const Assertion = z.strictObject({ role: Role, test: Predicate });
export type Assertion = z.infer<typeof Assertion>;

/** §4: subjects (clipping => unknown) vs references (clipping allowed). Derived, never LLM-chosen. */
export function roles(t: Predicate): { subjects: string[]; refs: string[] } {
  if ('a' in t) return { subjects: [t.a], refs: [t.b] };
  if (t.p === 'visible') return { subjects: [], refs: [] }; // its extent comes from subjectKeys()
  return { subjects: [t.e], refs: 'ref' in t && t.ref !== null ? [t.ref] : [] };
}
/** §4: keys named as e/a by a non-visible predicate. visible() on one of these needs it unclipped. */
export const subjectKeys = (s: { assertions: readonly Assertion[] }): Set<string> =>
  new Set(s.assertions.flatMap((a) => roles(a.test).subjects));
/** Every entity key a predicate names. */
export const keysOf = (t: Predicate): string[] =>
  'a' in t ? [t.a, t.b] : 'ref' in t && t.ref !== null ? [t.e, t.ref] : [t.e];

/** §6 lint: the only predicates whose entities may have count > 1 (the compiler prompt lists them). */
export const MULTI_COUNT_PREDICATES = [
  'visible',
  'at_rest',
  'moved_from_start',
  'stacked',
] as const satisfies readonly PredicateName[];
/** §6 lint: the only predicates that may be a gate. */
export const GATE_PREDICATES = ['visible'] as const satisfies readonly PredicateName[];
/** §6 lint: predicates whose entity needs count >= 2. */
export const MIN_COUNT_2_PREDICATES = ['stacked'] as const satisfies readonly PredicateName[];
const MULTI_OK = new Set<PredicateName>(MULTI_COUNT_PREDICATES);
const GATE_OK = new Set<PredicateName>(GATE_PREDICATES);
const MIN2 = new Set<PredicateName>(MIN_COUNT_2_PREDICATES);
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const roleRank = (a: Assertion) => (a.role === 'gate' ? 0 : 1);

/**
 * §1 canonical form: entities by key, assertions gates first then by JCS string. Run by the server
 * before CheckSpec.parse, so the same meaning always gives the same terms_hash.
 */
export function canonicalizeCheckSpec<
  T extends { entities: readonly Entity[]; assertions: readonly Assertion[] },
>(s: T): T {
  return {
    ...s,
    entities: [...s.entities].sort((x, y) => cmp(x.key, y.key)),
    assertions: [...s.assertions].sort((x, y) => roleRank(x) - roleRank(y) || cmp(jcs(x), jcs(y))),
  };
}

/** §6 spec shape plus the lints. */
export const CheckSpec = z
  .strictObject({
    predicates: z.literal(PREDICATE_SET),
    entities: z.array(Entity).min(1).max(MAX_ENTITIES),
    assertions: z.array(Assertion).min(1).max(MAX_ASSERTIONS),
  })
  .superRefine((s, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const ent = new Map(s.entities.map((e) => [e.key, e]));
    if (ent.size !== s.entities.length) bad(['entities'], 'duplicate entity key');
    if (new Set(s.entities.map((e) => e.prompt)).size !== s.entities.length)
      bad(['entities'], 'duplicate prompt (SAM rejects them)');
    const used = new Set<string>();
    const gatedLate = new Set<string>(); // gated by visible at end/landing
    const endsAtSubjects = new Set<string>();
    s.assertions.forEach((as, i) => {
      const t = as.test;
      const at = ['assertions', i, 'test'];
      for (const k of keysOf(t)) {
        used.add(k);
        if (!ent.has(k)) bad(at, `unknown entity '${k}'`);
      }
      if ('a' in t && t.a === t.b) bad(at, 'a and b must differ');
      if ('ref' in t && t.ref !== null) {
        if (t.ref === t.e) bad([...at, 'ref'], 'ref must differ from e');
        const n = ent.get(t.ref)?.count;
        if (n !== undefined && n !== 1) bad([...at, 'ref'], 'ref must be a count-1 entity');
      }
      for (const k of keysOf(t)) {
        const n = ent.get(k)?.count;
        const isRef = 'ref' in t && t.ref === k;
        if (n !== undefined && n > 1 && !isRef && !MULTI_OK.has(t.p))
          bad(at, `${t.p} needs count-1 entities`);
      }
      if (MIN2.has(t.p) && 'e' in t && (ent.get(t.e)?.count ?? 2) < 2)
        bad(at, `${t.p} needs count >= 2`);
      if (t.p === 'moved_from_start' && ent.get(t.e)?.count === 1 && t.of !== 'all')
        bad([...at, 'of'], "count 1 => of: 'all'");
      if (as.role === 'gate') {
        if (!GATE_OK.has(t.p)) bad(['assertions', i, 'role'], "only 'visible' can be a gate");
        else if (t.p === 'visible' && t.window !== 'start') gatedLate.add(t.e);
      }
      if (t.p === 'ends_at') endsAtSubjects.add(t.a);
    });
    for (const k of endsAtSubjects)
      if (gatedLate.has(k))
        bad(
          ['assertions'],
          `'${k}' may vanish into its target (ends_at): never gate it at end/landing`,
        );
    s.entities.forEach((e, i) => {
      if (!used.has(e.key)) bad(['entities', i], `entity '${e.key}' is unused`);
    });
    if (new Set(s.assertions.map((a) => jcs(a))).size !== s.assertions.length)
      bad(['assertions'], 'duplicate assertion');
    if (jcs(canonicalizeCheckSpec(s)) !== jcs(s))
      bad([], 'not canonical (run canonicalizeCheckSpec)');
  });
export type CheckSpec = z.infer<typeof CheckSpec>;

/** §1 compiler output (LLM-facing, lenient): the server canonicalizes `spec`, then CheckSpec.parse. */
export const CompiledChecks = z.object({
  decision: z.enum(['checks', 'judge_only']),
  why: z.string().max(200), // logged, never hashed
  spec: z.unknown().nullable(),
});
export type CompiledChecks = z.infer<typeof CompiledChecks>;

// ---------------- fixed templates (§1 readback, §7 REDO reasons). No free text from the LLM. ----

/** "bottle" -> "bottles", "glass" -> "glasses", "cherry" -> "cherries". Prompts are lowercase words. */
export function plural(noun: string): string {
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

type Lookup = (key: string) => Entity | undefined;
const theOne = (ent: Lookup, k: string) => `the ${ent(k)?.prompt ?? k}`;
/** "the bottle" for count 1, "all 3 cans" for count > 1. */
const theAll = (ent: Lookup, k: string) => {
  const e = ent(k);
  return e !== undefined && e.count > 1 ? `all ${e.count} ${plural(e.prompt)}` : theOne(ent, k);
};
const lastNs = (w: TouchWindow) => /^last_(\d)s$/.exec(w)?.[1];

export function windowPhrase(w: VisibleWindow | TouchWindow): string {
  if (w === 'start') return 'at the start';
  if (w === 'end') return 'at the end';
  if (w === 'landing') return 'for the last second';
  return `for the last ${lastNs(w)} seconds`;
}

/** The positive clause for a predicate ("the bottle stands upright"). */
export function predicateClause(t: Predicate, ent: Lookup, subjects: Set<string>): string {
  switch (t.p) {
    case 'visible':
      return `${theAll(ent, t.e)} ${subjects.has(t.e) ? 'fully ' : ''}in shot ${windowPhrase(t.window)}`;
    case 'at_rest':
      return `${theAll(ent, t.e)} come${ent(t.e)?.count === 1 ? 's' : ''} to rest`;
    case 'upright':
      return `${theOne(ent, t.e)} stands upright`;
    case 'moved_from_start':
      return t.of === 'all' && ent(t.e)?.count === 1
        ? `${theOne(ent, t.e)} moves from where it started`
        : t.of === 'all'
          ? `no ${ent(t.e)?.prompt ?? t.e} still where it started`
          : `at least one ${ent(t.e)?.prompt ?? t.e} moves from where it started`;
    case 'stacked':
      return `${theAll(ent, t.e)} end stacked, one on top`;
    case 'touching':
      return `${theOne(ent, t.a)} touching ${theOne(ent, t.b)} ${windowPhrase(t.window)}`;
    case 'on_top':
      return `${theOne(ent, t.a)} ends on ${theOne(ent, t.b)}`;
    case 'ends_at':
      return `${theOne(ent, t.a)} not seen lying away from ${theOne(ent, t.b)}`;
    case 'switched_sides':
      return `${theOne(ent, t.a)} starts on one side of ${theOne(ent, t.b)} and ends on the other`;
  }
}

/** §7 "Checks disagree: ..." text for a FALSE need. */
export function predicateFailure(t: Predicate, ent: Lookup, tooShort: boolean): string {
  switch (t.p) {
    case 'visible':
      return `${theOne(ent, t.e)} wasn't in shot ${windowPhrase(t.window)}`;
    case 'at_rest':
      return `${theOne(ent, t.e)} was still moving at the end`;
    case 'upright':
      return `${theOne(ent, t.e)} ended lying down`;
    case 'moved_from_start':
      return t.of === 'all'
        ? `${theOne(ent, t.e)} stayed where it started`
        : `every ${ent(t.e)?.prompt ?? t.e} stayed where it started`;
    case 'stacked':
      return `${theAll(ent, t.e)} weren't stacked at the end`;
    case 'touching':
      return tooShort
        ? `the clip is shorter than ${lastNs(t.window)} seconds`
        : `${theOne(ent, t.a)} wasn't touching ${theOne(ent, t.b)} ${windowPhrase(t.window)}`;
    case 'on_top':
      return `${theOne(ent, t.a)} didn't end on ${theOne(ent, t.b)}`;
    case 'ends_at':
      return `${theOne(ent, t.a)} ended away from ${theOne(ent, t.b)}`;
    case 'switched_sides':
      return `${theOne(ent, t.a)} ended on the same side of ${theOne(ent, t.b)}`;
  }
}

/** §7 filming hints, lowercase (the caller capitalizes). null: the table gives none. */
export function filmingHint(t: Predicate, ent: Lookup): string | null {
  switch (t.p) {
    case 'upright':
    case 'switched_sides':
      return 'film from the side';
    case 'visible':
      return `keep ${theOne(ent, t.e)} in frame until the end`;
    case 'touching':
      return lastNs(t.window) !== undefined
        ? "stop filming while it's still balanced"
        : 'keep both in view';
    case 'ends_at':
    case 'on_top':
      return 'keep both in view';
    default:
      return null;
  }
}

export const lookupOf =
  (s: { entities: readonly Entity[] }): Lookup =>
  (k) =>
    s.entities.find((e) => e.key === k);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const OFFLINE = 'If the ref cam is offline, the judge decides alone.';

/**
 * §1 readback for the confirm card (unhashed, <= READBACK_MAX_CHARS). Fixed per-predicate
 * templates; readback-worthy hints only (side-on filming, stop while balanced). A spec too long
 * for the card drops trailing clauses for "and more".
 */
export function describeChecks(spec: CheckSpec | null): string {
  if (spec === null) return 'Judge only, no ref cam.';
  const ent = lookupOf(spec);
  const subjects = subjectKeys(spec);
  const clauses = spec.assertions.map((a) => predicateClause(a.test, ent, subjects));
  const hints = [
    ...new Set(
      spec.assertions
        .map((a) => filmingHint(a.test, ent))
        .filter(
          (h) => h === 'film from the side' || h === "stop filming while it's still balanced",
        ),
    ),
  ].map((h) => `${cap(h as string)}.`);
  const render = (cs: string[], hs: string[]) =>
    [`Ref cam: ${cs.join('; ')}.`, ...hs, OFFLINE].join(' ');
  for (let keep = clauses.length; keep >= 1; keep--) {
    const cs = keep < clauses.length ? [...clauses.slice(0, keep), 'and more'] : clauses;
    for (const hs of [hints, []]) {
      const out = render(cs, hs);
      if (out.length <= READBACK_MAX_CHARS) return out;
    }
  }
  return render(['see the terms'], []);
}
