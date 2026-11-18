// The projector's voice (API-CONTRACT §3.1 stage.voice, §4.5): the judge is always heard.
//
// For each fresh voiced event (freshVoiceLines: ruling.issued, the payout's judge.cue PAID /
// VOIDED, appeal.vote; packages/shared stageLineFor composes the words) the page waits up to
// VOICE_WAIT_MS for the server's stage.voice frame. With one, it fetches the ElevenLabs clip with
// its stage bearer and plays it through StageAudio (the context the first key press unlocked).
// Without one (no ElevenLabs key, STAGE_TTS=off, a server hiccup), or when the clip fails or is
// still not playable CLIP_WAIT_MS after its frame, it speaks the same line with the browser's
// speechSynthesis instead. Lines play one at a time, in the order their events came; M (mute)
// and V (voice off) skip them.
import { stageLineFor, type StageVoiceName } from '@youre-on/shared/stage-voice';
import { FRESH_MS } from './sound';
import type { TickerState } from './ticker';

/** How long a line waits for its stage.voice frame before the browser speaks it. */
export const VOICE_WAIT_MS = 800;
/** How long an announced clip may take to arrive and decode (the server generates it meanwhile). */
export const CLIP_WAIT_MS = 4_000;
/** A line that has not finished playing by then is given up on (the queue moves on). */
export const LINE_MAX_MS = 30_000;
/** stage.voice frames kept while their event has not been seen yet. */
const EARLY_CLIPS = 20;

const VOICED = new Set(['ruling.issued', 'judge.cue', 'appeal.vote']);

export interface VoiceLine {
  /** `${bet_id}:${seq}`, as the stage.voice frame names its event. */
  key: string;
  voice: StageVoiceName;
  text: string;
}

export const voiceKey = (betId: string, seq: number) => `${betId}:${seq}`;

/**
 * Lines for voiced events of `betId` not handled before (`seen` is updated). Old events (the
 * seq-0 replay of a bet that happened before the stage connected) are marked seen, unspoken.
 */
export function freshVoiceLines(
  s: Pick<TickerState, 'bets' | 'history'>,
  betId: string,
  seen: Set<string>,
  nowMs: number,
  freshMs = FRESH_MS,
): VoiceLine[] {
  const out: VoiceLine[] = [];
  const names = s.bets[betId]?.names ?? { A: null, B: null };
  for (const e of s.history[betId] ?? []) {
    if (!VOICED.has(e.type)) continue;
    const key = voiceKey(betId, e.seq);
    if (seen.has(key)) continue;
    seen.add(key);
    const age = nowMs - Date.parse(e.ts);
    if (!(Number.isFinite(age) && age <= freshMs && age >= -freshMs)) continue;
    const line = stageLineFor(e, names);
    if (line) out.push({ key, ...line });
  }
  return out;
}

/** A decoded clip, ready to start. */
export interface Playable {
  /** Resolves when the clip has finished; rejects when it cannot play (audio locked). */
  play(): Promise<void>;
}

export interface VoiceIo {
  /** GET the clip with the stage bearer and decode it; rejects on any failure. */
  load(url: string): Promise<Playable>;
  /** The browser's voice; resolves when the line is done (at once when it cannot speak). */
  speak(line: { voice: StageVoiceName; text: string }): Promise<void>;
  /** false while muted / voice off: lines are skipped. */
  on(): boolean;
}

export type VoiceHow = 'clip' | 'speech' | 'skip';

type Outcome = { kind: 'clip'; playable: Playable } | { kind: 'speech'; text: string };

interface Pending {
  line: VoiceLine;
  settled: boolean;
  loading: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  settle(o: Outcome): void;
}

/** `p`, or nothing after `ms` (a clip or an utterance that never ends must not stall the queue). */
function within<T>(p: Promise<T>, ms: number): Promise<T | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((r) => (timer = setTimeout(r, ms)));
  return Promise.race([p, cap]).finally(() => clearTimeout(timer));
}

export class StageVoice {
  private readonly pending = new Map<string, Pending>();
  private readonly early = new Map<string, { url: string; text: string }>();
  private queue: Promise<void> = Promise.resolve();
  /** How the latest line was heard (the health strip): a clip, the browser, or not at all. */
  last: VoiceHow | null = null;
  /** Called after each line (tests, the health strip). */
  onDone: ((key: string, how: VoiceHow) => void) | null = null;

