// "Jarvis, dance off": a Dance Off asked for out loud opens the Dance off panel (./danceTerms),
// with the routine and the stake that were said already picked. Without this the sentence went
// to the voice judge, who can only write camera bets and came back with one (a bottle flip, the
// one worked example in its prompt): a Dance Off is not something it can propose.
//
// Pure rules DemoApp reads (tested in ./__tests__/wakeDance.test.ts):
//   - danceRequest     is the sentence asking for a Dance Off, and with which routine and stake
//   - danceEventsFor   the panel's events for it: open, then the routine and the stake if said
import { normalizeTranscript } from '../wake/phrase';
import type { DanceEvent } from './danceTerms';

export interface DanceRequest {
  /** The routine that was named ("bye bye shuffle", "the shuffle"), else null: the panel's own. */
  readonly routineId: string | null;
  /** The stake that was said, when it is one the panel offers, else null: the panel's own. */
  readonly stakeUsd: number | null;
}

/** What follows "dance" when it is a contest and not just something to do. */
const CONTEST = '(?:off|offs|of|battle|battles|competition|contest|challenge|duel|showdown)';
/** "dance off", "dance-off", "danceoff", "dance battle", "a dance with / against Jake". */
const ASKS: readonly RegExp[] = [
  new RegExp(`\\bdance ${CONTEST}\\b`),
  /\bdanceoff\b/,
  /\bdance(?:s|ing)? (?:against|versus|vs)\b/,
  /\bout ?dance\b/,
  /\bbattle (?:in|at|with) (?:a )?danc(?:e|ing)\b/,
];

/** Words of a routine's title too common to pick it by ("bounce BACK"). */
const WEAK_TITLE_WORDS: ReadonlySet<string> = new Set(['the', 'back', 'off', 'and']);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  a: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  fifty: 50,
};
const MONEY_UNITS: ReadonlySet<string> = new Set(['dollar', 'dollars', 'buck', 'bucks']);

/**
 * The stake said in a sentence, when it is one the form offers ("for five bucks" with chips
 * 1 / 5 / 10 / 20 is 5), else null: then the form's own stake stands.
 */
export function saidStakeUsd(text: string, stakes: readonly number[]): number | null {
  const dollars = saidDollars(text, normalizeTranscript(text).split(' '));
  return dollars !== null && stakes.includes(dollars) ? dollars : null;
}

/** The dollars said in the sentence ("$5", "five bucks", "10 dollars each"), or null. */
function saidDollars(text: string, words: readonly string[]): number | null {
  const sign = /\$\s?(\d{1,3})(?![\d.])/.exec(text);
  if (sign) return Number(sign[1]);
  for (let i = 1; i < words.length; i++) {
    if (!MONEY_UNITS.has(words[i]!)) continue;
    const w = words[i - 1]!;
    if (/^\d{1,3}$/.test(w)) return Number(w);
    const n = NUMBER_WORDS[w];
    if (n !== undefined) return n;
  }
  return null;
}

/** The one routine whose title the sentence says the most of, or null (none, or a tie). */
function saidRoutine(
  words: readonly string[],
  routines: readonly { readonly id: string; readonly title: string }[],
): string | null {
  const said = new Set(words);
  let best: string | null = null;
  let bestHits = 0;
  let tied = false;
  for (const r of routines) {
    // The name on screen and the id's own words: "Bye Bye Bye" is still "the shuffle" to anyone
    // who learned it as bye-bye-shuffle.
    const title = new Set(
      normalizeTranscript(`${r.title} ${r.id.replace(/-/g, ' ')}`)
        .split(' ')
        .filter((w) => w.length >= 3 && !WEAK_TITLE_WORDS.has(w)),
    );
    let hits = 0;
    for (const w of title) if (said.has(w)) hits += 1;
    if (hits === 0) continue;
    if (hits > bestHits) {
      best = r.id;
      bestHits = hits;
      tied = false;
    } else if (hits === bestHits) tied = true;
  }
  return tied ? null : best;
}

/**
 * Is `text` (what was said after "Jarvis") asking for a Dance Off? Null when it is not: then it
 * is the judge's to hear, as before. "Bet you can't dance on the table" is a camera bet, not a
 * Dance Off, so a contest has to be named ("dance off", "dance battle", "dance against Jake").
 */
export function danceRequest(
  text: string,
  routines: readonly { readonly id: string; readonly title: string }[],
  stakes: readonly number[],
): DanceRequest | null {
  const normal = normalizeTranscript(text);
  if (!ASKS.some((re) => re.test(normal))) return null;
  const words = normal.split(' ');
  const dollars = saidDollars(text, words);
  return {
    routineId: saidRoutine(words, routines),
    stakeUsd: dollars !== null && stakes.includes(dollars) ? dollars : null,
  };
}

/** The Dance off panel's events for a request: open it, then pick what was said. */
export function danceEventsFor(req: DanceRequest): DanceEvent[] {
  const events: DanceEvent[] = [{ type: 'open' }];
  if (req.routineId !== null) events.push({ type: 'routine', id: req.routineId });
  if (req.stakeUsd !== null) events.push({ type: 'stake', usd: req.stakeUsd });
  return events;
}
