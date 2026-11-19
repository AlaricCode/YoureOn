// The wake/endpoint state machine over the native recognizer's transcripts. Pure TS with an
// injected clock (every call takes nowMs), tested in ./__tests__/detector.test.ts.
//
//   idle       transcripts without the wake word are ignored
//      | the wake word appears                                  -> {type:'wake'}
//   capturing  the tail after the (last) wake word is the challenge; it ends when
//              - the tail has not changed for endSilenceMs (the user stopped talking), or
//              - a final result arrives after at least finalQuietMs without a change, or
//              - maxUtteranceMs have passed since the wake, or
//              - nothing followed the wake word for noTailTimeoutMs (text '')
//      |                                                        -> {type:'utterance', text}
//   done       everything is ignored until reset()
//
// The native module restarts its recognition task every ~50 s, after a final result, after an
// error and when the text gets long; each task is a new `segment` and starts with an empty
// transcript. A segment change mid-capture keeps what the previous segment heard after the wake
// word and appends the new segment's text.
//
// "Changed" compares normalized text (phrase.normalizeTranscript), so a recognizer that only
// re-punctuates or re-capitalizes ("i bet" -> "I bet.") does not hold the capture open.
//
// Why a final result alone does not end the capture: the native side ends its task on a timer
// and when the text gets long, and a task ended that way reports its text as final while the user
// may still be mid-sentence. A final that arrives after a pause (finalQuietMs) is the recognizer
// endpointing the sentence itself, and ends the capture without waiting for endSilenceMs.
import { cleanTail, normalizeTranscript, splitAfterWake } from './phrase';

export interface WakeTiming {
  /** The tail is complete once it has not changed for this long. */
  readonly endSilenceMs: number;
  /** Hard cap from the wake to the utterance. */
  readonly maxUtteranceMs: number;
  /** Only "Jarvis" was said: give up waiting for a challenge after this long, with text ''. */
  readonly noTailTimeoutMs: number;
  /** A final result ends the capture if the text has been unchanged for at least this long. */
  readonly finalQuietMs: number;
}

export const DEFAULT_WAKE_TIMING: WakeTiming = {
  endSilenceMs: 1300,
  maxUtteranceMs: 9000,
  noTailTimeoutMs: 4000,
  finalQuietMs: 500,
};

/** One 'onTranscript' event of the native module. */
export interface TranscriptInput {
  /** Cumulative best transcription of the current recognition task. */
  readonly text: string;
  readonly isFinal: boolean;
  /** Increments each time the native side starts a new recognition task. */
  readonly segment: number;
}

export type UtteranceReason = 'silence' | 'final' | 'max' | 'no_tail';

export type WakeEvent =
  | { readonly type: 'wake' }
  | { readonly type: 'utterance'; readonly text: string; readonly reason: UtteranceReason };

export type WakePhase = 'idle' | 'capturing' | 'done';

export interface ResetOptions {
  /**
   * Ignore transcripts of this segment and older. For re-arming mid-session (after an
   * interruption): the current task's cumulative text still holds the old "Jarvis".
   */
  readonly skipThroughSegment?: number;
}

export interface WakeDetector {
  feed(t: TranscriptInput, nowMs: number): WakeEvent[];
  tick(nowMs: number): WakeEvent[];
  reset(opts?: ResetOptions): void;
  readonly phase: WakePhase;
  /** The challenge heard so far ('' outside a capture). */
  readonly partial: string;
  /** The newest segment seen, or -Infinity before any transcript. */
  readonly lastSegment: number;
}

const join = (...parts: string[]) =>
  parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .join(' ');

/**
 * A transcript without the wake word, in the wake's own task: is it a revision of what we had
 * (the tail's words are still in it, whole) rather than a restarted text? An empty tail gives
 * nothing to tell them apart by, so it counts as a revision (the wake word revised away).
 */
const revises = (text: string, tail: string) => {
  const t = normalizeTranscript(tail);
  return t === '' || ` ${normalizeTranscript(text)} `.includes(` ${t} `);
};

