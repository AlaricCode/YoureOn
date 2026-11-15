/**
 * Cross-language check: the JSONL that services/perception emits (golden file
 * written by its CPU pytest) is accepted by the backend parser, the engine
 * §6.2 quantizer and the real-host face observation step.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quantizePersonTracks, quantizeSession } from '@verdict/engine';
import { findRepoRoot } from '../src/config/dotenv.js';
import { faceObservations, type RawDetectionWithFace } from '../src/lifecycle/identity.js';
import { parseDetectionsJsonl } from '../src/providers/real/perception.js';
import { vector } from './lifecycle/fixtures.js';

const GOLDEN = join(findRepoRoot(), 'services', 'perception', 'tests', 'golden', 'detections.jsonl');

describe('services/perception output ↔ backend/engine', () => {
  it('parses, quantizes and yields face observations', () => {
    const raw = parseDetectionsJsonl(readFileSync(GOLDEN, 'utf8')) as RawDetectionWithFace[];
    expect(raw.length).toBeGreaterThan(10);
    const v = vector('ex1_paper_ball_pass');
    const meta = { width_px: 320, height_px: 240, n_frames: 20, model_hash: 'ab'.repeat(32), flags: 0, program: v.program, calibration: v.calibration };
    const s = quantizeSession(raw, meta);
    const ball = s.tracks.find((t) => t.entity === 'ball')!;
    expect(ball.frames.filter((q) => q !== null).length).toBeGreaterThanOrEqual(18);
    const persons = quantizePersonTracks(raw, meta);
    expect(persons).toHaveLength(1);
    const tmpl = Int8Array.from({ length: 128 }, (_, i) => (i === 3 ? 127 : 0));
    const obs = faceObservations(raw, { face: [null, tmpl], voice: [] }, 20);
    expect(obs.observations.length).toBeGreaterThan(0);
    expect(obs.observations.every((o) => o.frame % 3 === 0 && o.track_id === persons[0]!.track_id)).toBe(true);
    expect(obs.observations[0]!.scores[1]!.cos_bps).toBe(10000);
  });
});
