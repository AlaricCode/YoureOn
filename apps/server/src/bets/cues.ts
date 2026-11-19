// `[EVENT]` lines for judge.cue (API-CONTRACT §4.5):
//   [EVENT] <NAME> k=v k=v … :: <instruction>
// One line, ≤ 300 chars, ASCII; values with spaces are double-quoted. The server composes the
// text so wording can change without an EAS rebuild. Exported for the judge/lock streams.
import { JudgeCuePayload, type JudgeCueName } from '@youre-on/shared/api';
import type { z } from 'zod/v4';

export const EVENT_LINE_MAX = 300;

/** Folds to printable ASCII: strips diacritics (Zoë -> Zoe), drops controls, '?' for the rest. */
export function asciiFold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics left by NFKD
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?');
}

function value(v: string | number): string {
  const s = asciiFold(String(v)).replace(/"/g, "'");
  return /[\s=]/.test(s) || s === '' ? `"${s}"` : s;
}

export function eventLine(
  name: JudgeCueName,
  kv: Record<string, string | number>,
  instruction: string,
): string {
  const pairs = Object.entries(kv)
    .map(([k, v]) => `${k}=${value(v)}`)
    .join(' ');
  const head = `[EVENT] ${name}${pairs ? ` ${pairs}` : ''} :: `;
  const text = asciiFold(instruction);
  const line = head + text;
  if (line.length <= EVENT_LINE_MAX) return line;
  // Shorten the free-text instruction first, so a quoted k="v" value is never cut open
  // (§4.5 grammar). Only a head that alone overflows is cut blindly.
  const room = EVENT_LINE_MAX - head.length - 3;
  if (room >= 0) return `${head}${text.slice(0, room)}...`;
  return `${line.slice(0, EVENT_LINE_MAX - 3)}...`;
}

export type JudgeCue = z.infer<typeof JudgeCuePayload>;

/** A validated judge.cue payload. `speak:false` -> the phone uses sendContextualUpdate. */
export function judgeCue(
  cue: JudgeCueName,
  kv: Record<string, string | number>,
  instruction: string,
  speak = true,
): JudgeCue {
  return JudgeCuePayload.parse({ cue, text: eventLine(cue, kv, instruction), speak });
}

/** §4.5 DECLINED: `[EVENT] DECLINED name=Jake :: Say Jake passed. Nothing moved.` */
export function declinedCue(name: string): JudgeCue {
  const n = asciiFold(name);
  return judgeCue('DECLINED', { name }, `Say ${n} passed. Nothing moved.`);
}

/**
 * B tapped accept after the judge's confirm_terms was refused INVITE_PENDING for these terms (both
 * already said yes out loud): `[EVENT] INVITE_ACCEPTED name=Jake :: Say Jake is in, then call
 * confirm_terms again.` Spoken, because it must start a judge turn.
 */
export function inviteAcceptedCue(name: string): JudgeCue {
  const n = asciiFold(name);
  return judgeCue('INVITE_ACCEPTED', { name }, `Say ${n} is in, then call confirm_terms again.`);
}

/**
 * The LOCKED cue's instruction for a bet that is not a Gemini market. A Dance Off has no
 * request_attempt (the phone refuses it: the dance screen owns Start), so the judge only tells
 * both dancers to get in frame; every other camera bet starts attempt 1 by voice.
 */
export function lockedInstruction(
  type: string | null | undefined,
  names: { A: string; B: string },
): string {
  if (type === 'dance_off') {
    return `Announce both stakes are locked in one transaction, then tell ${asciiFold(names.A)} and ${asciiFold(names.B)} to get in frame for the dance off. Do not call request_attempt.`;
  }
  return 'Announce both stakes are locked in one transaction, then call request_attempt with attempt_no 1.';
}
