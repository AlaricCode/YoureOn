import { describe, expect, it } from 'vitest';
import { bytesToEmbedding, FaceMatchResponse, type FaceMatchRequest } from '@youre-on/shared/face';

import type { FaceEmbedder } from '../../enroll/embedder';
import type { DetectedFace } from '../../enroll/flow';
import { SCAN_MISS_COPY } from '../../screens/copy';
import { checkCopy } from '../../ui/copyRule';
import {
  cameraActive,
  challengeErrorResult,
  initialScan,
  matchErrorMiss,
  runScan,
  scanReducer,
  showsFallbackList,
  ticketFresh,
  TICKET_MARGIN_MS,
  type ScanEvent,
  type ScanMatch,
  type ScanMiss,
  type ScanState,
} from '../scan';

const MATCH: ScanMatch = {
  user: { user_id: 'b', display_name: 'Jake' },
  ticket: 'mt1.x.y',
  expiresAtMs: 1_000_000,
  headToHead: { wins: 4, losses: 7, net: '-7000000' },
};

const run = (...events: ScanEvent[]): ScanState => events.reduce(scanReducer, initialScan);
const miss = (m: ScanMiss): ScanEvent => ({ type: 'result', outcome: { kind: 'miss', miss: m } });
const found: ScanEvent = { type: 'result', outcome: { kind: 'found', match: MATCH } };

describe('scan reducer', () => {
  it('scan -> checking -> found -> challenging', () => {
    expect(run({ type: 'scan' })).toMatchObject({ phase: 'checking', miss: null });
    expect(run({ type: 'scan' }, found)).toEqual({
      phase: 'found',
      match: MATCH,
      miss: null,
      misses: 0,
    });
    expect(run({ type: 'scan' }, found, { type: 'challenge' }).phase).toBe('challenging');
  });

  it('a miss goes back to the camera with its line and counts', () => {
    const s = run({ type: 'scan' }, miss('no_face'));
    expect(s).toEqual({ phase: 'idle', match: null, miss: 'no_face', misses: 1 });
    expect(run({ type: 'scan' }, miss('no_face'), { type: 'scan' }, miss('too_far')).misses).toBe(
      2,
    );
    // A new scan clears the line; a match resets the count.
    expect(run({ type: 'scan' }, miss('no_face'), { type: 'scan' }).miss).toBeNull();
    expect(run({ type: 'scan' }, miss('no_face'), { type: 'scan' }, found).misses).toBe(0);
  });

  it('ignores a second scan while one runs, and stale results', () => {
    const checking = run({ type: 'scan' });
    expect(scanReducer(checking, { type: 'scan' })).toBe(checking);
    expect(scanReducer(initialScan, found)).toBe(initialScan);
    const challenging = run({ type: 'scan' }, found, { type: 'challenge' });
    expect(scanReducer(challenging, { type: 'scan' })).toBe(challenging);
    expect(scanReducer(challenging, { type: 'not_them' })).toBe(challenging);
  });

  it('"Not them" drops the card; a scan from the card rescans', () => {
    expect(run({ type: 'scan' }, found, { type: 'not_them' })).toEqual({
      phase: 'idle',
      match: null,
      miss: null,
      misses: 0,
    });
    expect(run({ type: 'scan' }, found, { type: 'scan' })).toMatchObject({
      phase: 'checking',
      match: null,
    });
  });

  it('a failed challenge (expired ticket) returns to the camera with "Scan again"', () => {
    const s = run(
      { type: 'scan' },
      found,
      { type: 'challenge' },
      {
        type: 'challenge_failed',
        miss: 'expired',
      },
    );
    expect(s).toEqual({ phase: 'idle', match: null, miss: 'expired', misses: 1 });
    expect(scanReducer(initialScan, { type: 'challenge_failed', miss: 'failed' })).toBe(
      initialScan,
    );
    expect(scanReducer(s, { type: 'reset' })).toBe(initialScan);
  });

  it('the room list (face_pick_list) shows after "No match", or two misses of any kind', () => {
    expect(showsFallbackList(initialScan)).toBe(false);
    expect(showsFallbackList(run({ type: 'scan' }, miss('no_match')))).toBe(true);
    expect(showsFallbackList(run({ type: 'scan' }, miss('no_face')))).toBe(false);
    expect(
      showsFallbackList(run({ type: 'scan' }, miss('no_face'), { type: 'scan' }, miss('failed'))),
    ).toBe(true);
    // Hidden while a scan runs and on the card.
    expect(showsFallbackList(run({ type: 'scan' }, miss('no_match'), { type: 'scan' }))).toBe(
      false,
    );
  });

  it('the camera is off on the match card (haptics are silent while it runs)', () => {
    expect(cameraActive(initialScan)).toBe(true);
    expect(cameraActive(run({ type: 'scan' }))).toBe(true);
    expect(cameraActive(run({ type: 'scan' }, found))).toBe(false);
    expect(cameraActive(run({ type: 'scan' }, found, { type: 'challenge' }))).toBe(false);
  });

  it('a ticket close to expiry is not worth sending', () => {
    expect(ticketFresh(MATCH, MATCH.expiresAtMs - TICKET_MARGIN_MS - 1)).toBe(true);
    expect(ticketFresh(MATCH, MATCH.expiresAtMs - TICKET_MARGIN_MS)).toBe(false);
  });

  it('every miss has a copy-rule line', () => {
    for (const [, [text, role]] of Object.entries(SCAN_MISS_COPY)) {
      expect(checkCopy(text, role)).toEqual([]);
    }
    expect(SCAN_MISS_COPY.no_match[0]).toBe('No match');
  });
});

