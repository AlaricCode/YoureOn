import { afterEach, describe, expect, it, vi } from 'vitest';
import { BET_STATE, evaluateSession, simulate, TRACK_FLAG_CROSS_CHECK_OK, type RawDetection, type SessionTracks } from '@verdict/engine';
import { createHash } from 'node:crypto';
import { mockBaseEmbedding } from '../../src/providers/mock/identity.js';
import { faceObservations, reidLinks, type RawDetectionWithFace } from '../../src/lifecycle/identity.js';
import { MEDIA_URL_TTL_MS } from '../../src/lifecycle/mediaUrls.js';
import { decisiveEvents, perceptionSeed } from '../../src/lifecycle/seal.js';
import { lifecycleStores } from '../../src/lifecycle/stores.js';
import type { PerceptionHostResult, PerceptionRequest } from '../../src/providers/types.js';
import { createBet, enrollFace, makeWorld, playBet, vector, type World } from './fixtures.js';

let w: World | null = null;
afterEach(async () => {
  await w?.app.close();
  w = null;
});

/** RawDetection JSON Lines equivalent of a session (what a real §6.0 job returns). */
function toRaw(s: SessionTracks, width = 1920, height = 1080): RawDetection[] {
  const out: RawDetection[] = [];
  s.tracks.forEach((t, ti) => {
    t.frames.forEach((q, f) => {
      if (!q || q.conf === 0) return;
      out.push({
        t_ms: f * 100 + 10,
        entity: t.entity,
        track_id: ti + 1,
        bbox_px: [(q.x0 * width) / 10000 + 0.01, (q.y0 * height) / 10000 + 0.01, (q.x1 * width) / 10000 + 0.01, (q.y1 * height) / 10000 + 0.01],
        mask_area_px: 0,
        confidence: q.conf / 100 + 0.001,
      });
    });
  });
  return out;
}

