import { afterEach, describe, expect, it, vi } from 'vitest';
import { BET_STATE, evaluateSession, simulate, TRACK_FLAG_CROSS_CHECK_OK, type RawDetection, type SessionTracks } from '@verdict/engine';
import { decisiveEvents, perceptionSeed } from '../../src/lifecycle/seal.js';
import { lifecycleStores } from '../../src/lifecycle/stores.js';
import type { PerceptionHostResult, PerceptionRequest } from '../../src/providers/types.js';
import { createBet, makeWorld, playBet, vector, type World } from './fixtures.js';

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
    expect(req.video_urls[0]!.url).toMatch(/\/chunks\/[1-9A-HJ-NP-Za-km-z]+\/0$/);
    expect(req.need_reid).toBe(false);
    const acct = (await w.ctx.chain.getBet(bet.id))!;
    expect(acct.state).toBe(BET_STATE.PreRuled);
    expect(acct.winner_mask).toBe(1);
    const rec = lifecycleStores(w.ctx).perception.get(bet.id)!;
    expect(rec.hosts.map((h) => h.network)).toEqual(['mainnet', 'mainnet']);
    expect(rec.cross?.ok).toBe(true);
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
