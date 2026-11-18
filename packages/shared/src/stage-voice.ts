// The projector's voice (API-CONTRACT §3.1 `stage.voice`, §4.5 "appeal votes are voiced on the
// stage"): the line the stage speaks for each of the judge's spoken moments. Composed here, so the
// server's ElevenLabs clip (apps/server/src/voice/tts.ts) and the stage's own speechSynthesis
// fallback (apps/stage/src/voice.ts, when no clip arrives) say the same words.
//
//   ruling.issued            the judge voice. "Jake wins. <reason>"; REDO "Run it back. <reason>";
//                            VOID says why and that both stakes go back; a Gemini settlement
//                            starts "Gemini settles it."
//   judge.cue PAID / VOIDED  the judge voice, when money moved (read from the [EVENT] line's
//                            values): "Paid. Jake takes $10.00." The VOIDED cue a VOID ruling sends
//                            at ruling time is not voiced: its ruling.issued already is.
//   appeal.vote              one voice per panel seat: "Judge 2, GPT, votes Logan. <reason>"
//
// Only shape checks here (looseObject): the caller already parsed the event, and a line is never
// worth failing over.
import { z } from 'zod/v4';

export const StageVoiceName = z.enum(['judge', 'seat_1', 'seat_2', 'seat_3']);
export type StageVoiceName = z.infer<typeof StageVoiceName>;

/** The bet events the stage speaks (see above). */
export const VoicedEventType = z.enum(['ruling.issued', 'judge.cue', 'appeal.vote']);
export type VoicedEventType = z.infer<typeof VoicedEventType>;

/** A spoken line is at most this long (it bounds the TTS characters billed per moment). */
export const STAGE_LINE_MAX = 300;

/** GET /v1/stage/tts/:clip_id (stage bearer): the clip of one line, content-addressed. */
export const STAGE_TTS_PREFIX = '/v1/stage/tts/';
export const stageTtsPath = (clipId: string): string => `${STAGE_TTS_PREFIX}${clipId}`;
/** GET /v1/stage/sfx/:kind (stage bearer): the ElevenLabs Sound Effects clip of a stage cue. */
export const stageSfxPath = (kind: string): string => `/v1/stage/sfx/${kind}`;
/** GET /v1/stage/audio (stage bearer): what the server voices (StageAudioResponse in ./api). */
export const STAGE_AUDIO_PATH = '/v1/stage/audio';
/** sha256 hex of voice id, model and text. */
export const CLIP_ID_RE = /^[0-9a-f]{64}$/;

export interface StageNames {
  A: string | null;
  B: string | null;
}

export interface StageLine {
  voice: StageVoiceName;
  text: string;
}

const PANEL_LABEL: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'GPT',
  google: 'Gemini',
};

/** One line of plain text: no controls, single spaces. */
const clean = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Ends with a full stop unless it already ends a sentence. */
const sentence = (s: string): string => {
  const t = clean(s);
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** Cleaned and at most `max` chars: cut after the last full sentence that fits, else with "…". */
export function capLine(s: string, max = STAGE_LINE_MAX): string {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop >= max / 2) return cut.slice(0, stop + 1);
  return `${cut.slice(0, max - 1).trimEnd()}…`;
}

export interface EventLine {
  name: string;
  kv: Record<string, string>;
  instruction: string;
}

/**
 * `[EVENT] <NAME> k=v k="v w" :: <instruction>` (API-CONTRACT §4.5, apps/server/src/bets/cues.ts
 * eventLine): values with spaces or `=` are double-quoted and never contain a `"`. null for
 * anything else (a line cut short at 300 chars included).
 */
export function parseEventLine(text: string): EventLine | null {
  const head = /^\[EVENT\] ([A-Z][A-Z_]*)/.exec(text);
  if (!head) return null;
  const kv: Record<string, string> = {};
  let i = head[0].length;
  while (i < text.length) {
    if (text.startsWith(' :: ', i)) return { name: head[1]!, kv, instruction: text.slice(i + 4) };
    if (text[i] !== ' ') return null;
    i++;
    const key = /^([a-z][a-z0-9_]*)=/.exec(text.slice(i));
    if (!key) return null;
    i += key[0].length;
    let value: string;
    if (text[i] === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) return null;
      value = text.slice(i + 1, end);
      i = end + 1;
    } else {
      const end = text.indexOf(' ', i);
      value = end < 0 ? text.slice(i) : text.slice(i, end);
      i += value.length;
    }
    kv[key[1]!] = value;
  }
  return { name: head[1]!, kv, instruction: '' };
}

