// The judge session's phone-side logic (API-CONTRACT §4.4, §4.5, §2.6), pure so it is tested in
// node; ./session.ts drives it and ./JudgeVoice.tsx binds that to the ElevenLabs RN SDK.
//   client tools: request_attempt -> POST /attempts ("armed: …" | "error: <code>"),
//                 show_terms_card -> bring the card forward, cue -> POST /cues (stage plays it)
//   judge.cue:    speak ? sendUserMessage(text) : sendContextualUpdate(text), verbatim
//   transcript:   agent / user messages batched every <= 250 ms to POST /voice/lines
import type { JudgeCueName } from '@youre-on/shared/api';

export type CueKind = 'gavel' | 'drumroll' | 'buzzer' | 'cheer';

export interface ToolDeps {
  startAttempt(attemptNo: number): Promise<void>;
  showTermsCard(): void;
  cue(kind: CueKind): Promise<void>;
  /** request_attempt is allowed only after [EVENT] LOCKED or [EVENT] REDO (§4.4). */
  canAttempt(): boolean;
}

const errCode = (e: unknown) => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'INTERNAL';
};

export function judgeClientTools(d: ToolDeps) {
  return {
    request_attempt: async (p: Record<string, unknown>): Promise<string> => {
      const n = typeof p.attempt_no === 'number' ? p.attempt_no : Number(p.attempt_no);
      if (!Number.isInteger(n) || n < 1) return 'error: VALIDATION_FAILED';
      if (!d.canAttempt()) return 'error: INVALID_STATE';
      try {
        await d.startAttempt(n);
        return 'armed: judge cam counting down';
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
