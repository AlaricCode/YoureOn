/**
 * HttpEmbedder ↔ services/embedder contract (§8.1) against a real local HTTP
 * stub: request paths and bodies, response shapes, and error handling.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FACE_DIM, VOICE_DIM } from '@verdict/engine';
import { HttpEmbedder } from '../src/providers/real/sidecars.js';

const seen: { url: string; body: Record<string, unknown> }[] = [];
let mode: 'ok' | 'noface' = 'ok';
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data) as Record<string, unknown>;
      seen.push({ url: req.url ?? '', body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/embed/face') {
        if (mode === 'noface') {
          res.statusCode = 422;
          return res.end(JSON.stringify({ detail: 'no face found' }));
        }
        const n = (body['images_b64'] as string[]).length;
        const v = Array.from({ length: FACE_DIM }, (_, i) => (i === 0 ? 1 : 0));
        return res.end(JSON.stringify({ embeddings: Array.from({ length: n }, () => v) }));
      }
      if (req.url === '/embed/voice') {
        const v = Array.from({ length: VOICE_DIM }, () => 1 / Math.sqrt(VOICE_DIM));
        return res.end(JSON.stringify({ embedding: v }));
      }
      res.statusCode = 404;
      return res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('HttpEmbedder ↔ services/embedder (§8.1)', () => {
  it('POST /embed/face {images_b64:[…]} → {embeddings:[[128]]}; POST /embed/voice {wav_b64} → {embedding:[192]}', async () => {
    const e = new HttpEmbedder(base);
    const face = await e.embedFace(new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]));
    expect(face).toHaveLength(FACE_DIM);
    expect(face[0]).toBeCloseTo(1);
    const voice = await e.embedVoice(new Uint8Array([82, 73, 70, 70]));
    expect(voice).toHaveLength(VOICE_DIM);
    expect(Math.hypot(...voice)).toBeCloseTo(1, 6);
    expect(seen.map((s) => s.url)).toEqual(['/embed/face', '/embed/voice']);
    expect(seen[0]!.body).toEqual({ images_b64: [Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]).toString('base64')] });
    expect(seen[1]!.body).toEqual({ wav_b64: Buffer.from([82, 73, 70, 70]).toString('base64') });
  });

  it('a 4xx (no face found) is an error, never a zero vector', async () => {
    mode = 'noface';
    await expect(new HttpEmbedder(base).embedFace(new Uint8Array([1]))).rejects.toThrow(/HTTP 422/);
    mode = 'ok';
  });
});
