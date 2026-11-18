import { describe, expect, it } from 'vitest';

import type { LiveMatch, LiveSnapshot, Track, TrackStatus } from '../types';
import { statsOf } from '../format';
import {
  associate,
  CARD_GAP,
  GUTTER,
  overlayItems,
  placeAbove,
  stillBoxToView,
  viewBoxToStill,
} from '../geometry';

const STILL = { width: 960, height: 1280 };
const VIEW = { width: 393, height: 852 };

const track = (key: string, x: number, y: number, w: number, status?: TrackStatus): Track => ({
  key,
  box: { x, y, width: w, height: w * 1.3 },
  yawAngle: 0,
  firstSeenMs: 0,
  lastSeenMs: 0,
  hits: 5,
  stableSinceMs: 0,
  status: status ?? { kind: 'pending' },
});

describe('stillBoxToView', () => {
  it('aspect-fills a 960x1280 still into a 393x852 view around the shared centre', () => {
    const s = 852 / 1280;
    const ox = (393 - 960 * s) / 2;
    expect(stillBoxToView({ x: 0, y: 0, width: 960, height: 1280 }, STILL, VIEW)).toEqual({
      x: ox,
      y: 0,
      width: 960 * s,
      height: 852,
    });
    // The centre maps to the centre.
    const c = stillBoxToView({ x: 430, y: 590, width: 100, height: 100 }, STILL, VIEW);
    expect(c.x + c.width / 2).toBeCloseTo(393 / 2);
    expect(c.y + c.height / 2).toBeCloseTo(852 / 2);
    // MIN_SCAN_FACE_SHARE (0.08 of the still) is about 0.13 of the view.
    expect(
      stillBoxToView({ x: 0, y: 0, width: 0.08 * 960, height: 1 }, STILL, VIEW).width / 393,
    ).toBeCloseTo(0.13, 2);
  });

  it('round-trips with viewBoxToStill', () => {
    for (const b of [
      { x: 10, y: 20, width: 100, height: 130 },
      { x: -40, y: 700, width: 60, height: 80 },
    ]) {
      const back = viewBoxToStill(stillBoxToView(b, STILL, VIEW), STILL, VIEW);
      expect(back.x).toBeCloseTo(b.x);
      expect(back.y).toBeCloseTo(b.y);
      expect(back.width).toBeCloseTo(b.width);
      expect(back.height).toBeCloseTo(b.height);
    }
  });
});

