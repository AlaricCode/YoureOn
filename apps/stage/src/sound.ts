// Stage sound (ARCHITECTURE §3 / §7: the gavel and stingers play on the stage laptop, never on A's
// phone, whose mic would stop). Synthesized with WebAudio: no assets to load, no network, nothing
// to fail on a hotspot. The page plays a sound for moments it sees happen live:
//
//   lock    the atomic lock confirmed (tx.confirmed / BetCreated)
//   gavel   a decisive or VOID ruling            redo   a REDO ruling
//   paid    money moved: bet.state PAID / VOIDED (the server's own RPC confirmation), or a chain
//           BetFinalized, BetConceded, AppealResolved, BetRefunded, BetCancelled (Streams)
// plus any stage.cue frame the server sends (gavel, drumroll, buzzer, cheer).
//
// When the server generates the cues with ElevenLabs Sound Effects (GET /v1/stage/audio lists
// them), the page loads those clips once (setGenerated) and plays them instead: the gavel for a
// ruling, the buzzer for a REDO, the cheer for a payout, and each stage.cue. Until a clip is
// decoded, and without them, the synthesized sound plays. The judge's voice clips (voice.ts) go
// through the same context (decode + playBuffer).
//
// Only fresh events sound (their server ts within FRESH_MS of the stage clock), so the seq-0 replay
// of a bet that happened before the stage connected stays silent. Browsers keep audio suspended
// until a user gesture: the first key press or click unlocks it; M mutes.
import type { StageCueKind } from '@youre-on/shared/api';
import type { z } from 'zod/v4';
import type { TickerState } from './ticker';

type CueKind = z.infer<typeof StageCueKind>;

export const SFX = ['gavel', 'lock', 'redo', 'paid', 'drumroll', 'buzzer', 'cheer'] as const;
export type Sfx = (typeof SFX)[number];
export const isSfx = (s: string): s is Sfx => (SFX as readonly string[]).includes(s);
export const FRESH_MS = 15_000;

const MONEY = new Set([
  'chain.BetFinalized',
  'chain.BetConceded',
  'chain.AppealResolved',
  'chain.BetRefunded',
  'chain.BetCancelled',
]);

/**
 * Sounds for events of `betId` not heard before (`seen` is updated). Old events are marked seen
 * without a sound. Lock / ruling / payout each sound once however many events report them.
 */
export function freshSounds(
  s: TickerState,
  betId: string,
  seen: Set<string>,
  nowMs: number,
  freshMs = FRESH_MS,
): Sfx[] {
  const out: Sfx[] = [];
  for (const e of s.history[betId] ?? []) {
    let key: string | null = null;
    let sfx: Sfx | null = null;
    if (
      (e.type === 'tx.confirmed' && e.payload.kind === 'atomic_lock') ||
      e.type === 'chain.BetCreated'
    ) {
      key = `${betId}:lock`;
      sfx = 'lock';
    } else if (e.type === 'ruling.issued') {
      key = `${betId}:ruling:${e.payload.ruling_hash}`;
      sfx = e.payload.ruling.outcome === 'REDO' ? 'redo' : 'gavel';
    } else if (
      MONEY.has(e.type) ||
      (e.type === 'bet.state' && (e.payload.state === 'PAID' || e.payload.state === 'VOIDED'))
    ) {
      key = `${betId}:paid`;
      sfx = 'paid';
    }
    if (!key || !sfx || seen.has(key)) continue;
    seen.add(key);
    const age = nowMs - Date.parse(e.ts);
    if (Number.isFinite(age) && age <= freshMs && age >= -freshMs) out.push(sfx);
  }
  return out;
}

// ---- synthesis --------------------------------------------------------------------------------

type Ctx = Pick<
  AudioContext,
  | 'currentTime'
  | 'destination'
  | 'sampleRate'
  | 'state'
  | 'resume'
  | 'createOscillator'
  | 'createGain'
  | 'createBiquadFilter'
  | 'createBuffer'
  | 'createBufferSource'
> &
  Partial<Pick<AudioContext, 'decodeAudioData'>>;

/** Which generated (ElevenLabs) cue clip a moment plays, when the server has them. */
export const GENERATED_FOR: Partial<Record<Sfx, CueKind>> = {
  gavel: 'gavel',
  redo: 'buzzer',
  buzzer: 'buzzer',
  paid: 'cheer',
  cheer: 'cheer',
  drumroll: 'drumroll',
};

function noise(ctx: Ctx, seconds: number): AudioBufferSourceNode {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function env(ctx: Ctx, t: number, peak: number, decay: number, out: AudioNode): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  g.connect(out);
  return g;
}

function tone(
  ctx: Ctx,
  out: AudioNode,
  t: number,
  o: { type: OscillatorType; from: number; to?: number; peak: number; decay: number },
) {
  const osc = ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.from, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + o.decay * 0.8);
  osc.connect(env(ctx, t, o.peak, o.decay, out));
  osc.start(t);
  osc.stop(t + o.decay + 0.05);
}

