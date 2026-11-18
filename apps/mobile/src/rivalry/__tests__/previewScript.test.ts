import { describe, expect, it } from 'vitest';

import { createLiveScanEngine } from '../../app/liveScan';
import { overlayItems } from '../geometry';
import {
  createFakeClock,
  createPreviewLiveDeps,
  panDetections,
  PREVIEW_LOOP_MS,
  simulateTo,
} from '../previewScript';
import type { LiveSnapshot, OverlayItem } from '../types';

const VIEW = { width: 393, height: 852 };
const SIZES = { card: { width: 240, height: 132 }, pill: { width: 120, height: 32 } };

function setup() {
  const clock = createFakeClock(0);
  const deps = createPreviewLiveDeps(VIEW, { timing: clock, startMs: 0 });
  const engine = createLiveScanEngine(deps);
  engine.start();
  return { clock, deps, engine };
}

const cardOf = (s: LiveSnapshot) => overlayItems(s, SIZES).find((i) => i.focused);
const named = (items: readonly OverlayItem[]) =>
  items.flatMap((i) => (i.kind === 'known' ? [i.name] : []));

describe('panDetections', () => {
  it('is a 12 s loop of a row of faces, with new tracking ids each pass', () => {
    expect(panDetections(2500, VIEW).map((d) => d.person)).toEqual([0, 1]);
    expect(panDetections(9500, VIEW).map((d) => d.person)).toEqual([3, 2]);
    expect(panDetections(11_990, VIEW)).toEqual([]);
    const first = panDetections(2500, VIEW).map((d) => d.trackingId);
    const second = panDetections(PREVIEW_LOOP_MS + 2500, VIEW).map((d) => d.trackingId);
    expect(second.some((id) => first.includes(id))).toBe(false);
  });

  it('keeps every face big enough to match', () => {
    for (let t = 0; t < PREVIEW_LOOP_MS; t += 500) {
      for (const d of panDetections(t, VIEW)) {
        expect(d.bounds.width / VIEW.width).toBeGreaterThan(0.13);
      }
    }
  });
});

describe('the preview runs the real engine end to end', () => {
  it('shows Jake at 2.5 s, Priya at 6.5 s, Sam at 9.5 s, and never names the stranger', async () => {
    const { clock, engine, deps } = setup();
    const seen: LiveSnapshot[] = [];
    engine.subscribe((s) => seen.push(s));

    await simulateTo(engine, clock, VIEW, 2500);
    expect(cardOf(engine.snapshot())).toMatchObject({
      kind: 'known',
      name: 'Jake',
      record: '4-7',
      net: '−$7.00',
      rival: true,
      streakLabel: null,
    });

    await simulateTo(engine, clock, VIEW, 6500);
    expect(cardOf(engine.snapshot())).toMatchObject({
      kind: 'known',
      name: 'Priya',
      record: '3-0',
      net: '+$9.00',
      rival: true,
      streakLabel: 'Won 3 straight',
    });

    await simulateTo(engine, clock, VIEW, 9500);
    const items = overlayItems(engine.snapshot(), SIZES);
    expect(cardOf(engine.snapshot())).toMatchObject({
      kind: 'known',
      name: 'Sam',
      record: '0-0',
      firstBet: true,
      rival: false,
    });
    // The stranger: a ring, never a name.
    expect(items.filter((i) => !i.focused).map((i) => i.kind)).toEqual(['unknown']);
    expect(seen.every((s) => !named(overlayItems(s, SIZES)).includes('Stranger'))).toBe(true);

    // The card's stats changed as the focus moved.
    const cards = seen
      .map((s) => cardOf(s))
      .flatMap((c) => (c?.kind === 'known' ? [c.name] : []))
      .filter((n, i, a) => a[i - 1] !== n);
    expect(cards).toEqual(['Jake', 'Priya', 'Sam']);

    // Every fake photo was "deleted".
    expect(deps.deleted.length).toBeGreaterThan(0);
  });

  it('is deterministic (the frozen preview frames)', async () => {
    const a = setup();
    const b = setup();
    await simulateTo(a.engine, a.clock, VIEW, 6500);
    await simulateTo(b.engine, b.clock, VIEW, 6500);
    expect(overlayItems(a.engine.snapshot(), SIZES)).toEqual(
      overlayItems(b.engine.snapshot(), SIZES),
    );
  });

  it('empties out at the end of the pass and matches again on the next', async () => {
    const { clock, engine } = setup();
    await simulateTo(engine, clock, VIEW, 11_990);
    expect(engine.snapshot().status).toBe('point');
    await simulateTo(engine, clock, VIEW, PREVIEW_LOOP_MS + 2500);
    expect(cardOf(engine.snapshot())).toMatchObject({ name: 'Jake' });
  });
});