  constructor(
    private readonly io: VoiceIo,
    private readonly waitMs = VOICE_WAIT_MS,
    private readonly clipWaitMs = CLIP_WAIT_MS,
  ) {}

  /** A voiced event arrived: it will be heard, as a clip if one comes in time, else spoken. */
  expect(line: VoiceLine): void {
    if (this.pending.has(line.key)) return;
    let resolve!: (o: Outcome) => void;
    const outcome = new Promise<Outcome>((r) => (resolve = r));
    const p: Pending = {
      line,
      settled: false,
      loading: false,
      timer: null,
      settle: (o) => {
        if (p.settled) return;
        p.settled = true;
        if (p.timer) clearTimeout(p.timer);
        resolve(o);
      },
    };
    this.pending.set(line.key, p);
    p.timer = setTimeout(() => p.settle({ kind: 'speech', text: line.text }), this.waitMs);
    this.queue = this.queue
      .then(() => outcome)
      .then((o) => this.perform(line, o))
      .catch(() => undefined)
      .finally(() => this.pending.delete(line.key));
    const early = this.early.get(line.key);
    if (early) {
      this.early.delete(line.key);
      this.startClip(p, early);
    }
  }

  /** A stage.voice frame: the ElevenLabs clip of the line for event `key`. */
  clip(frame: { key: string; url: string; text: string }): void {
    const p = this.pending.get(frame.key);
    if (p) {
      if (!p.settled && !p.loading) this.startClip(p, frame);
      return;
    }
    // the frame came first (both in one render): keep it for expect()
    this.early.set(frame.key, { url: frame.url, text: frame.text });
    while (this.early.size > EARLY_CLIPS) this.early.delete(this.early.keys().next().value!);
  }

  private startClip(p: Pending, frame: { url: string; text: string }): void {
    p.loading = true;
    if (p.timer) clearTimeout(p.timer);
    const text = frame.text || p.line.text; // the server's words, if they differ
    p.timer = setTimeout(() => p.settle({ kind: 'speech', text }), this.clipWaitMs);
    this.io.load(frame.url).then(
      (playable) => p.settle({ kind: 'clip', playable }),
      () => p.settle({ kind: 'speech', text }),
    );
  }

  private async perform(line: VoiceLine, o: Outcome): Promise<void> {
    let how: VoiceHow = 'skip';
    if (this.io.on()) {
      if (o.kind === 'clip') {
        try {
          await within(o.playable.play(), LINE_MAX_MS);
          how = 'clip';
        } catch {
          // could not play (audio locked): the browser says it instead
        }
      }
      if (how !== 'clip') {
        await within(
          this.io.speak({ voice: line.voice, text: o.kind === 'speech' ? o.text : line.text }),
          LINE_MAX_MS,
        );
        how = 'speech';
      }
    }
    this.last = how;
    this.onDone?.(line.key, how);
  }
}

// ---- the browser's voice ----------------------------------------------------------------------

/** Pitch per speaker, so the fallback's four voices stay apart even on one system voice. */
const PITCH: Record<StageVoiceName, number> = {
  judge: 0.85,
  seat_1: 1.15,
  seat_2: 0.95,
  seat_3: 1.3,
};
const ORDER: Record<StageVoiceName, number> = { judge: 0, seat_1: 1, seat_2: 2, seat_3: 3 };

interface SynthLike {
  speak(u: unknown): void;
  getVoices(): Array<{ lang: string; name: string }>;
}
type UtteranceCtor = new (text: string) => {
  voice: unknown;
  pitch: number;
  rate: number;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

/** speechSynthesis as VoiceIo.speak, or null in a browser without it. */
export function browserSpeech(
  g: { speechSynthesis?: unknown; SpeechSynthesisUtterance?: unknown } = globalThis as never,
): VoiceIo['speak'] | null {
  const synth = g.speechSynthesis as SynthLike | undefined;
  const Utterance = g.SpeechSynthesisUtterance as UtteranceCtor | undefined;
  if (!synth || !Utterance) return null;
  return (line) =>
    new Promise<void>((resolve) => {
      try {
        const u = new Utterance(line.text);
        const english = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang));
        if (english.length) u.voice = english[ORDER[line.voice] % english.length];
        u.pitch = PITCH[line.voice];
        u.rate = 1.02;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        synth.speak(u);
      } catch {
        resolve();
      }
    });
}