// ---- runScan ----------------------------------------------------------------------------

const face = (x: number, size: number, extra: Partial<DetectedFace> = {}): DetectedFace => ({
  yawAngle: 4.4,
  pitchAngle: 0,
  bounds: { x, y: 500, width: size, height: size },
  frameWidth: 960,
  frameHeight: 1280,
  landmarks: { LEFT_EYE: { x: x + 10, y: 520 }, RIGHT_EYE: { x: x + 40, y: 520 } },
  ...extra,
});

function fakeEmbedder(
  faces: DetectedFace[],
  opts: { failEmbed?: boolean; failOpen?: boolean } = {},
) {
  const log: string[] = [];
  const vec = new Float32Array(512);
  vec[3] = 1;
  const embedder: FaceEmbedder = {
    preview: false,
    async open(url) {
      log.push(`open ${url}`);
      if (opts.failOpen) throw new Error('no model');
      return {
        faces,
        width: 960,
        height: 1280,
        async embed(f) {
          log.push(`embed ${f.bounds.x}`);
          if (opts.failEmbed) throw new Error('tflite');
          return vec;
        },
        close() {
          log.push('close');
        },
      };
    },
  };
  return { embedder, log, vec };
}

const matched: FaceMatchResponse = FaceMatchResponse.parse({
  match: {
    user: {
      user_id: '00000000-0000-4000-8000-00000000000b',
      pubkey: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      display_name: 'Jake',
      avatar_url: null,
    },
    match_ticket: 'mt1.abc.def',
    ticket_expires_at: '2026-11-21T18:05:00.000Z',
    head_to_head: {
      wins: 4,
      losses: 7,
      pushes: 0,
      net: '-7000000',
      net_display: '−$7',
      last_settled_at: null,
      includes_seed: true,
    },
  },
});

