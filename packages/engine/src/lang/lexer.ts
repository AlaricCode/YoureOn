/**
 * Lexer for expression, rule and outcome strings (§2.5.1).
 *
 * Tokens are matched longest-match at each position. Whitespace is skipped.
 * Columns are 1-based positions in the (already folded) source string.
 */
import { RESERVED_WORDS } from '../constants.js';
import type { SubRegion } from '../types.js';
import { ParseFailure } from './errors.js';
import { durationToFrames } from './duration.js';

export type Token =
  | { t: 'PUNCT'; text: '(' | ')' | ',' | ';'; col: number }
  | { t: 'CMP'; text: '>=' | '<=' | '==' | '!=' | '>' | '<'; col: number }
  | { t: 'DUR'; text: string; frames: number; col: number }
  | { t: 'INT'; text: string; value: number; col: number }
  | { t: 'REF'; text: string; name: string; sub?: SubRegion; keyword: boolean; col: number }
  | { t: 'SIDEL'; text: 'A' | 'B'; col: number }
  | { t: 'EOF'; text: ''; col: number };

/**
 * Reserved words that never occur as a standalone token of the expression, rule or outcome
 * grammars (they only appear inside entity values such as `region(line)` / `person(any)`, or as a
 * `.opening` / `.interior` suffix). §15.1 names a region entity `line`, so these are accepted as
 * entity names and lexed as ordinary identifiers (see docs/CONTRACTS-ERRATA.md, lang).
 */
export const ENTITY_SAFE_RESERVED: ReadonlySet<string> = new Set(['tap', 'line', 'zone', 'any', 'opening', 'interior']);

const KEYWORDS: ReadonlySet<string> = new Set<string>(RESERVED_WORDS.filter((w) => !ENTITY_SAFE_RESERVED.has(w)));

/** Whether `word` is a grammar keyword (a reserved word that cannot be an entity name). */
export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word);
}

const WS_RE = /[ \t\r\n]+/y;
const PUNCT_RE = /[(),;]/y;
const CMP_RE = />=|<=|==|!=|>|</y;
const DUR_RE = /[0-9]{1,5}(?:\.[0-9]{1,3})?s|[0-9]{1,7}ms/y;
const INT_RE = /[0-9]{1,16}(?:_[0-9]{3})*/y;
const REF_RE = /[a-z][a-z0-9_]{0,23}(?:\.(?:opening|interior))?/y;
const SIDEL_RE = /[AB]/y;

function matchAt(re: RegExp, src: string, pos: number): string | null {
  re.lastIndex = pos;
  const m = re.exec(src);
  return m ? m[0] : null;
}

/** Tokenize `src`. Throws `ParseFailure` (PARSE_ERROR, with column) on a lexical error. */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  while (pos < src.length) {
    const ws = matchAt(WS_RE, src, pos);
    if (ws) {
      pos += ws.length;
      continue;
    }
    const col = pos + 1;
    const cands: { kind: Token['t']; text: string }[] = [];
    const push = (kind: Token['t'], re: RegExp): void => {
      const m = matchAt(re, src, pos);
      if (m) cands.push({ kind, text: m });
    };
    push('PUNCT', PUNCT_RE);
    push('CMP', CMP_RE);
    push('DUR', DUR_RE);
    push('INT', INT_RE);
    push('REF', REF_RE);
    push('SIDEL', SIDEL_RE);
    if (cands.length === 0) {
      throw new ParseFailure(`unexpected character ${JSON.stringify(src[pos])}`, col);
    }
    // Longest match; candidates never tie across kinds (disjoint first characters except DUR/INT,
    // where DUR is always strictly longer when it matches).
    let best = cands[0]!;
    for (const c of cands) if (c.text.length > best.text.length) best = c;
    const end = pos + best.text.length;
    const next = end < src.length ? src[end]! : '';
    switch (best.kind) {
      case 'PUNCT':
        out.push({ t: 'PUNCT', text: best.text as '(' | ')' | ',' | ';', col });
        break;
      case 'CMP':
        out.push({ t: 'CMP', text: best.text as '>=' | '<=' | '==' | '!=' | '>' | '<', col });
        break;
      case 'DUR': {
        if (/[a-z_]/.test(next)) throw new ParseFailure(`malformed duration "${best.text}${next}"`, col);
        out.push({ t: 'DUR', text: best.text, frames: durationToFrames(best.text), col });
        break;
      }
      case 'INT': {
        if (/[a-z_]/.test(next)) throw new ParseFailure(`malformed number "${best.text}${next}"`, col);
        out.push({ t: 'INT', text: best.text, value: Number(best.text.replace(/_/g, '')), col });
        break;
      }
      case 'REF': {
        // An identifier longer than 24 characters would otherwise split into two tokens.
        if (/[a-z0-9_]/.test(next)) throw new ParseFailure(`identifier too long or malformed at "${best.text}${next}"`, col);
        const dot = best.text.indexOf('.');
        const name = dot < 0 ? best.text : best.text.slice(0, dot);
        const sub = dot < 0 ? undefined : (best.text.slice(dot + 1) as SubRegion);
        const tok: Token = { t: 'REF', text: best.text, name, keyword: sub === undefined && KEYWORDS.has(name), col };
        if (sub !== undefined) tok.sub = sub;
        out.push(tok);
        break;
      }
      case 'SIDEL': {
        if (/[A-Za-z0-9_]/.test(next)) throw new ParseFailure(`unexpected character ${JSON.stringify(next)}`, end + 1);
        out.push({ t: 'SIDEL', text: best.text as 'A' | 'B', col });
        break;
      }
      default:
        throw new ParseFailure('internal lexer error', col);
    }
    pos = end;
  }
  out.push({ t: 'EOF', text: '', col: src.length + 1 });
  return out;
}
