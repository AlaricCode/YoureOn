/**
 * Perception inputs derived from the stored evidence: the primary camera's
 * chunk list (§6.0 video_urls), session-time audio events of the synced
 * audio witnesses (§7.6) and phone detections (§6.3 step 4).
 */
import type { PhoneDetections } from '@verdict/engine';
import type { AppContext } from '../context.js';
import type { PerceptionVideo, Transcript } from '../providers/types.js';
import type { WitnessRecord } from './records.js';
import { witnessChunks, type LifecycleStores } from './stores.js';
import { witnessList } from './live.js';
import { signedChunkUrl } from './mediaUrls.js';

/** Primary camera = the lowest-index camera witness (§6.0). */
export function primaryCamera(s: LifecycleStores, betId: string): WitnessRecord | null {
  return witnessList(s, betId).witnesses.find((w) => w.kind === 'camera') ?? null;
}

/** Device-local → session ms offset of a witness (0 when unsynced). */
export const offsetOf = (w: WitnessRecord): number => w.offset_ms ?? 0;

/** Signed, expiring URL of a chunk body (perception workers have no bearer token). */
export function chunkUrl(ctx: AppContext, betId: string, witness: string, index: number): string {
  return signedChunkUrl(ctx, betId, witness, index);
}

/** The primary camera's uploaded chunks as §6.0 `video_urls` (contiguous prefix with bodies). */
export function primaryVideos(ctx: AppContext, s: LifecycleStores, betId: string): { camera: WitnessRecord | null; videos: PerceptionVideo[] } {
  const camera = primaryCamera(s, betId);
  if (!camera) return { camera: null, videos: [] };
  const videos: PerceptionVideo[] = [];
  for (const c of witnessChunks(s, betId, camera.witness_key)) {
    if (c.body_at_ms === null || (c.body_format !== 'mp4' && c.body_format !== 'mjpeg')) break;
    videos.push({
      index: c.index,
      url: chunkUrl(ctx, betId, camera.witness_key, c.index),
      sha256: c.body_sha256,
      start_ms: c.start_ms,
      duration_ms: c.duration_ms,
      body_format: c.body_format,
    });
  }
  return { camera, videos };
}

/** Session-time length (ms) covered by a witness's chunk records. */
export function recordedSessionMs(s: LifecycleStores, betId: string, w: WitnessRecord): number {
  const cs = witnessChunks(s, betId, w.witness_key);
  const last = cs[cs.length - 1];
  return last ? Math.max(0, last.start_ms + last.duration_ms - offsetOf(w)) : 0;
}

export interface AudioWitnessTranscript {
  witness: WitnessRecord;
  /** session-time segments and events */
  segments: { speaker: string | null; start_ms: number; end_ms: number; text: string; chunk: number; rel_start_ms: number; rel_end_ms: number }[];
  events: { type: string; at_ms: number }[];
}

/**
 * Transcribes every stored chunk of every synced audio witness (STT / Scribe)
 * and maps segments and audio-event tags to session time (§7.6).
 */
export async function audioTranscripts(ctx: AppContext, s: LifecycleStores, betId: string): Promise<AudioWitnessTranscript[]> {
  const out: AudioWitnessTranscript[] = [];
  for (const w of witnessList(s, betId).witnesses) {
    if (w.kind !== 'audio' || w.synced !== true) continue;
    const off = offsetOf(w);
    const t: AudioWitnessTranscript = { witness: w, segments: [], events: [] };
    for (const c of witnessChunks(s, betId, w.witness_key)) {
      const body = c.body_at_ms === null ? null : ctx.blobs.getChunk(betId, w.witness_key, c.index);
      if (!body) continue;
      let tr: Transcript;
      try {
        tr = await ctx.providers.stt.transcribe(body, {});
      } catch (e) {
        ctx.log.warn({ err: e, bet: betId, witness: w.label }, 'audio transcription failed');
        continue;
      }
      const base = c.start_ms - off;
      for (const seg of tr.segments) {
        t.segments.push({
          speaker: seg.speaker,
          start_ms: base + seg.start_ms,
          end_ms: base + seg.end_ms,
          text: seg.text,
          chunk: c.index,
          rel_start_ms: seg.start_ms,
          rel_end_ms: seg.end_ms,
        });
      }
      for (const ev of tr.audio_events) t.events.push({ type: ev.label, at_ms: base + ev.t_ms });
    }
    out.push(t);
  }
  return out;
}

/** Phone ("detections") witnesses as §6.3 step 4 input, in session time. */
export function phoneDetections(ctx: AppContext, s: LifecycleStores, betId: string): PhoneDetections[] {
  const out: PhoneDetections[] = [];
  for (const w of witnessList(s, betId).witnesses) {
    if (w.kind !== 'detections') continue;
    const frames: PhoneDetections['frames'] = [];
    for (const c of witnessChunks(s, betId, w.witness_key)) {
      const body = c.body_at_ms === null ? null : ctx.blobs.getChunk(betId, w.witness_key, c.index);
      if (!body) continue;
      try {
        const j = JSON.parse(new TextDecoder().decode(body)) as PhoneDetections;
        for (const fr of j.frames ?? []) {
          if (!Number.isFinite(fr.t_ms) || !Array.isArray(fr.boxes)) continue;
          frames.push({ t_ms: fr.t_ms - offsetOf(w), boxes: fr.boxes });
        }
      } catch {
        ctx.log.warn({ bet: betId, witness: w.label, index: c.index }, 'bad detections chunk');
      }
    }
    if (frames.length > 0) out.push({ frames });
  }
  return out;
}