describe('real-host path (RawDetection → quantizeSession)', () => {
  it('quantizes raw detections from both hosts, cross-checks and rules', async () => {
    w = await makeWorld();
    const seen: PerceptionRequest[] = [];
    vi.spyOn(w.ctx.providers.perception, 'runPair').mockImplementation(async (req) => {
      seen.push(req);
      const sim = simulate(req.program, req.calibration, 'pass', req.seed);
      const host = (tag: string, s: SessionTracks): PerceptionHostResult => ({
        host: { provider: 'io.net', job_id: `job-${tag}`, url: `https://example.invalid/${tag}`, market: null },
        network: 'mainnet',
        model_hash: s.model_hash,
        flags: s.flags,
        raw: toRaw(s),
        session: null,
      });
      return { a: host('a', sim.a), b: host('b', sim.b) };
    });
    const bet = await createBet(w, 'ex2_cup_tower_pass');
    await playBet(w, bet);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.seed).toBe(perceptionSeed(bet.id));
    expect(req.prompts).toEqual([
      { entity: 'tower', phrase: 'cup tower' },
      { entity: 'fan', phrase: 'fan' },
    ]);
    expect(req.video_urls.map((v) => v.index)).toEqual([0, 1]);
    // Signed, tokenless URLs (workers have no bearer token): the body downloads with the URL alone.
    const url0 = req.video_urls[0]!.url;
    expect(url0).toMatch(/\/v1\/media\/chunks\/[1-9A-HJ-NP-Za-km-z]+\/[1-9A-HJ-NP-Za-km-z]+\/0\?exp=\d+&sig=[0-9a-f]{64}$/);
    const path = url0.slice(url0.indexOf('/v1/'));
    const got = await w.app.inject({ method: 'GET', url: path });
    expect(got.statusCode).toBe(200);
    expect(createHash('sha256').update(got.rawPayload).digest('hex')).toBe(req.video_urls[0]!.sha256);
    // Tampered index / signature, or expired: refused.
    expect((await w.app.inject({ method: 'GET', url: path.replace('/0?', '/1?') })).statusCode).toBe(401);
    expect((await w.app.inject({ method: 'GET', url: path.replace(/sig=([0-9a-f])/, (_m, c: string) => `sig=${c === '0' ? '1' : '0'}`) })).statusCode).toBe(401);
    w.clock.advance(MEDIA_URL_TTL_MS + 1);
    expect((await w.app.inject({ method: 'GET', url: path })).statusCode).toBe(401);
    expect(req.need_reid).toBe(false);
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.state).toBe(BET_STATE.PreRuled);
    expect(acct.winner_mask).toBe(1);
    const rec = lifecycleStores(w.ctx).perception.get(bet.id)!;
    expect(rec.hosts.map((h) => h.network)).toEqual(['mainnet', 'mainnet']);
    expect(rec.cross?.ok).toBe(true);
  });

  it('silent actor on a real host: face embeddings on person lines identify the shooter (no voice)', async () => {
    w = await makeWorld();
    await enrollFace(w, w.alice);
    await enrollFace(w, w.bob);
    w.clock.advance(1000);
    const seen: PerceptionRequest[] = [];
    vi.spyOn(w.ctx.providers.perception, 'runPair').mockImplementation(async (req) => {
      seen.push(req);
      const sim = simulate(req.program, req.calibration, 'pass', req.seed);
      const shooterEmb = Array.from(mockBaseEmbedding(w!.bob.user.id, 'face'));
      const host = (tag: string, s: SessionTracks): PerceptionHostResult => {
        const raw = toRaw(s).map((d): RawDetectionWithFace => {
          if (d.entity !== 'shooter') return d;
          // An anonymous person track (the worker does not know who it is) with a face every 3rd frame.
          const f = Math.floor(d.t_ms / 100);
          return { ...d, entity: 'person', track_id: 7, ...(f % 3 === 0 ? { face: { emb: shooterEmb, conf: 0.95 } } : {}) };
        });
        return {
          host: { provider: 'io.net', job_id: `job-${tag}`, url: null, market: null },
          network: 'mainnet',
          model_hash: s.model_hash,
          flags: s.flags,
          raw,
          session: null,
          frame: { width_px: 1920, height_px: 1080 },
        };
      };
      return { a: host('a', sim.a), b: host('b', sim.b) };
    });
    const bet = await createBet(w, 'ex1_paper_ball_pass');
    await playBet(w, bet);
    expect(seen[0]!.need_faces).toBe(true);
    const rec = lifecycleStores(w.ctx).perception.get(bet.id)!;
    expect(rec.proofs.length).toBeGreaterThan(0);
    expect(rec.proofs[0]).toMatchObject({ participant: 1, modality: 'face', status: 'verified' });
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.n_bio).toBeGreaterThan(0);
    expect(acct.state).toBe(BET_STATE.PreRuled);
    expect(acct.prerule_reason).not.toBe(10);
    expect(acct.state).not.toBe(BET_STATE.Disputed);
    expect(acct.winner_mask).toBe(2);
  });

  it('faceObservations: stride frames only, smallest t_ms per (frame, track), sorted; reid links within the look-back', () => {
    const tmpl = Int8Array.from({ length: 128 }, (_, i) => (i % 7) - 3);
    const emb = Array.from(tmpl, (v) => v / 10);
    const line = (t_ms: number, track_id: number, face = true, reid?: number[]): RawDetectionWithFace => ({
      t_ms,
      entity: 'person',
      track_id,
      bbox_px: [0, 0, 10, 10],
      mask_area_px: 1,
      confidence: 0.9,
      ...(face ? { face: { emb, conf: 0.9 } } : {}),
      ...(reid ? { reid } : {}),
    });
    const raw = [line(310, 2), line(300, 2), line(30, 1), line(110, 1), line(605, 1, false)];
    const obs = faceObservations(raw, { face: [tmpl, null], voice: [] }, 100);
    expect(obs.observations.map((o) => [o.frame, o.track_id])).toEqual([
      [0, 1],
      [3, 2],
    ]);
    expect(obs.observations[0]!.scores).toEqual([
      { candidate: 0, cos_bps: 10000 },
      { candidate: 1, cos_bps: 0 },
    ]);
    const v = [1, 0, 0];
    const links = reidLinks(
      [line(0, 1, false, v), line(1000, 1, false, v), line(2000, 2, false, [0.99, 0.1, 0]), line(9000, 3, false, v)],
      [
        { track_id: 1, frames: [] },
        { track_id: 2, frames: [] },
        { track_id: 3, frames: [] },
      ],
      100,
    );
    expect(links).toEqual([{ from_track: 1, to_track: 2, sim_bps: 9949 }]);
  });

  it('derives audio-checked decisive events (§7.6) from the leaf signals at decisive frames', () => {
    const v = vector('ex1_paper_ball_pass');
    const sim = simulate(v.program, v.calibration, 'pass', 7);
    const sess = { ...sim.a, flags: sim.a.flags | TRACK_FLAG_CROSS_CHECK_OK };
    const first = evaluateSession(v.program, v.calibration, sess, []);
    const full = evaluateSession(v.program, v.calibration, sess, first.checkpoints);
    const evs = decisiveEvents(v.program, v.calibration, sess, full);
    const types = new Set(evs.map((e) => e.type));
    expect(types.has('released_by')).toBe(true);
    for (const e of evs) expect(full.decisive_frames[0]).toContain(e.frame);
  });
});
