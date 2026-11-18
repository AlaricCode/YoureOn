// SAM 3.1 camera checks on the four real bottle-flip clips (design final.md §8 fixtures; clips
// A-D of final_examples.txt): the saved /segment replies (masks: true) over the 12 judge frames,
// evaluated GPU-free with the bottle-flip spec.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checksVeto, CheckReport, evaluateChecks } from '../../src/checks/evaluate';
import { decodeRle, mainBlob } from '../../src/checks/rle';
import { SamSegmentReply } from '../../src/checks/sam-reply';
import { CheckSpec } from '../../src/checks/spec';
import { judgeFrameTimesMs } from '../../src/judge/frames';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '../fixtures/sam3');
interface Fixture {
  clip: string;
  duration_ms: number;
  sampling: 'judge';
  frames: number;
  prompt: string;
  ground_truth: string;
  reply: unknown;
}
const fixtures = new Map<string, Fixture>(
  readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const j = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Fixture;
      return [j.clip, j];
    }),
);

const BOTTLE_FLIP = CheckSpec.parse({
  predicates: 'p1',
  entities: [{ key: 'bottle', prompt: 'bottle', count: 1 }],
  assertions: [
    { role: 'gate', test: { p: 'visible', e: 'bottle', window: 'end' } },
    { role: 'need', test: { p: 'at_rest', e: 'bottle', ref: null } },
    { role: 'need', test: { p: 'upright', e: 'bottle' } },
  ],
});

function report(clip: string) {
  const fx = fixtures.get(clip)!;
  const times = judgeFrameTimesMs(fx.duration_ms, fx.frames);
  return CheckReport.parse(
    evaluateChecks(BOTTLE_FLIP, fx.reply, times, fx.duration_ms, {
      terms_hash: '0'.repeat(64),
      frame_hashes: times.map(() => '1'.repeat(64)),
      created_at: '2026-11-18T00:00:00.000Z',
    }),
  );
}
const measure = (r: CheckReport, i: number, k: string) =>
  r.results[i]!.measures.find((m) => m.k === k)?.v;

describe('fixtures/sam3: the four bottle-flip clips', () => {
  it('all four are present, 12 judge frames, prompt "bottle", masks included', () => {
    expect([...fixtures.keys()].sort()).toEqual([
      'bottle_flip_1',
      'bottle_flip_2_success',
      'bottle_flip_3_fling',
      'bottle_flip_4_partial',
    ]);
    for (const fx of fixtures.values()) {
      expect(fx).toMatchObject({ sampling: 'judge', frames: 12, prompt: 'bottle' });
      const r = SamSegmentReply.parse(fx.reply);
      expect(r.results[0]!.frames).toHaveLength(12);
    }
  });

  it('the TS RLE decode + 4-connected main blob reproduce the service (box, area, components)', () => {
    let n = 0;
    for (const fx of fixtures.values())
      for (const f of SamSegmentReply.parse(fx.reply).results[0]!.frames)
        for (const o of f.objects) {
          const s = mainBlob(decodeRle(o.mask_rle!))!;
          expect(s.box).toEqual(o.box_xyxy);
          expect(s.maskArea).toBe(o.mask_area);
          expect(s.components).toBe(o.components);
          n++;
        }
    expect(n).toBe(37); // 12 + 10 + 4 + 11 frames with a bottle
  });

  it('bottle_flip_2_success (clip A): gate true, needs true; MET and NOT_MET both stand', () => {
    const r = report('bottle_flip_2_success');
    expect(r.results.map((x) => x.value)).toEqual(['true', 'true', 'true']);
    expect([r.gate, r.need]).toEqual(['true', 'true']);
    expect(measure(r, 2, 'tilt_deg')).toBeLessThan(6);
    expect(measure(r, 2, 'elong')).toBeGreaterThan(2.6);
    expect(measure(r, 1, 'shift_rel')).toBeLessThan(0.01);
    expect(checksVeto('MET', BOTTLE_FLIP, r)).toBeNull();
    expect(checksVeto('NOT_MET', BOTTLE_FLIP, r)).toBeNull();
  });

  it('bottle_flip_1 (clip B, lying ~25 deg): upright unknown, so MET -> REDO, NOT_MET stands', () => {
    const r = report('bottle_flip_1');
    expect(r.results.map((x) => x.value)).toEqual(['true', 'true', 'unknown']);
    expect(r.results[2]!.why).toBe('between_bands');
    expect([r.gate, r.need]).toEqual(['true', 'unknown']);
    expect(measure(r, 2, 'tilt_deg')).toBeGreaterThan(24);
    expect(measure(r, 2, 'tilt_deg')).toBeLessThan(26);
    expect(measure(r, 2, 'elong')).toBeCloseTo(2.26, 1);
    expect(checksVeto('MET', BOTTLE_FLIP, r)).toEqual({
      kind: 'unconfirmed',
      index: 2,
      why: "Couldn't confirm the bottle stands upright. Film from the side.",
    });
    expect(checksVeto('NOT_MET', BOTTLE_FLIP, r)).toBeNull();
  });

  it('bottle_flip_3_fling (clip C, gone after frame 3): gate false, REDO either verdict', () => {
    const r = report('bottle_flip_3_fling');
    expect(r.results[0]).toMatchObject({ value: 'false', why: 'absent', frames: [9, 10, 11] });
    expect(r.results.map((x) => [x.value, x.why])).toEqual([
      ['false', 'absent'],
      ['unknown', 'absent'],
      ['unknown', 'absent'],
    ]);
    expect([r.gate, r.need]).toEqual(['false', 'unknown']);
    for (const c of ['MET', 'NOT_MET'] as const)
      expect(checksVeto(c, BOTTLE_FLIP, r)?.kind).toBe('not_on_camera');
  });

  it('bottle_flip_4_partial (clip D, clipped then lost): gate unknown, REDO either verdict', () => {
    const r = report('bottle_flip_4_partial');
    // frame 9 clipped at the right edge; frame 10 scored -10000 (below S_FLOOR); frame 11 empty
    expect(r.results[0]).toMatchObject({ value: 'unknown', why: 'clipped' });
    expect(r.results.map((x) => [x.value, x.why])).toEqual([
      ['unknown', 'clipped'],
      ['unknown', 'clipped'],
      ['unknown', 'clipped'],
    ]);
    expect([r.gate, r.need]).toEqual(['unknown', 'unknown']);
    for (const c of ['MET', 'NOT_MET'] as const)
      expect(checksVeto(c, BOTTLE_FLIP, r)).toEqual({
        kind: 'not_on_camera',
        index: 0,
        why: "Couldn't see the bottle at the end. Keep it in frame and run it back.",
      });
  });
});