describe('runScan', () => {
  it('embeds the central face, sends only the embedding, and returns the match', async () => {
    const e = fakeEmbedder([face(0, 300), face(330, 290)]);
    const sent: FaceMatchRequest[] = [];
    const out = await runScan(
      {
        embedder: e.embedder,
        faceMatch: async (req) => {
          sent.push(req);
          return matched;
        },
        now: () => Date.parse('2026-11-21T18:04:00.000Z'),
      },
      'file:///photo.jpg',
    );
    expect(out).toEqual({
      kind: 'found',
      match: {
        user: { user_id: '00000000-0000-4000-8000-00000000000b', display_name: 'Jake' },
        ticket: 'mt1.abc.def',
        expiresAtMs: Date.parse('2026-11-21T18:05:00.000Z'),
        headToHead: { wins: 4, losses: 7, net: '-7000000' },
      },
    });
    expect(e.log).toEqual(['open file:///photo.jpg', 'embed 330', 'close']);
    const req = sent[0]!;
    expect(req.model).toEqual({ name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 });
    expect(req.probe.alg).toBe('plain-v0');
    const bytes = Uint8Array.from(atob(req.probe.ct_b64), (c) => c.charCodeAt(0));
    const probe = bytesToEmbedding(bytes);
    expect(probe.length).toBe(512);
    expect(probe[3]).toBe(1);
    expect(req.capture).toEqual({
      captured_at: '2026-11-21T18:04:00.000Z',
      eye_distance_px: 30,
      yaw_deg: 4,
    });
    // The phone's copy of the embedding is zeroed once the request is built.
    expect(e.vec.every((x) => x === 0)).toBe(true);
    // Nothing in the request but the embedding and metadata.
    expect(Object.keys(req).sort()).toEqual(['capture', 'model', 'probe']);
  });

  it('no confident match -> no_match', async () => {
    const e = fakeEmbedder([face(330, 300)]);
    const out = await runScan(
      { embedder: e.embedder, faceMatch: async () => ({ match: null }), now: Date.now },
      'file:///p.jpg',
    );
    expect(out).toEqual({ kind: 'miss', miss: 'no_match' });
  });

  it('no face or a face too far away never reaches the server', async () => {
    let calls = 0;
    const deps = (faces: DetectedFace[]) => ({
      embedder: fakeEmbedder(faces).embedder,
      faceMatch: async () => {
        calls++;
        return matched;
      },
      now: Date.now,
    });
    expect(await runScan(deps([]), 'file:///p.jpg')).toEqual({ kind: 'miss', miss: 'no_face' });
    expect(await runScan(deps([face(400, 40)]), 'file:///p.jpg')).toEqual({
      kind: 'miss',
      miss: 'too_far',
    });
    expect(calls).toBe(0);
  });

  it('a failed embed or model load is a miss, and the still is closed', async () => {
    const e = fakeEmbedder([face(330, 300)], { failEmbed: true });
    expect(
      await runScan({ embedder: e.embedder, faceMatch: async () => matched, now: Date.now }, 'u'),
    ).toEqual({ kind: 'miss', miss: 'failed' });
    expect(e.log.at(-1)).toBe('close');
    const f = fakeEmbedder([], { failOpen: true });
    expect(
      await runScan({ embedder: f.embedder, faceMatch: async () => matched, now: Date.now }, 'u'),
    ).toEqual({ kind: 'miss', miss: 'failed' });
  });

  it('maps server errors to misses', async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    for (const [code, m] of [
      ['NOT_IN_ROOM', 'not_in_room'],
      ['ROOM_EXPIRED', 'not_in_room'],
      ['RATE_LIMITED', 'busy'],
      ['FACE_MODEL_UNSUPPORTED', 'failed'],
      ['NETWORK', 'failed'],
    ] as const) {
      const e = fakeEmbedder([face(330, 300)]);
      expect(
        await runScan(
          {
            embedder: e.embedder,
            faceMatch: async () => {
              throw err(code);
            },
            now: Date.now,
          },
          'u',
        ),
      ).toEqual({ kind: 'miss', miss: m });
    }
    expect(matchErrorMiss(null)).toBe('failed');
  });
});

describe('challenge errors (POST /v1/bets with a face ticket)', () => {
  const err = (code: string, details?: object) => ({ code, details });
  it('maps the server reasons the scan screen can act on', () => {
    expect(challengeErrorResult(err('VALIDATION_FAILED', { reason: 'match_ticket_invalid' }))).toBe(
      'expired',
    );
    expect(challengeErrorResult(err('VALIDATION_FAILED', { reason: 'self_challenge' }))).toBe(
      'failed',
    );
    expect(challengeErrorResult(err('INVALID_STATE', { reason: 'pair_busy' }))).toBe('pair_busy');
    expect(challengeErrorResult(err('NOT_IN_ROOM'))).toBe('not_in_room');
    expect(challengeErrorResult(err('RATE_LIMITED'))).toBe('busy');
    expect(challengeErrorResult(new Error('offline'))).toBe('failed');
  });
});