describe('associate', () => {
  /** A still face exactly where the track is, nudged by `dx` view points. */
  const faceAt = (t: Track, dx = 0, id = t.key) => ({
    id,
    bounds: viewBoxToStill({ ...t.box, x: t.box.x + dx }, STILL, VIEW),
  });

  it('pairs 1-3 faces with their tracks, whatever order the still lists them in', () => {
    const a = track('a', 40, 300, 90);
    const b = track('b', 150, 320, 90);
    const c = track('c', 260, 310, 90);
    expect(associate([faceAt(a, 5)], STILL, [a], VIEW).get('a')?.id).toBe('a');
    const two = associate([faceAt(b, -8), faceAt(a, 6)], STILL, [a, b], VIEW);
    expect([two.get('a')?.id, two.get('b')?.id]).toEqual(['a', 'b']);
    const three = associate([faceAt(c), faceAt(a), faceAt(b)], STILL, [b, c, a], VIEW);
    expect(['a', 'b', 'c'].map((k) => three.get(k)?.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves out a face too far from its track, and tracks with no face', () => {
    const a = track('a', 40, 300, 90);
    const b = track('b', 250, 300, 90);
    // a's face moved 0.7 x its width: not a's any more.
    const m = associate([faceAt(a, 63), faceAt(b)], STILL, [a, b], VIEW);
    expect(m.has('a')).toBe(false);
    expect(m.get('b')?.id).toBe('b');
    expect(associate([], STILL, [a], VIEW).size).toBe(0);
  });

  it('is mutual: one face is never given to two tracks', () => {
    const a = track('a', 100, 300, 90);
    const b = track('b', 160, 300, 90);
    const m = associate([faceAt(a, 25)], STILL, [a, b], VIEW);
    expect(m.size).toBe(1);
  });
});

describe('placement', () => {
  const card = { width: 220, height: 120 };

  it('centres the card on the box, CARD_GAP above it', () => {
    const p = placeAbove({ x: 150, y: 400, width: 100, height: 130 }, card, VIEW);
    expect(p).toEqual({ x: 90, y: 400 - CARD_GAP - 120, placement: 'above' });
  });

  it('flips below when there is no room above', () => {
    const p = placeAbove({ x: 150, y: 60, width: 100, height: 130 }, card, VIEW);
    expect(p).toEqual({ x: 90, y: 60 + 130 + CARD_GAP, placement: 'below' });
    // Respects the top inset too.
    const q = placeAbove({ x: 150, y: 200, width: 100, height: 130 }, card, VIEW, {
      top: 120,
      bottom: 0,
    });
    expect(q.placement).toBe('below');
  });

  it('clamps x to the gutter', () => {
    expect(placeAbove({ x: -30, y: 400, width: 100, height: 130 }, card, VIEW).x).toBe(GUTTER);
    expect(placeAbove({ x: 350, y: 400, width: 100, height: 130 }, card, VIEW).x).toBe(
      393 - GUTTER - 220,
    );
  });
});

const live = (name: string, h: Parameters<typeof statsOf>[0]): LiveMatch => ({
  user: { user_id: name, display_name: name },
  ticket: 't',
  expiresAtMs: 60_000,
  headToHead: { wins: h.wins, losses: h.losses, net: h.net },
  stats: statsOf(h),
  matchedAtMs: 0,
});

describe('overlayItems', () => {
  const sizes = { card: { width: 220, height: 120 }, pill: { width: 110, height: 32 } };
  const jake = live('Jake', {
    wins: 4,
    losses: 7,
    pushes: 0,
    net: '-7000000',
    net_display: '−$7.00',
    streak: { holder: 'them', length: 1 },
  });
  const priya = live('Priya', {
    wins: 3,
    losses: 0,
    net: '9000000',
    streak: { holder: 'me', length: 3 },
  });
  const sam = live('Sam', { wins: 0, losses: 0, net: '0' });

  const snap = (tracks: Track[], focusedKey: string | null): LiveSnapshot => ({
    tracks,
    focusedKey,
    status: 'live',
    view: VIEW,
  });

  it('gives the focused known face the card and others a pill', () => {
    const items = overlayItems(
      snap(
        [
          track('t1', 140, 400, 110, { kind: 'known', match: jake, refreshing: false }),
          track('t2', 10, 420, 90, { kind: 'known', match: priya, refreshing: true }),
        ],
        't1',
      ),
      sizes,
    );
    const card = items.find((i) => i.key === 't1');
    const pill = items.find((i) => i.key === 't2');
    expect(card).toMatchObject({
      kind: 'known',
      focused: true,
      name: 'Jake',
      record: '4-7',
      net: '−$7.00',
      streakLabel: null,
      rival: true,
      firstBet: false,
      hidden: false,
    });
    expect(pill).toMatchObject({
      kind: 'known',
      focused: false,
      name: 'Priya',
      record: '3-0',
      net: '+$9.00',
      streakLabel: 'Won 3 straight',
      rival: true,
      refreshing: true,
    });
  });

  it('hides a pill that would overlap the card', () => {
    const items = overlayItems(
      snap(
        [
          track('t2', 150, 410, 90, { kind: 'known', match: priya, refreshing: false }),
          track('t1', 140, 400, 110, { kind: 'known', match: jake, refreshing: false }),
        ],
        't1',
      ),
      sizes,
    );
    expect(items.find((i) => i.key === 't2')).toMatchObject({ hidden: true });
    expect(items[0]?.key).toBe('t1'); // the card is laid out first
  });

  it('marks a first bet, and draws rings (never names) for the rest', () => {
    const items = overlayItems(
      snap(
        [
          track('a', 140, 400, 110, { kind: 'known', match: sam, refreshing: false }),
          track('b', 20, 400, 90, { kind: 'unknown', attempts: 3, retryAtMs: null }),
          track('c', 300, 400, 90, { kind: 'checking' }),
          track('d', 300, 600, 20, { kind: 'pending' }),
          track('e', 20, 600, 90, { kind: 'too_far' }),
          track('f', 20, 700, 90, { kind: 'error', attempts: 3, retryAtMs: null }),
          track('g', 120, 700, 90, { kind: 'pending' }),
        ],
        'a',
      ),
      sizes,
    );
    expect(items.find((i) => i.key === 'a')).toMatchObject({ firstBet: true, record: '0-0' });
    const kinds = Object.fromEntries(items.map((i) => [i.key, i.kind]));
    expect(kinds).toEqual({
      a: 'known',
      b: 'unknown',
      c: 'checking',
      d: 'too_far',
      e: 'too_far',
      f: 'unknown',
      g: 'checking',
    });
    for (const i of items) if (i.kind !== 'known') expect(i).not.toHaveProperty('name');
  });
});
