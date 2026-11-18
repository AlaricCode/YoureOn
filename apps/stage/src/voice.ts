// The projector's voice (API-CONTRACT §3.1 stage.voice, §4.5): the judge is always heard, and
// only once (by the stage, or by A's phone when a voice judge hosts the bet).
//
// For each fresh voiced event (freshVoiceLines: ruling.issued, the payout's judge.cue PAID /
// VOIDED, appeal.vote; packages/shared stageLineFor composes the words) the page waits up to
// VOICE_WAIT_MS for the server's stage.voice frame. With one, it fetches the ElevenLabs clip with
// its stage bearer and plays it through StageAudio (the context the first key press unlocked).
// Without one (no ElevenLabs key, STAGE_TTS=off, a server hiccup), or when the clip fails or is
// still not playable CLIP_WAIT_MS after its frame, it speaks the same line with the browser's
// speechSynthesis instead. Lines play one at a time, in the order their events came; M (mute)
// and V (voice off) skip them, and stop the one being said (silence: the clip's buffer source
// stops, speechSynthesis.cancel()).
//
// One judge at a time: in a bet a voice judge hosts (its history has a judge.line from A's
// phone), the ruling and the payout are the phone's to say (leftToPhoneJudge), so those lines
// come out marked `phone` and are never said here, clip or browser; the server sends no clip for
// them either. Appeal votes stay on the stage. A preview has no phones: it voices every line.
import {
  hasPhoneJudge,
  leftToPhoneJudge,
  stageLineFor,
  type StageVoiceName,
} from '@youre-on/shared/stage-voice';
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
  /** The phone judge says this one (a voice judge hosts the bet): the stage stays quiet. */
  phone?: true;
}

export const voiceKey = (betId: string, seq: number) => `${betId}:${seq}`;

/**
 * Lines for voiced events of `betId` not handled before (`seen` is updated). Old events (the
 * seq-0 replay of a bet that happened before the stage connected) are marked seen, unspoken.
 * In a bet with a phone judge the ruling and payout lines are marked `phone` (StageVoice says
 * nothing for them); `phoneJudge: false` (the preview: no phones) voices every line.
 */
export function freshVoiceLines(
  s: Pick<TickerState, 'bets' | 'history'>,
  betId: string,
  seen: Set<string>,
  nowMs: number,
  o: { freshMs?: number; phoneJudge?: boolean } = {},
): VoiceLine[] {
  const freshMs = o.freshMs ?? FRESH_MS;
  const out: VoiceLine[] = [];
  const names = s.bets[betId]?.names ?? { A: null, B: null };
  const history = s.history[betId] ?? [];
  let phone: boolean | null = null; // looked up once, only when a line needs it
  for (const e of history) {
    if (!VOICED.has(e.type)) continue;
    const key = voiceKey(betId, e.seq);
    if (seen.has(key)) continue;
    seen.add(key);
    const age = nowMs - Date.parse(e.ts);
    if (!(Number.isFinite(age) && age <= freshMs && age >= -freshMs)) continue;
    const line = stageLineFor(e, names);
    if (!line) continue;
    phone ??= o.phoneJudge !== false && hasPhoneJudge(history);
    out.push(leftToPhoneJudge(e.type, phone) ? { key, ...line, phone: true } : { key, ...line });
  }
  return out;
}

/** A decoded clip, ready to start. */
export interface Playable {
  /** Resolves when the clip has finished; rejects when it cannot play (audio locked). */
  play(): Promise<void>;
  /** Stops it mid-line (M / V): the AudioBufferSourceNode stops, play() resolves. */
  stop?(): void;
}

export interface VoiceIo {
  /** GET the clip with the stage bearer and decode it; rejects on any failure. */
  load(url: string): Promise<Playable>;
  /** The browser's voice; resolves when the line is done (at once when it cannot speak). */
  speak(line: { voice: StageVoiceName; text: string }): Promise<void>;
  /** false while muted / voice off: lines are skipped. */
  on(): boolean;
  /** Cuts the browser's voice off mid-line (speechSynthesis.cancel()). */
  cancelSpeech?(): void;
}

