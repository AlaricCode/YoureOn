// Finding the wake word ("Jarvis") in an on-device speech transcript, and the challenge said
// after it. Pure TS (tested in node, ./__tests__/phrase.test.ts).
//
// SFSpeechRecognizer is primed with contextualStrings ['Jarvis'], so most of the time it writes
// "Jarvis". When it doesn't, it writes something that sounds alike; we accept those, but only
// spellings that are not ordinary English words, because a false wake opens the judge mid-chat:
//
//   jarvis                 the word itself
//   j-words 5-7 letters    Levenshtein <= 1 from "jarvis": jervis, jarvas, jarvus, jarves,
//                          javis, jarvs, jarviz... No common English word starting with "j" is one
//                          edit from "jarvis" (the first letter is fixed, so every edit lands in
//                          "arvis"), which is why the fuzzy rule is limited to tokens starting "j"
//   garvis, charvis        the j heard as a hard g / ch (seen with fast or accented speech); both
//                          are non-words. Listed exactly, no fuzzy match around them
//   "jar vis" / "jar vas"  the word split in two; joined only when the halves spell an exact
//                          spelling, so "jar is" (one edit away once joined) is not a wake
//
// Deliberately NOT accepted, though recognizers produce them for "Jarvis": "Travis" and "Davis"
// (real first/last names: "I bet Travis can't..." must not wake the judge), "service", "harvest",
// "nervous", "jars", "java".
//
// Possessives and contractions: "Jarvis's" / "Jarvis’" count ("Jarvis's turn"), the apostrophe
// is dropped before matching. Diacritics are stripped ("Jarvís").
//
// Hermes note: no \p{...} property escapes (the rest of the app avoids them too); explicit Latin
// ranges instead. Non-Latin scripts never contain the wake word in en-US anyway.

/** How the UI writes the wake word. */
export const WAKE_WORD = 'Jarvis';

/** Exact spellings accepted besides the fuzzy j-rule (lowercase, no apostrophes). */
export const WAKE_SPELLINGS: readonly string[] = [
  'jarvis',
  'jervis',
  'jarvas',
  'jarvus',
  'jarves',
  'javis',
  'garvis',
  'charvis',
];

/** Second halves that, after "jar", spell the wake word: "jar vis". */
const SPLIT_TAILS: ReadonlySet<string> = new Set(['vis', 'vas', 'vus', 'ves', 'viss']);

/** Words people put between "Jarvis" and the challenge; dropped from the front of the tail. */
export const LEADING_FILLERS: ReadonlySet<string> = new Set([
  'hey',
  'hi',
  'yo',
  'um',
  'umm',
  'uh',
  'uhh',
  'uhm',
  'er',
  'erm',
  'hmm',
  'ok',
  'okay',
  'so',
  'well',
]);

const SPELLINGS: ReadonlySet<string> = new Set(WAKE_SPELLINGS);
const TARGET = 'jarvis';

// A word: Latin letters/digits (with any combining marks of a decomposed string), optionally
// joined by inner apostrophes ("can't", "Jarvis's"). Everything else separates words.
const WORD = /[A-Za-z0-9À-ɏ̀-ͯ]+(?:['’][A-Za-z0-9À-ɏ̀-ͯ]+)*/g;
const DIACRITICS = /[̀-ͯ]/g;

export interface Token {
  /** The word as written in the transcript. */
  readonly raw: string;
  /** Lowercase, no diacritics, possessive "'s" and apostrophes removed. */
  readonly key: string;
  /** Offsets into the original string: raw === text.slice(start, end). */
  readonly start: number;
  readonly end: number;
}

/** Lowercase, no diacritics, no apostrophes. */
export function wordKey(word: string): string {
  return word
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/['’]s$/, '')
    .replace(/['’]/g, '');
}

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    out.push({ raw: m[0], key: wordKey(m[0]), start, end: start + m[0].length });
  }
  return out;
}

/** A transcript for comparison: lowercase words without punctuation, single-spaced. */
export function normalizeTranscript(text: string): string {
  return tokenize(text)
    .map((t) => t.key)
    .filter((k) => k !== '')
    .join(' ');
}

/** Edit distance, giving up (returning max + 1) once it is certainly above `max`. */
export function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

/** True if one normalized word (see wordKey) is the wake word or an accepted mishearing. */
export function isWakeKey(key: string): boolean {
  if (SPELLINGS.has(key)) return true;
  return (
    key.startsWith('j') &&
    key.length >= 5 &&
    key.length <= 7 &&
    boundedLevenshtein(key, TARGET, 1) <= 1
  );
}

export interface WakeMatch {
  /** Offsets of the wake word in the original transcript (two tokens for "jar vis"). */
  readonly start: number;
  readonly end: number;
}

/** Every wake word in `text`, in order. */
export function findWakes(text: string): WakeMatch[] {
  const tokens = tokenize(text);
  const out: WakeMatch[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (isWakeKey(t.key)) {
      out.push({ start: t.start, end: t.end });
      continue;
    }
    const next = tokens[i + 1];
    if (t.key === 'jar' && next && SPLIT_TAILS.has(next.key)) {
      out.push({ start: t.start, end: next.end });
      i++;
    }
  }
  return out;
}

export function hasWake(text: string): boolean {
  return findWakes(text).length > 0;
}

// Separators and punctuation that can sit between the wake word and the challenge.
const LEADING_JUNK = /^[\s,.;:!?…'"’‘“”()\-–—]+/;

/**
 * The challenge as said: leading punctuation and filler words ("hey", "um", "ok so") removed,
 * outer whitespace trimmed, the rest exactly as transcribed (case and punctuation kept).
 */
export function cleanTail(text: string): string {
  let rest = text;
  for (;;) {
    rest = rest.replace(LEADING_JUNK, '');
    const first = tokenize(rest)[0];
    if (!first || first.start !== 0 || !LEADING_FILLERS.has(first.key)) break;
    rest = rest.slice(first.end);
  }
  return rest.trim().replace(/\s+/g, ' ');
}

export interface WakeSplit {
  /** The transcript says the wake word. */
  readonly found: boolean;
  /** What follows the LAST wake word, cleaned (cleanTail); '' when nothing follows or !found. */
  readonly tail: string;
}

/** "Hey Jarvis, um, I bet Mo can't do 20 pushups." -> {found: true, tail: "I bet Mo can't ..."}. */
export function splitAfterWake(text: string): WakeSplit {
  const wakes = findWakes(text);
  const last = wakes[wakes.length - 1];
  if (!last) return { found: false, tail: '' };
  return { found: true, tail: cleanTail(text.slice(last.end)) };
}
