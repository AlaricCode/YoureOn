/**
 * Entity declarations (§2.2).
 */
import {
  ENTITY_NAME_RE,
  OBJECT_ENTITY_RE,
  OBJECT_PHRASE_RE,
  PERSON_ENTITY_RE,
  REGION_ENTITY_RE,
} from '../constants.js';
import type { DraftEntity } from '../types.js';
import { isKeyword } from './lexer.js';

/** Normalize an object phrase: lowercase, trim, collapse internal whitespace to one space. */
export function normalizePhrase(raw: string): string {
  return raw.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function isValidPhrase(phrase: string): boolean {
  return OBJECT_PHRASE_RE.test(phrase);
}

/** `null` if the name is acceptable, else a reason. */
export function entityNameProblem(name: string): string | null {
  if (!ENTITY_NAME_RE.test(name)) return `entity name "${name}" must match ^[a-z][a-z0-9_]{0,23}$`;
  if (isKeyword(name)) return `entity name "${name}" is a reserved word`;
  return null;
}

/**
 * Parse an entity value (`person(...)`, `object("...")`, `region(...)`) with the exact §2.2
 * patterns. Returns the draft entity, or an error message.
 */
export function parseEntityValue(name: string, value: string): { entity: DraftEntity } | { error: string } {
  const pm = PERSON_ENTITY_RE.exec(value);
  if (pm) {
    const arg = pm[1]!;
    if (arg === 'any') return { entity: { name, kind: 'person_any' } };
    const member = arg.startsWith('"') ? arg.slice(1, -1) : arg;
    return { entity: { name, kind: 'person', member } };
  }
  const om = OBJECT_ENTITY_RE.exec(value);
  if (om) {
    const phrase = normalizePhrase(om[1]!);
    if (!isValidPhrase(phrase)) {
      return { error: `object phrase "${phrase}" must match ^[a-z0-9][a-z0-9 '\\-]{0,47}$ after normalization` };
    }
    return { entity: { name, kind: 'object', phrase } };
  }
  const rm = REGION_ENTITY_RE.exec(value);
  if (rm) return { entity: { name, kind: 'region', shape: rm[1] as 'tap' | 'line' | 'zone' } };
  return { error: `entity "${name}": expected person(...), object("...") or region(tap|line|zone), got ${JSON.stringify(value)}` };
}
