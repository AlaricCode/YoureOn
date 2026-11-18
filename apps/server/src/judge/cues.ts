// judge.cue lines for Beat 4 (API-CONTRACT §4.5).
import type { Ruling } from '@youre-on/shared/ruling';
import { MAX_REDOS } from '@youre-on/shared/constants';
import { asciiFold, judgeCue, type JudgeCue } from '../bets/cues';

/** `[EVENT] ATTEMPT_ARMED attempt=1 performer=Jake :: Stay quiet while the camera counts down.` */
export function attemptArmedCue(attemptNo: number, performer: string): JudgeCue {
  return judgeCue(
    'ATTEMPT_ARMED',
    { attempt: attemptNo, performer },
    'Stay quiet while the camera counts down.',
    false,
  );
}

export interface CueNames {
  A: string;
  B: string;
}

/** RULING / REDO / VOIDED for an attempt ruling. */
export function rulingCue(r: Ruling, names: CueNames, ggSecs: number): JudgeCue {
  if (r.outcome === 'REDO') {
    const next = r.attempt_no + 1;
    return judgeCue(
      'REDO',
      { attempt: next, max: MAX_REDOS + 1, why: r.redo_reason ?? 'unclear' },
      `Say "Run it back" and call request_attempt with attempt_no ${next}.`,
    );
  }
  if (r.outcome === 'VOID') {
    return judgeCue(
      'VOIDED',
      { reason: r.void_reason ?? 'max_redos', attempts: r.attempt_no },
      'Say there is no clean call after three tries, so nobody wins and both stakes go back.',
    );
  }
  const winner = r.outcome === 'A_WINS' ? names.A : names.B;
  const loser = r.outcome === 'A_WINS' ? names.B : names.A;
  return judgeCue(
    'RULING',
    {
      outcome: r.outcome,
      winner,
      conf: r.confidence.toFixed(2),
      frames: r.cited_frames.join(',') || '-',
      reason: r.reason,
      gg_secs: ggSecs,
    },
    // The GG moment: the loser GGs on the phone, or anyone asks for a review out loud
    // (request_review: the loser's phone confirms it). The reason is a kv value, so this fits.
    `Deliver the ruling in two short sentences using the reason, then tell ${asciiFold(loser)} to tap GG, or to say "check it again" for a review.`,
  );
}

/**
 * Dance Off (DANCE-OFF §6.2): both players dance, so the cue names both. Silent, like the camera
 * countdown cue.
 */
export function danceArmedCue(attemptNo: number, names: CueNames): JudgeCue {
  return judgeCue(
    'ATTEMPT_ARMED',
    { attempt: attemptNo, performer: 'both', dancers: `${names.A} and ${names.B}` },
    'Stay quiet while the camera counts the dancers in.',
    false,
  );
}

/** Why a dance ruling is VOID (the VOIDED cue's `why`). */
export type DanceVoidWhy = 'too_close' | 'invalid' | 'coverage_a' | 'coverage_b' | 'no_frames';

/**
 * RULING / VOIDED for a Dance Off (model rule/dance-off@1). The score decides, so there is no
 * "check it again" and no "three tries": a winner is read out with the announcer's line, and a
 * VOID says why (too close to call, a lost dancer, or a round that doesn't count).
 */
export function danceRulingCue(
  r: Ruling,
  scores: { a: number; b: number },
  why: DanceVoidWhy | null,
  names: CueNames,
  ggSecs: number,
): JudgeCue {
  if (r.outcome !== 'A_WINS' && r.outcome !== 'B_WINS') {
    const w = why ?? 'too_close';
    const say =
      w === 'invalid'
        ? "Say this round doesn't count, so nobody wins and both stakes go back."
        : w === 'too_close'
          ? "Say it's too close to call, so nobody wins and both stakes go back."
          : 'Say the camera lost a dancer, so it is too close to call and both stakes go back.';
    return judgeCue('VOIDED', { reason: r.void_reason ?? 'undecidable', why: w }, say);
  }
  const winner = r.outcome === 'A_WINS' ? names.A : names.B;
  const loser = r.outcome === 'A_WINS' ? names.B : names.A;
  const ws = r.outcome === 'A_WINS' ? scores.a : scores.b;
  const ls = r.outcome === 'A_WINS' ? scores.b : scores.a;
  return judgeCue(
    'RULING',
    {
      outcome: r.outcome,
      winner,
      score: `${(ws / 10).toFixed(1)}-${(ls / 10).toFixed(1)}`,
      reason: r.reason,
      gg_secs: ggSecs,
    },
    `Read the reason out like a dance-show announcer, then tell ${asciiFold(loser)} to tap GG.`,
  );
}
