// The judge session's phone-side logic (API-CONTRACT §4.4, §4.5, §2.6), pure so it is tested in
// node; ./session.ts drives it and ./JudgeVoice.tsx binds that to the ElevenLabs RN SDK.
//   client tools: request_attempt -> POST /attempts ("armed: …" | "error: <code>"; with two
//                 phones A's own phone may be the camera, ../attempt/recorder),
//                 show_terms_card -> bring the card forward, cue -> POST /cues (stage plays it)
//   judge.cue:    speak ? sendUserMessage(text) : sendContextualUpdate(text), verbatim
//   transcript:   agent / user messages batched every <= 250 ms to POST /voice/lines
import type { JudgeCueName } from '@youre-on/shared/api';

export type CueKind = 'gavel' | 'drumroll' | 'buzzer' | 'cheer';

export interface ToolDeps {
  /** Resolves with who films: the judge cam, or (two phones) this phone itself. */
  startAttempt(attemptNo: number): Promise<'judge_cam' | 'self' | void>;
  showTermsCard(): void;
  cue(kind: CueKind): Promise<void>;
  /** request_attempt is allowed only after [EVENT] LOCKED or [EVENT] REDO (§4.4). */
  canAttempt(): boolean;
}

const errCode = (e: unknown) => {
  const err = e as { code?: unknown; details?: { reason?: unknown } } | null;
  // A performs and the room has no judge cam: only B's phone can film, so B taps Start.
  if (err?.code === 'INVALID_STATE' && err.details?.reason === 'no_judge_cam')
    return 'NO_JUDGE_CAM';
  return typeof err?.code === 'string' ? err.code : 'INTERNAL';
};

export function judgeClientTools(d: ToolDeps) {
  return {
    request_attempt: async (p: Record<string, unknown>): Promise<string> => {
      const n = typeof p.attempt_no === 'number' ? p.attempt_no : Number(p.attempt_no);
      if (!Number.isInteger(n) || n < 1) return 'error: VALIDATION_FAILED';
      if (!d.canAttempt()) return 'error: INVALID_STATE';
      try {
        const recorder = await d.startAttempt(n);
        return recorder === 'self'
          ? 'armed: this phone films, counting down'
          : 'armed: judge cam counting down';
      } catch (e) {
        return `error: ${errCode(e)}`;
      }
    },
    show_terms_card: (): void => {
      d.showTermsCard();
    },
    cue: (p: Record<string, unknown>): void => {
      const kind = p.kind;
      if (kind === 'gavel' || kind === 'drumroll' || kind === 'buzzer' || kind === 'cheer')
        void d.cue(kind).catch(() => undefined);
    },
  };
}

/** What A's phone does with a judge.cue (§4.5): voiced cues are user turns, the rest context. */
export function cueAction(c: { cue: JudgeCueName; text: string; speak: boolean }): {
  send: 'user' | 'context';
  text: string;
} {
  return { send: c.speak ? 'user' : 'context', text: c.text };
}

/** How many cues wait for the session to connect; older ones are dropped first. */
export const CUE_QUEUE_MAX = 8;

export interface CueSink {
  sendUserMessage(text: string): void;
  sendContextualUpdate(text: string): void;
}

/**
 * Delivers [EVENT] cues to the voice session without ever throwing. The ElevenLabs SDK's send
 * calls throw synchronously when there is no live conversation (not started yet, the token was
 * refused, or the connection dropped); those calls run inside realtime listeners, so a throw
 * there was a fatal crash in Release (it killed A's phone when B declined, voice token
 * refused). A cue that cannot be sent waits (up to CUE_QUEUE_MAX) and goes out on flush(),
 * called when the session connects.
 */
export function createCueOutbox(
  sink: () => CueSink,
  log: (msg: string, extra?: unknown) => void = () => undefined,
) {
  const queue: { send: 'user' | 'context'; text: string }[] = [];
  const trySend = (a: { send: 'user' | 'context'; text: string }): boolean => {
    try {
      const s = sink();
      if (a.send === 'user') s.sendUserMessage(a.text);
      else s.sendContextualUpdate(a.text);
      return true;
    } catch (err) {
      log('voice.cue_deferred', err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  return {
    push(a: { send: 'user' | 'context'; text: string }): void {
      if (queue.length === 0 && trySend(a)) return;
      queue.push(a);
      if (queue.length > CUE_QUEUE_MAX) queue.shift();
    },
    /** Sends what waited, in order; stops at the first failure (still not connected). */
    flush(): void {
      while (queue.length > 0 && trySend(queue[0] as { send: 'user' | 'context'; text: string }))
        queue.shift();
    },
    get pending(): number {
      return queue.length;
    },
  };
}

/** request_attempt is legal after these cues (§4.4). */
export const ATTEMPT_CUES: ReadonlySet<JudgeCueName> = new Set(['LOCKED', 'REDO']);

export interface VoiceLine {
  utterance_id: string;
  role: 'judge' | 'party';
  party?: 'A' | 'B';
  text: string;
  final: boolean;
  at: string;
}

/** Batches transcript lines for POST /v1/bets/:id/voice/lines, flushing at most every 250 ms. */
export function createLineBatcher(
  post: (lines: VoiceLine[]) => Promise<void>,
  timers: { setTimeout(f: () => void, ms: number): unknown; clearTimeout(h: unknown): void } = {
    setTimeout: (f, ms) => setTimeout(f, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
  everyMs = 250,
) {
  let queue: VoiceLine[] = [];
  let timer: unknown = null;
  const flush = () => {
    timer = null;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    void post(batch).catch(() => undefined);
  };
  return {
    add(l: VoiceLine) {
      queue.push(l);
      if (timer === null) timer = timers.setTimeout(flush, everyMs);
    },
    flush() {
      if (timer !== null) timers.clearTimeout(timer);
      flush();
    },
  };
}