const RulingLite = z.looseObject({
  outcome: z.enum(['A_WINS', 'B_WINS', 'REDO', 'VOID']),
  reason: z.string(),
  stage: z.string().optional(),
  void_reason: z.string().nullish(),
});
const VoteLite = z.looseObject({
  seat: z.number().int().min(0).max(2),
  provider: z.string(),
  status: z.string(),
  counted_as: z.string(),
  reason: z.string(),
});
const CueLite = z.looseObject({ cue: z.string(), text: z.string() });

const VOID_LINE: Record<string, string> = {
  max_redos: 'Three tries and no clean call.',
  market_invalid: 'Gemini voided the contract.',
  undecidable: "I can't call this one.",
  safety_stop: 'Stopped for safety.',
};

function rulingLine(r: z.infer<typeof RulingLite>, name: (p: 'A' | 'B') => string): string {
  if (r.outcome === 'REDO') return `Run it back. ${sentence(r.reason)}`;
  if (r.outcome === 'VOID')
    return `${VOID_LINE[r.void_reason ?? ''] ?? ''} It's void: both stakes go back.`.trim();
  const won = `${name(r.outcome === 'A_WINS' ? 'A' : 'B')} wins. ${sentence(r.reason)}`;
  return r.stage === 'settlement' ? `Gemini settles it. ${won}` : won;
}

function voteLine(v: z.infer<typeof VoteLite>, name: (p: 'A' | 'B') => string): string {
  const who = `Judge ${v.seat + 1}, ${PANEL_LABEL[v.provider] ?? clean(v.provider)}`;
  const reason = v.status === 'ok' ? sentence(v.reason) : '';
  if (v.counted_as === 'A_WINS' || v.counted_as === 'B_WINS')
    return `${who}, votes ${name(v.counted_as === 'A_WINS' ? 'A' : 'B')}. ${reason}`;
  return `${who}, abstains. ${reason}`;
}

function cueLine(c: z.infer<typeof CueLite>): string | null {
  const ev = parseEventLine(c.text);
  if (!ev || ev.name !== c.cue) return null;
  const kv = ev.kv;
  if (c.cue === 'PAID') {
    if (!kv.winner || kv.winner === 'split') return kv.winner ? "It's a split." : null;
    return kv.amount ? `Paid. ${kv.winner} takes ${kv.amount}.` : `Paid. ${kv.winner} wins.`;
  }
  // The payout's VOIDED carries the refunds (a, b); the ruling-time one carries the reason.
  if (c.cue === 'VOIDED' && kv.a && kv.b)
    return `It's void. Both stakes went back: ${kv.a === kv.b ? `${kv.a} each` : `${kv.a} and ${kv.b}`}.`;
  return null;
}

/**
 * The stage's line for a bet event, or null when the event is not one it speaks. `names` are the
 * parties' display names (null: "Player A" / "Player B", as the projector labels them).
 */
export function stageLineFor(
  e: { type: string; payload: unknown },
  names: StageNames,
): StageLine | null {
  const name = (p: 'A' | 'B') => clean(names[p] ?? '') || (p === 'A' ? 'Player A' : 'Player B');
  let line: StageLine | null = null;
  if (e.type === 'ruling.issued') {
    const p = z.looseObject({ ruling: RulingLite }).safeParse(e.payload);
    if (p.success) line = { voice: 'judge', text: rulingLine(p.data.ruling, name) };
  } else if (e.type === 'appeal.vote') {
    const p = z.looseObject({ vote: VoteLite }).safeParse(e.payload);
    if (p.success)
      line = {
        voice: `seat_${p.data.vote.seat + 1}` as StageVoiceName,
        text: voteLine(p.data.vote, name),
      };
  } else if (e.type === 'judge.cue') {
    const p = CueLite.safeParse(e.payload);
    const text = p.success ? cueLine(p.data) : null;
    if (text) line = { voice: 'judge', text };
  }
  if (!line) return null;
  const text = capLine(line.text);
  return text ? { voice: line.voice, text } : null;
}
