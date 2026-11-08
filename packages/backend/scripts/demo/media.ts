/**
 * Synthetic media for the demo phones: JPEG-shaped frames, 16 kHz WAV
 * clips, MJPEG camera chunks and microphone chunks that "hear" the start
 * beacon (the app records the beacon WAV played by the camera phone, §7.5).
 * All of it is accepted by the mock providers; nothing is a real recording.
 */
import { createHash } from 'node:crypto';
import { decodeWav, encodeWav } from '../../src/util/wav.js';

let counter = 0;

function bytesFrom(label: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let block = createHash('sha256').update(label).digest();
  for (let i = 0; i < n; i += 32) {
    out.set(block.subarray(0, Math.min(32, n - i)), i);
    block = createHash('sha256').update(block).digest();
  }
  return out;
}

/** A unique JPEG-shaped frame (SOI … EOI), as the camera would send at ≤ 640 px. */
export function frameJpeg(size = 512): Uint8Array {
  const b = bytesFrom(`jpeg:${counter++}`, size);
  b[0] = 0xff;
  b[1] = 0xd8;
  b[2] = 0xff;
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}

/** A unique 16 kHz PCM16 WAV of low noise (speech stand-in). */
export function speechWav(ms = 1500): Uint8Array {
  const n = Math.round((ms * 16000) / 1000);
  const noise = bytesFrom(`wav:${counter++}`, n);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = (noise[i]! - 128) * 4;
  return encodeWav(pcm, 16000);
}

/** MJPEG camera chunk body: repeated `u32 len ‖ u32 t_ms ‖ jpeg` at 10 fps. */
export function mjpegChunk(startMs: number, durationMs: number): Uint8Array {
  const parts: Buffer[] = [];
  for (let t = startMs; t < startMs + durationMs; t += 100) {
    const jpeg = Buffer.from(frameJpeg(64));
    const h = Buffer.alloc(8);
    h.writeUInt32LE(jpeg.length, 0);
    h.writeUInt32LE(t, 4);
    parts.push(h, jpeg);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/**
 * Microphone chunk at the beacon WAV's sample rate. The first chunk contains
 * the beacon (as heard `leadMs` after recording started); later ones are quiet.
 */
export function micChunk(durationMs: number, beaconWav: Uint8Array | null, leadMs = 400): Uint8Array {
  const rate = beaconWav ? decodeWav(beaconWav).sampleRate : 48_000;
  const n = Math.round((durationMs * rate) / 1000);
  const pcm = new Int16Array(n);
  if (beaconWav) {
    const b = decodeWav(beaconWav).samples;
    const at = Math.round((leadMs * rate) / 1000);
    for (let i = 0; i < b.length && at + i < n; i++) pcm[at + i] = Math.round(b[i]! * 0.8);
  }
  return encodeWav(pcm, rate);
}
