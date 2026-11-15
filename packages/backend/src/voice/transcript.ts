/**
 * Transcript helpers for spoken phrases (§12.3 `POST /drafts/:id/accept`,
 * `POST /enroll/voice`):
 *  - `normalizeTranscript`: lowercase, strip `[^a-z ]`, collapse spaces;
 *  - `pickSpeaker`: from Scribe's diarized segments, the speaker who said the
 *    phrase (ElevenLabs only diarizes; verification is our ECAPA model, §8.1);
 *  - `sliceWav`: the PCM16 WAV restricted to that speaker's segments, which
 *    is what the voiceprint is computed on.
 */
import { decodeWav, encodeWav } from '../util/wav.js';
import type { Transcript, TranscriptSegment } from '../providers/types.js';

export function normalizeTranscript(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

/** True iff the normalized transcript contains the normalized phrase as whole words. */
export function containsPhrase(transcript: string, phrase: string): boolean {
  const t = ` ${normalizeTranscript(transcript)} `;
  const p = normalizeTranscript(phrase);
  return p !== '' && t.includes(` ${p} `);
}

/** §12.3 accept rule: contains "i accept" and both challenge words. */
export function acceptPhraseHeard(transcript: string, words: readonly string[]): boolean {
  if (!containsPhrase(transcript, 'i accept')) return false;
  return words.every((w) => containsPhrase(transcript, w));
}

export interface SpeakerPick {
  speaker: string | null;
  text: string;
  segments: TranscriptSegment[];
}

/**
 * Groups segments by speaker and returns the speaker whose own words satisfy
 * `heard` (ties → most speech). Falls back to the whole transcript when
 * there is no diarization (single speaker / no segments).
 */
export function pickSpeaker(t: Transcript, heard: (text: string) => boolean): SpeakerPick | null {
  const bySpeaker = new Map<string, TranscriptSegment[]>();
  for (const s of t.segments) {
    const k = s.speaker ?? '';
    bySpeaker.set(k, [...(bySpeaker.get(k) ?? []), s]);
  }
  if (bySpeaker.size <= 1) {
    if (!heard(t.text)) return null;
    const only = [...bySpeaker.entries()][0];
    return { speaker: only ? only[0] || null : null, text: t.text, segments: only ? only[1] : [] };
  }
  let best: SpeakerPick | null = null;
  let bestMs = -1;
  for (const [speaker, segs] of bySpeaker) {
    const text = segs.map((s) => s.text).join(' ');
    if (!heard(text)) continue;
    const ms = segs.reduce((a, s) => a + Math.max(0, s.end_ms - s.start_ms), 0);
    if (ms > bestMs) {
      best = { speaker: speaker || null, text, segments: segs };
      bestMs = ms;
    }
  }
  return best;
}

/**
 * Keeps only the samples inside `segments` (with 100 ms padding), as a new
 * PCM16 WAV at the source rate. Returns the original bytes when the segments
 * cover (nearly) everything or nothing usable remains.
 */
export function sliceWav(wav: Uint8Array, segments: TranscriptSegment[], padMs = 100): Uint8Array {
  if (segments.length === 0) return wav;
  const d = decodeWav(wav);
  const n = d.samples.length;
  const keep = new Uint8Array(n);
  for (const s of segments) {
    const a = Math.max(0, Math.floor(((s.start_ms - padMs) * d.sampleRate) / 1000));
    const b = Math.min(n, Math.ceil(((s.end_ms + padMs) * d.sampleRate) / 1000));
    for (let i = a; i < b; i++) keep[i] = 1;
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += keep[i]!;
  if (count === 0 || count >= n) return wav;
  const out = new Int16Array(count);
  let j = 0;
  for (let i = 0; i < n; i++) if (keep[i]) out[j++] = d.samples[i]!;
  return encodeWav(out, d.sampleRate);
}

/** Validates that `bytes` is a PCM16 WAV; returns its duration in ms. */
export function wavDurationMs(bytes: Uint8Array): number {
  const d = decodeWav(bytes);
  return Math.round((d.samples.length * 1000) / d.sampleRate);
}
