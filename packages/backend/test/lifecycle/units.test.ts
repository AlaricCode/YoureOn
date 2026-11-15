import { describe, expect, it } from 'vitest';
import type { Program } from '@verdict/engine';
import { KeyedLock } from '../../src/lifecycle/locks.js';
import { calibrationComplete, sessionFromDetections } from '../../src/lifecycle/scene.js';
import { formatUsd } from '../../src/lifecycle/userTx.js';

describe('formatUsd (§12.9)', () => {
  it('formats base units with 2 decimals and separators', () => {
    expect(formatUsd(5_000_000n)).toBe('$5.00');
    expect(formatUsd(1_234_500_000n)).toBe('$1,234.50');
    expect(formatUsd(9_999)).toBe('$0.00');
    expect(formatUsd(-400_000n)).toBe('−$0.40');
  });
});

describe('KeyedLock', () => {
  it('serializes per key and runs other keys concurrently', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const slow = (tag: string, ms: number) => lock.run(tag.split(':')[0]!, async () => {
      log.push(`${tag}+`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${tag}-`);
    });
    await Promise.all([slow('a:1', 20), slow('a:2', 1), slow('b:1', 1)]);
    expect(log.indexOf('a:1-')).toBeLessThan(log.indexOf('a:2+'));
    expect(log.indexOf('b:1+')).toBeLessThan(log.indexOf('a:1-'));
    expect(lock.busy('a')).toBe(false);
  });

  it('releases after a failure', async () => {
    const lock = new KeyedLock();
    await expect(lock.run('k', async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await lock.run('k', async () => 1)).toBe(1);
  });
});

const PROGRAM = {
  version: 2,
  kind: 'rules',
  participants: ['7dEr7cjNoH37VgRJoXHHeJHNvZmZh45xHCAZMZp3UYa3', 'FJQ4C4H9P1Dx9NR9tYaqzX9E3xL2oSMvxetkuqJA25Tq'],
  sides: [0, 1],
  entities: [
    { name: 'me', kind: 'person', participant: 0 },
    { name: 'ball', kind: 'object', phrase: 'ball' },
    { name: 'goal', kind: 'region', shape: 'zone' },
  ],
  legs: [],
  outcome: { if_true: 0, condition: { op: 'leg', id: 1 }, else: 1 },
  stake_each: 10000,
  time_limit_s: 60,
} as unknown as Program;

describe('scene helpers', () => {
  it('binds persons to the largest unlabelled person detection (D-45)', () => {
    const s = sessionFromDetections(PROGRAM, [
      [
        { entity: 'person', bbox: [0, 0, 100, 100], conf: 80 },
        { entity: 'person', bbox: [0, 0, 1000, 2000], conf: 70 },
        { entity: 'ball', bbox: [10, 10, 20, 20], conf: 90 },
      ],
      [],
    ]);
    expect(s.n_frames).toBe(2);
    expect(s.tracks.map((t) => t.entity)).toEqual(['me', 'ball']);
    expect(s.tracks[0]!.frames[0]).toMatchObject({ x1: 1000, y1: 2000, conf: 70 });
    expect(s.tracks[0]!.participant_idx).toBe(0);
    expect(s.tracks[0]!.ref_h).toBe(2000);
    expect(s.tracks[1]!.frames[1]).toBeNull();
  });

  it('requires every region entity to be placed', () => {
    const cal = { version: 1, scene: { camera: { width_px: 1, height_px: 1, orientation: 'landscape' }, entity_refs: [] }, regions: [] } as never;
    expect(calibrationComplete(PROGRAM, null)).toBe(false);
    expect(calibrationComplete(PROGRAM, cal)).toBe(false);
    expect(calibrationComplete({ ...PROGRAM, kind: 'ai_judged' } as Program, null)).toBe(true);
  });
});
