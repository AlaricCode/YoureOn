import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildMultipart } from '../../net/multipart';
import { buildEvidence, frameTimesMs, hashFrames, MAX_FRAME_BYTES, mimeForUri } from '../frames';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('frame sampling (u4d4)', () => {
  it('8 frames by default, strictly increasing, inside the clip, half in the last second', () => {
    const t = frameTimesMs(6000);
    expect(t).toHaveLength(8);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!);
    expect(t[0]).toBe(0);
    expect(t.at(-1)!).toBeLessThan(6000);
    expect(t.filter((x) => x >= 6000 - 1100)).toHaveLength(4);
  });
  it('clamps the count to 8..12 and survives very short clips', () => {
    expect(frameTimesMs(6000, 3)).toHaveLength(8);
    expect(frameTimesMs(6000, 30)).toHaveLength(12);
    const short = frameTimesMs(120);
    expect(short).toHaveLength(8);
    for (let i = 1; i < short.length; i++) expect(short[i]!).toBeGreaterThan(short[i - 1]!);
  });
});

describe('evidence', () => {
  const jpeg = (n: number) => new Uint8Array(1000 + n).fill(n);
  const frames = frameTimesMs(6000).map((t_ms, i) => ({ t_ms, jpeg: jpeg(i) }));

  it('hashes each frame (sha256 hex, matching Node) in send order', () => {
    const h = hashFrames(frames);
    expect(h.map((f) => f.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    h.forEach((f, i) => expect(f.sha256).toBe(nodeSha(frames[i]!.jpeg)));
  });

  it('builds a valid CameraEvidence with the clip hash', () => {
    const clip = new Uint8Array(5000).fill(7);
    const e = buildEvidence({
      bet_id: BET,
      attempt_no: 2,
      clip,
      mime: 'video/quicktime',
      duration_ms: 5999.6,
      recorded_by: 'A',
      recorded_at: '2026-11-21T18:07:06.000Z',
      frames,
    });
    expect(e.clip_sha256).toBe(nodeSha(clip));
    expect(e.clip_bytes).toBe(5000);
    expect(e.duration_ms).toBe(6000);
    expect(e.frames).toHaveLength(8);
  });

  it('rejects oversized or empty frames', () => {
    const bad = [{ t_ms: 0, jpeg: new Uint8Array(MAX_FRAME_BYTES + 1) }];
    expect(() =>
      buildEvidence({
        bet_id: BET,
        attempt_no: 1,
        clip: new Uint8Array(1),
        mime: 'video/mp4',
        duration_ms: 1,
        recorded_by: 'A',
        recorded_at: '2026-11-21T18:07:06.000Z',
        frames: bad,
      }),
    ).toThrow();
  });

  it('mime from the file extension', () => {
    expect(mimeForUri('file:///x/clip.mov')).toBe('video/quicktime');
    expect(mimeForUri('file:///x/clip.mp4')).toBe('video/mp4');
  });

  it('multipart: evidence first, then frames in index order, bytes intact', () => {
    const mp = buildMultipart(
      [
        { name: 'evidence', contentType: 'application/json', body: '{"k":1}' },
        {
          name: 'frame',
          filename: '00.jpg',
          contentType: 'image/jpeg',
          body: new Uint8Array([0, 255, 13, 10]),
        },
      ],
      'B',
    );
    const text = Buffer.from(mp.bytes).toString('latin1');
    expect(mp.contentType).toBe('multipart/form-data; boundary=B');
    expect(text).toBe(
      '--B\r\nContent-Disposition: form-data; name="evidence"\r\nContent-Type: application/json\r\n\r\n{"k":1}\r\n' +
        '--B\r\nContent-Disposition: form-data; name="frame"; filename="00.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\u0000ÿ\r\n\r\n' +
        '--B--\r\n',
    );
  });
});