/** How a line was heard: its clip, the browser's voice, not at all (M / V), or by A's phone. */
export type VoiceHow = 'clip' | 'speech' | 'skip' | 'phone';

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
  /** Recent lines the phone judge said (a late clip for one is ignored). */
  private readonly phoneKeys = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  /** The line being said now: silence() stops its clip or its speech and ends it. */
  private current: { playable: Playable | null; speaking: boolean; cut(): void } | null = null;
  /** How the latest line was heard (the health strip): a clip, the browser, or not at all. */
  last: VoiceHow | null = null;
  /** Called after each line (tests, the health strip). */
  onDone: ((key: string, how: VoiceHow) => void) | null = null;

  constructor(
    private readonly io: VoiceIo,
    private readonly waitMs = VOICE_WAIT_MS,
    private readonly clipWaitMs = CLIP_WAIT_MS,
  ) {}

  /** No line is being said or waited for (the slow-mo replay waits for this; feat/slowmo-replay). */
  get idle(): boolean {
    return this.current === null && this.pending.size === 0;
  }

  /** A voiced event arrived: it will be heard, as a clip if one comes in time, else spoken. */
  expect(line: VoiceLine): void {
    if (this.pending.has(line.key)) return;
    if (line.phone) {
      // the phone judge says it: no wait, no clip (one that came first is dropped), no speech
      this.early.delete(line.key);
      this.phoneKeys.add(line.key);
      while (this.phoneKeys.size > EARLY_CLIPS)
        this.phoneKeys.delete(this.phoneKeys.keys().next().value!);
      this.queue = this.queue
        .then(() => {
          this.last = 'phone';
          this.onDone?.(line.key, 'phone');
        })
        .catch(() => undefined);
      return;
    }
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
    if (this.phoneKeys.has(frame.key)) return; // the phone judge's line: never played here
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

  /**
   * M (mute) or V (voice off): the line being said stops now (its clip's source node, or the
   * browser's utterance) and counts as skipped; the queued ones are skipped while it is off.
   */
  silence(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    try {
      cur.playable?.stop?.();
      if (cur.speaking) this.io.cancelSpeech?.();
    } finally {
      cur.cut();
    }
  }

  private async perform(line: VoiceLine, o: Outcome): Promise<void> {
    let how: VoiceHow = 'skip';
    if (this.io.on()) {
      let cut = false;
      let endCut!: () => void;
      // resolves on silence(), so a line whose clip or utterance never reports its end still ends
      const stopped = new Promise<void>((r) => (endCut = r));
      const cur = {
        playable: o.kind === 'clip' ? o.playable : null,
        speaking: false,
        cut: () => {
          cut = true;
          endCut();
        },
      };
      this.current = cur;
      try {
        if (o.kind === 'clip') {
          try {
            await within(Promise.race([o.playable.play(), stopped]), LINE_MAX_MS);
            if (!cut) how = 'clip';
          } catch {
            // could not play (audio locked): the browser says it instead
          }
        }
        if (how !== 'clip' && !cut) {
          cur.playable = null;
          cur.speaking = true;
          await within(
            Promise.race([
              this.io.speak({ voice: line.voice, text: o.kind === 'speech' ? o.text : line.text }),
              stopped,
            ]),
            LINE_MAX_MS,
          );
          if (!cut) how = 'speech';
        }
      } finally {
        if (this.current === cur) this.current = null;
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
  cancel?(): void;
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

/** speechSynthesis.cancel() (M / V cut a line off mid-word); nothing in a browser without it. */
export function cancelSpeech(g: { speechSynthesis?: unknown } = globalThis as never): void {
  try {
    (g.speechSynthesis as SynthLike | undefined)?.cancel?.();
  } catch {
    // no voice to stop
  }
}