export function createWakeDetector(timing: Partial<WakeTiming> = {}): WakeDetector {
  const t: WakeTiming = { ...DEFAULT_WAKE_TIMING, ...timing };

  let phase: WakePhase = 'idle';
  let skipThrough = -Infinity;
  let lastSegment = -Infinity;
  // capture state
  let captureSegment = 0; // the segment `current` belongs to
  let wakeSegment = 0; // the segment holding the (last) wake word
  let committed = ''; // tails of earlier segments
  let current = ''; // this segment's tail (the whole text after the wake segment)
  let wakeAt = 0;
  let lastChangeAt = 0;
  let lastKey = ''; // normalized committed + current, for change detection
  let lastSeenKey = ''; // normalized raw text of the latest transcript (wake revised away)

  const combined = () => join(committed, current);

  const touch = (nowMs: number) => {
    const key = normalizeTranscript(combined());
    if (key !== lastKey) {
      lastKey = key;
      lastChangeAt = nowMs;
    }
  };

  const finish = (reason: UtteranceReason): WakeEvent[] => {
    const text = combined();
    phase = 'done';
    committed = '';
    current = '';
    return [{ type: 'utterance', text, reason }];
  };

  /** The capture's time-based endings. */
  const evaluate = (nowMs: number): WakeEvent[] => {
    if (phase !== 'capturing') return [];
    if (nowMs - wakeAt >= t.maxUtteranceMs) return finish('max');
    const quiet = nowMs - lastChangeAt;
    if (combined() === '') return quiet >= t.noTailTimeoutMs ? finish('no_tail') : [];
    return quiet >= t.endSilenceMs ? finish('silence') : [];
  };

  const startCapture = (segment: number, tail: string, nowMs: number) => {
    phase = 'capturing';
    captureSegment = segment;
    wakeSegment = segment;
    committed = '';
    current = tail;
    wakeAt = nowMs;
    lastChangeAt = nowMs;
    lastKey = normalizeTranscript(tail);
  };

  return {
    get phase() {
      return phase;
    },
    get partial() {
      return phase === 'capturing' ? combined() : '';
    },
    get lastSegment() {
      return lastSegment;
    },

    feed(input, nowMs) {
      const { text, isFinal, segment } = input;
      if (segment <= skipThrough) return [];
      if (segment < lastSegment) return []; // a late event from a task that already ended
      lastSegment = segment;

      if (phase === 'done') return [];

      const split = splitAfterWake(text);
      const out: WakeEvent[] = [];

      if (phase === 'idle') {
        if (!split.found) return [];
        startCapture(segment, split.tail, nowMs);
        lastSeenKey = normalizeTranscript(text);
        out.push({ type: 'wake' });
      } else {
        if (segment !== captureSegment) {
          // A new recognition task: keep what the last one heard.
          committed = join(committed, current);
          current = '';
          captureSegment = segment;
        }
        if (split.found) {
          // The challenge is what follows the LAST wake word. Said again in a later segment, it
          // starts the challenge over ("Jarvis... Jarvis, I bet...").
          committed = '';
          current = split.tail;
          wakeSegment = segment;
        } else if (segment !== wakeSegment) {
          // A later task: its whole text continues the challenge.
          current = cleanTail(text);
        } else if (revises(text, current)) {
          // The wake's own task, but the recognizer revised the wake word away ("Jarvis" ->
          // "Service"): the text still holds the tail. Keep the tail we had; new words still mean
          // the user is talking.
          if (normalizeTranscript(text) !== lastSeenKey) lastChangeAt = nowMs;
        } else {
          // The wake's own task, but the on-device recognizer restarted its text after a pause
          // ("Jarvis, I bet Mo" -> "can't do ten"): keep what it heard and continue from the new
          // text. Later events of this task now take the continuation branch above.
          committed = join(committed, current);
          current = cleanTail(text);
          wakeSegment = -1;
        }
        lastSeenKey = normalizeTranscript(text);
        touch(nowMs);
      }

      const quiet = nowMs - lastChangeAt;
      if (isFinal && phase === 'capturing' && combined() !== '' && quiet >= t.finalQuietMs)
        return [...out, ...finish('final')];
      return [...out, ...evaluate(nowMs)];
    },

    tick(nowMs) {
      return evaluate(nowMs);
    },

    reset(opts = {}) {
      phase = 'idle';
      committed = '';
      current = '';
      lastKey = '';
      lastSeenKey = '';
      if (opts.skipThroughSegment !== undefined) {
        skipThrough = opts.skipThroughSegment;
      } else {
        skipThrough = -Infinity;
        lastSegment = -Infinity;
      }
    },
  };
}
