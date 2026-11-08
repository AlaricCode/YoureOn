/**
 * Exhibit media cutting (§10.1: "never the whole video"). Works on stored
 * chunk bodies (§7.1 formats) in session time:
 *   - mjpeg: repeated `u32 len ‖ u32 t_ms_local ‖ jpeg[len]` (LE) → frames
 *     whose session time falls in the span are kept (still valid MJPEG);
 *   - wav (16 kHz mono PCM16) → the samples of the span, re-wrapped as WAV;
 *   - mp4: cannot be cut without a transcoder; the single chunk with the
 *     largest overlap is used whole (≤ CHUNK_MS of footage).
 * Every function returns the chunk indices it used, so the exhibit's chain
 * proof covers exactly those chunks.
 */
import { decodeWav, encodeWav } from '../util/wav.js';
import type { ChunkMeta } from '../integration/sources.js';

export interface Span {
  t_start_ms: number;
  t_end_ms: number;
}

export interface LoadedChunk {
  meta: ChunkMeta;
  body: Uint8Array;
  /** session-time start of the chunk */
  session_start_ms: number;
}

export interface CutResult {
  bytes: Uint8Array;
  /** chunk indices used, ascending */
  used: number[];
  mime: string;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Chunks overlapping the span (session time), ascending by index. */
export function overlapping(chunks: LoadedChunk[], span: Span): LoadedChunk[] {
  return chunks
    .filter((c) => overlap(c.session_start_ms, c.session_start_ms + c.meta.duration_ms, span.t_start_ms, span.t_end_ms) > 0)
    .sort((a, b) => a.meta.index - b.meta.index);
}

/** Parses MJPEG records; throws on a malformed body. */
export function parseMjpeg(body: Uint8Array): { t_ms: number; jpeg: Uint8Array }[] {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const out: { t_ms: number; jpeg: Uint8Array }[] = [];
  let o = 0;
  while (o < body.length) {
    if (o + 8 > body.length) throw new Error('mjpeg: truncated record header');
    const len = dv.getUint32(o, true);
    const t = dv.getUint32(o + 4, true);
    if (o + 8 + len > body.length) throw new Error('mjpeg: truncated frame');
    out.push({ t_ms: t, jpeg: body.subarray(o + 8, o + 8 + len) });
    o += 8 + len;
  }
  return out;
}

export function encodeMjpeg(frames: { t_ms: number; jpeg: Uint8Array }[]): Uint8Array {
  const total = frames.reduce((a, f) => a + 8 + f.jpeg.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const f of frames) {
    dv.setUint32(o, f.jpeg.length, true);
    dv.setUint32(o + 4, f.t_ms >>> 0, true);
    out.set(f.jpeg, o + 8);
    o += 8 + f.jpeg.length;
  }
  return out;
}

/**
 * Cuts a camera clip. `offsetMs` maps device-local time to session time
 * (session = local − offset).
 */
export function cutClip(chunks: LoadedChunk[], span: Span, offsetMs: number): CutResult | null {
  const hits = overlapping(chunks, span);
  if (hits.length === 0) return null;
  if (hits.every((c) => c.meta.body_format === 'mjpeg')) {
    const frames: { t_ms: number; jpeg: Uint8Array }[] = [];
    const used: number[] = [];
    for (const c of hits) {
      let parsed: { t_ms: number; jpeg: Uint8Array }[];
      try {
        parsed = parseMjpeg(c.body);
      } catch {
        continue;
      }
      const keep = parsed.filter((f) => {
        const s = f.t_ms - offsetMs;
        return s >= span.t_start_ms && s < span.t_end_ms;
      });
      if (keep.length) {
        frames.push(...keep);
        used.push(c.meta.index);
      }
    }
    if (frames.length === 0) return null;
    return { bytes: encodeMjpeg(frames), used, mime: 'video/x-motion-jpeg' };
  }
  // mp4 (or mixed): the chunk with the largest overlap, whole.
  let best = hits[0]!;
  let bestOv = -1;
  for (const c of hits) {
    const ov = overlap(c.session_start_ms, c.session_start_ms + c.meta.duration_ms, span.t_start_ms, span.t_end_ms);
    if (ov > bestOv) {
      best = c;
      bestOv = ov;
    }
  }
  return { bytes: best.body, used: [best.meta.index], mime: best.meta.body_format === 'mjpeg' ? 'video/x-motion-jpeg' : 'video/mp4' };
}

/** Cuts an audio span out of WAV chunks (concatenating across chunk boundaries). */
export function cutAudio(chunks: LoadedChunk[], span: Span): CutResult | null {
  const hits = overlapping(chunks, span);
  const parts: Int16Array[] = [];
  const used: number[] = [];
  let rate = 16000;
  for (const c of hits) {
    let wav;
    try {
      wav = decodeWav(c.body);
    } catch {
      continue;
    }
    rate = wav.sampleRate;
    const from = Math.max(0, Math.floor(((span.t_start_ms - c.session_start_ms) * rate) / 1000));
    const to = Math.min(wav.samples.length, Math.ceil(((span.t_end_ms - c.session_start_ms) * rate) / 1000));
    if (to <= from) continue;
    parts.push(wav.samples.subarray(from, to));
    used.push(c.meta.index);
  }
  if (parts.length === 0) return null;
  const n = parts.reduce((a, p) => a + p.length, 0);
  const pcm = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    pcm.set(p, o);
    o += p.length;
  }
  return { bytes: encodeWav(pcm, rate), used, mime: 'audio/wav' };
}

/** Concatenates all WAV chunks of one witness (for the transcript). */
export function joinAudio(chunks: LoadedChunk[], maxMs = 10 * 60_000): Uint8Array | null {
  const all = [...chunks].sort((a, b) => a.meta.index - b.meta.index);
  if (all.length === 0) return null;
  const start = all[0]!.session_start_ms;
  const end = Math.min(all.at(-1)!.session_start_ms + all.at(-1)!.meta.duration_ms, start + maxMs);
  return cutAudio(all, { t_start_ms: start, t_end_ms: end })?.bytes ?? null;
}