function burst(ctx: Ctx, out: AudioNode, t: number, freq: number, peak: number, decay: number) {
  const n = noise(ctx, decay + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = 1.2;
  n.connect(f);
  f.connect(env(ctx, t, peak, decay, out));
  n.start(t);
  n.stop(t + decay + 0.05);
}

/** Schedules one sound on the context (exported for tests). */
export function synth(ctx: Ctx, kind: Sfx, out: AudioNode = ctx.destination): void {
  const t = ctx.currentTime + 0.02;
  switch (kind) {
    case 'gavel':
      for (const dt of [0, 0.2]) {
        burst(ctx, out, t + dt, 1100, 0.9, 0.07);
        tone(ctx, out, t + dt, { type: 'sine', from: 160, to: 60, peak: 0.9, decay: 0.18 });
      }
      break;
    case 'lock':
      tone(ctx, out, t, { type: 'sine', from: 110, to: 55, peak: 0.8, decay: 0.25 });
      burst(ctx, out, t, 2400, 0.4, 0.04);
      tone(ctx, out, t + 0.12, { type: 'triangle', from: 1320, peak: 0.25, decay: 0.5 });
      break;
    case 'redo':
    case 'buzzer':
      for (const f of [110, 116.5])
        tone(ctx, out, t, {
          type: 'square',
          from: f,
          peak: 0.12,
          decay: kind === 'redo' ? 0.45 : 0.7,
        });
      break;
    case 'paid':
    case 'cheer':
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) =>
        tone(ctx, out, t + i * 0.09, { type: 'triangle', from: f, peak: 0.3, decay: 0.6 }),
      );
      burst(ctx, out, t + 0.36, 6000, 0.15, 0.6);
      break;
    case 'drumroll':
      for (let i = 0; i < 40; i++) burst(ctx, out, t + i * 0.04, 500, 0.1 + i * 0.012, 0.05);
      burst(ctx, out, t + 1.65, 7000, 0.5, 0.9);
      break;
  }
}

/** One AudioContext per page, created and resumed on the first user gesture. */
export class StageAudio {
  private ctx: Ctx | null = null;
  muted = false;
  /** ElevenLabs cue clips: the bytes as fetched, then the decoded buffer. */
  private readonly generated = new Map<CueKind, { raw: ArrayBuffer; buf: AudioBuffer | null }>();

  constructor(private readonly make: () => Ctx | null = defaultContext) {}

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Call from a key / click handler (the gesture browsers require). */
  unlock(): void {
    try {
      this.ctx ??= this.make();
      if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume();
      for (const k of this.generated.keys()) void this.decodeGenerated(k);
    } catch {
      this.ctx = null; // no WebAudio: stay silent
    }
  }

  /** A cue's ElevenLabs clip (MP3 bytes); decoded now if audio is unlocked, else at unlock. */
  setGenerated(kind: CueKind, raw: ArrayBuffer): void {
    this.generated.set(kind, { raw, buf: null });
    if (this.ctx) void this.decodeGenerated(kind);
  }

  hasGenerated(kind: CueKind): boolean {
    return this.generated.has(kind);
  }

  /** How many cue clips are decoded and playable (the health strip). */
  get generatedReady(): number {
    return [...this.generated.values()].filter((g) => g.buf).length;
  }

  private async decodeGenerated(kind: CueKind): Promise<void> {
    const g = this.generated.get(kind);
    if (!g || g.buf) return;
    const buf = await this.decode(g.raw);
    if (buf && this.generated.get(kind) === g) g.buf = buf;
  }

  /** MP3 / WAV bytes -> an AudioBuffer (the bytes are copied: decoding detaches them). */
  async decode(raw: ArrayBuffer): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx?.decodeAudioData) return null;
    try {
      return await ctx.decodeAudioData(raw.slice(0));
    } catch {
      return null;
    }
  }

  /** Plays a decoded clip; resolves when it ends. null when muted or locked. */
  playBuffer(buf: AudioBuffer): Promise<void> | null {
    const ctx = this.ctx;
    if (this.muted || !ctx || ctx.state !== 'running') return null;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      return new Promise<void>((resolve) => {
        const safety = setTimeout(resolve, (buf.duration || 0) * 1000 + 1_000);
        src.onended = () => {
          clearTimeout(safety);
          resolve();
        };
        src.start(ctx.currentTime + 0.02);
      });
    } catch {
      return null;
    }
  }

  play(kind: Sfx): boolean {
    if (this.muted || !this.ctx || this.ctx.state !== 'running') return false;
    const gen = GENERATED_FOR[kind];
    const buf = gen ? this.generated.get(gen)?.buf : null;
    if (buf && this.playBuffer(buf)) return true;
    try {
      synth(this.ctx, kind);
      return true;
    } catch {
      return false;
    }
  }
}

function defaultContext(): Ctx | null {
  const C =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return C ? new C() : null;
}
