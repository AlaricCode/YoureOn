// Every string the slow-mo replay shows passes the copy rule (ui/copyRule).
import { describe, expect, it } from 'vitest';

import { checkCopy } from '../../ui/copyRule';
import { REPLAY_COPY, REPLAY_COPY_ROLES, speedTag, winsChip, type ReplayCopyKey } from '../copy';
import { FAKE_NAMES, fakeClipMoment, fakeFoulMoment, fakeWinMoment } from '../fakes';
import { heldFrame, playableFrames, replayCopy } from '../model';

describe('replay copy', () => {
  it.each(Object.keys(REPLAY_COPY) as ReplayCopyKey[])('%s passes for its role', (k) => {
    expect(checkCopy(REPLAY_COPY[k], REPLAY_COPY_ROLES[k])).toEqual([]);
  });

  it('the exact strings', () => {
    expect(REPLAY_COPY).toMatchObject({
      replay: 'Replay',
      badge: 'Slow-mo replay',
      win: 'Winning moment',
      foul: 'Foul',
      judgesFrame: "Judge's frame",
      again: 'Replay again',
      done: 'Done',
      error: 'Replay unavailable',
    });
  });

  it('data strings pass as data', () => {
    expect(checkCopy(winsChip('Logan'), 'data')).toEqual([]);
    expect(checkCopy(speedTag(0.25), 'data')).toEqual([]);
    expect(speedTag(0.25)).toBe('0.25x');
    expect(checkCopy(fakeFoulMoment().foul!.label, 'data')).toEqual([]);
  });

  it('everything replayCopy produces passes (labels as labels, data as data)', () => {
    for (const m of [fakeWinMoment(), fakeFoulMoment(), fakeClipMoment({ burned: true })]) {
      for (const mode of ['frames', 'clip'] as const) {
        const held = heldFrame(
          playableFrames(
            m,
            m.frames.map(() => true),
          ),
        );
        const c = replayCopy(m, FAKE_NAMES, { mode, held });
        for (const label of [c.badge, c.title, c.holdTag].filter((x): x is string => x !== null))
          expect(checkCopy(label, 'label')).toEqual([]);
        for (const data of [c.chip, c.speed, c.holdData].filter((x): x is string => x !== null))
          expect(checkCopy(data, 'data')).toEqual([]);
      }
    }
  });

  it('never shows the word "REPLAY" as a stage-style badge, nor the judge reason', () => {
    const c = replayCopy(fakeWinMoment(), FAKE_NAMES, { mode: 'frames', held: null });
    expect(Object.values(c)).not.toContain('REPLAY');
    expect(Object.values(c)).not.toContain(fakeWinMoment().reason);
  });
});
