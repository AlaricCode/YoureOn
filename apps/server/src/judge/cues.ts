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
    `Deliver the ruling in two short sentences using the reason, then tell ${asciiFold(loser)} he can tap GG.`,
  );
}
