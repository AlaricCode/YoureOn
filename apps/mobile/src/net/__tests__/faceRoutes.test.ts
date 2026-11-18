// The Beat 1 wrappers on the typed API: POST /v1/rooms/:id/face-match and the 'face' challenge.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod/v4';

import { createYoApi } from '../api';
import type { ApiClient, RequestOptions } from '../signedFetch';

function fakeClient(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; json: unknown }[] = [];
  const client = {
    clock: { now: () => 0, sync() {}, offsetMs: 0 },
    async request(method: string, path: string, opts?: RequestOptions<z.ZodType | undefined>) {
      calls.push({ method, path, json: opts?.json });
      const body = responses[`${method} ${path}`];
      return opts?.schema ? opts.schema.parse(body) : body;
    },
  } as unknown as ApiClient;
  return { client, calls };
}

const ROOM = '00000000-0000-4000-8000-0000000000aa';
const B = '00000000-0000-4000-8000-00000000000b';

describe('face routes on the typed API', () => {
  it('faceMatch posts the probe to the room and parses either answer', async () => {
    const f = fakeClient({ [`POST /v1/rooms/${ROOM}/face-match`]: { match: null } });
    const api = createYoApi(f.client);
    const req = {
      probe: { alg: 'plain-v0' as const, epk_b64: null, nonce_b64: null, ct_b64: 'AAAA' },
      model: { name: 'w600k_mbf', version: 'buffalo_s-fp32', dim: 512 },
    };
    expect(await api.faceMatch(ROOM, req)).toEqual({ match: null });
    expect(f.calls).toEqual([{ method: 'POST', path: `/v1/rooms/${ROOM}/face-match`, json: req }]);
    const bad = createYoApi(
      fakeClient({ [`POST /v1/rooms/${ROOM}/face-match`]: { score: 1 } }).client,
    );
    await expect(bad.faceMatch(ROOM, req)).rejects.toThrow();
  });

  it("createFaceBet sends challenge_method 'face' with the ticket", async () => {
    const f = fakeClient({});
    const api = createYoApi(f.client);
    await api.createFaceBet(ROOM, B, 'mt1.abc.def').catch(() => undefined);
    expect(f.calls[0]).toEqual({
      method: 'POST',
      path: '/v1/bets',
      json: {
        room_id: ROOM,
        opponent_user_id: B,
        challenge_method: 'face',
        match_ticket: 'mt1.abc.def',
      },
    });
  });
});
