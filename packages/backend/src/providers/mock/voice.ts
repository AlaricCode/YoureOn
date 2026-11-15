/**
 * Mock voice stack (§13): text-only agent; STT returns the
 * `x-mock-transcript` header, else the draft's last transcript, else the
 * challenge phrase (accept); TTS/SFX return bundled silent/beep WAVs.
 */
import { beepWav, silentWav } from '../../util/wav.js';
import type {
  AgentProvider,
  AudioBlob,
  SfxProvider,
  SttContext,
  SttProvider,
  Transcript,
  TtsProvider,
} from '../types.js';

export class MockAgent implements AgentProvider {
  readonly name = 'mock';
  async createSession(): Promise<{ mode: 'mock'; signed_url: null }> {
    return { mode: 'mock', signed_url: null };
  }
}

export class MockStt implements SttProvider {
  readonly name = 'mock';
  async transcribe(_audio: Uint8Array, ctx: SttContext = {}): Promise<Transcript> {
    const text = ctx.mock_transcript ?? ctx.draft_transcript ?? ctx.challenge_phrase ?? '';
    return {
      text,
      segments: text ? [{ start_ms: 0, end_ms: Math.max(500, text.split(/\s+/).length * 350), speaker: 'speaker_0', text }] : [],
      audio_events: [],
    };
  }
}

/** ~250 ms of silence per word, 0.5–10 s. */
export function mockSpeechMs(text: string): number {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.min(10_000, Math.max(500, words * 250));
}

export class MockTts implements TtsProvider {
  readonly name = 'mock';
  async synthesize(text: string): Promise<AudioBlob> {
    return { mime: 'audio/wav', bytes: silentWav(mockSpeechMs(text)) };
  }
}

export class MockSfx implements SfxProvider {
  readonly name = 'mock';
  private cached: Uint8Array | null = null;
  async startSound(): Promise<AudioBlob> {
    this.cached ??= beepWav(400, 880);
    return { mime: 'audio/wav', bytes: this.cached };
  }
}
