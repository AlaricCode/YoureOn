/**
 * PCM16 mono WAV encode/decode. Mock TTS/SFX return bundled silent/beep
 * WAVs (§13); the start sequence also serves the synthesized beacon (§7.5).
 */

export function encodeWav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, 44 + i * 2);
  return new Uint8Array(buf);
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** first channel, PCM16 */
  samples: Int16Array;
}

/** Decodes a PCM16 WAV (any channel count; returns channel 0). Throws on other formats. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt: { channels: number; rate: number; bits: number; format: number } | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(body), channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits: b.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV: data before fmt');
      if ((fmt.format !== 1 && fmt.format !== 0xfffe) || fmt.bits !== 16) throw new Error('WAV: only PCM16 is supported');
      const end = Math.min(b.length, body + size);
      const frames = Math.floor((end - body) / (2 * fmt.channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) samples[i] = b.readInt16LE(body + i * 2 * fmt.channels);
      return { sampleRate: fmt.rate, channels: fmt.channels, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV: no data chunk');
}

export function silentWav(ms: number, sampleRate = 16000): Uint8Array {
  return encodeWav(new Int16Array(Math.round((ms * sampleRate) / 1000)), sampleRate);
}

/** Short sine beep with 10 ms linear fades. */
export function beepWav(ms = 300, hz = 880, sampleRate = 48000, amplitude = 0.25): Uint8Array {
  const n = Math.round((ms * sampleRate) / 1000);
  const ramp = Math.min(Math.round(sampleRate / 100), Math.floor(n / 2));
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / ramp, (n - 1 - i) / ramp);
    pcm[i] = Math.round(32767 * amplitude * env * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return encodeWav(pcm, sampleRate);
}
