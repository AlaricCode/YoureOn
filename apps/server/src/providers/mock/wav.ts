// Tiny PCM WAV writer for the mock voice providers (deterministic bytes, no assets).

export const MOCK_SAMPLE_RATE = 16_000;

/** 16-bit mono PCM WAV: a sine at `freqHz` (0 = silence) for `ms`, with a 5 ms fade in/out. */
export function toneWav(ms: number, freqHz: number, sampleRate = MOCK_SAMPLE_RATE): Uint8Array {
  const n = Math.max(1, Math.round((ms / 1000) * sampleRate));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  const fade = Math.max(1, Math.round(0.005 * sampleRate));
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    const v = freqHz > 0 ? Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.3 * env : 0;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}
