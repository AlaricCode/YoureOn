// Mock voice providers (STT_PROVIDER=mock, SFX_PROVIDER=mock; the defaults). Offline, free.
//
// Ported from Verdict packages/backend/src/providers/mock/voice.ts (MockStt, MockSfx). Our STT
// mock returns only the caller's `mockTranscript` (Verdict's challenge-phrase fallback is gone:
// we have no spoken "I accept"); our SFX mock returns one distinct beep per stage cue.
import { toneWav } from './wav';
import type { AudioBlob, SfxCue, SfxProvider, SttOptions, SttProvider, Transcript } from '../types';

export class MockStt implements SttProvider {
  readonly name = 'mock' as const;
  async transcribe(_audio: Uint8Array, opts: SttOptions): Promise<Transcript> {
    const text = (opts.mockTranscript ?? '').trim();
    const words = text ? text.split(/\s+/).length : 0;
    return {
      text,
      segments: text
        ? [{ start_ms: 0, end_ms: Math.max(500, words * 350), speaker: 'speaker_0', text }]
        : [],
      audio_events: [],
      language_code: text ? 'en' : null,
    };
  }
}

/** Distinct, deterministic tones so the stage can tell mock cues apart by ear. */
export const MOCK_CUE_TONES: Record<SfxCue, { ms: number; hz: number }> = {
  gavel: { ms: 250, hz: 220 },
  drumroll: { ms: 1200, hz: 110 },
  buzzer: { ms: 600, hz: 150 },
  cheer: { ms: 900, hz: 880 },
};

export class MockSfx implements SfxProvider {
  readonly name = 'mock' as const;
  private readonly cache = new Map<SfxCue, Uint8Array>();
  async cue(kind: SfxCue): Promise<AudioBlob> {
    let bytes = this.cache.get(kind);
    if (!bytes) {
      const t = MOCK_CUE_TONES[kind];
      bytes = toneWav(t.ms, t.hz);
      this.cache.set(kind, bytes);
    }
    return { mime: 'audio/wav', bytes };
  }
}
