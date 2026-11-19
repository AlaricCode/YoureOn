// The live name tags' geometry and smoothing (model/nameTags, DANCE-OFF §6.3), and the popups
// following the player's side (model/overlay popupAnchor).
import { describe, expect, it } from 'vitest';

import {
  createTagSmoother,
  emptyTag,
  NAME_TAG,
  placeTag,
  separateTags,
  stepTag,
  tagAnchor,
  tagLabel,
  tagWidth,
  type TagState,
} from '../model/nameTags';
import { aRightOfB, containRect, headCircle, popupAnchor } from '../model/overlay';
import { leftDancer, rightStill, WAVE_POP } from './helpers';

const PANEL = { width: 360, height: 640 };
const RECT = containRect(PANEL, { width: 720, height: 1280 });
const L = leftDancer(WAVE_POP, 0);
const R = rightStill(WAVE_POP);

describe('tag geometry', () => {
  it('pins the pill just above the head, inside the panel', () => {
    const a = tagAnchor(L, RECT)!;
    const head = headCircle(L, RECT)!;
    expect(a.x).toBeCloseTo(head.x, 6);
    expect(a.y).toBeCloseTo(head.y - head.r - NAME_TAG.HEAD_GAP, 6);
    const w = tagWidth('Logan · 87', true);
    const at = placeTag(a, w, PANEL);
    expect(at.x).toBeCloseTo(a.x - w / 2, 6);
    expect(at.y).toBeCloseTo(a.y - NAME_TAG.HEIGHT, 6);
    expect(tagAnchor(new Array(57).fill(0), RECT)).toBeNull();
  });

  it('clamps to the panel at every edge', () => {
    const w = 100;
    expect(placeTag({ x: 2, y: 3 }, w, PANEL)).toEqual({ x: NAME_TAG.MARGIN, y: NAME_TAG.MARGIN });
    expect(placeTag({ x: 359, y: 900 }, w, PANEL)).toEqual({
      x: PANEL.width - w - NAME_TAG.MARGIN,
      y: PANEL.height - NAME_TAG.HEIGHT - NAME_TAG.MARGIN,
    });
  });

  it('labels: the first name, then "· score" while the round scores; the icon widens it', () => {
    expect(tagLabel('Logan', null)).toBe('Logan');
    expect(tagLabel('Logan', 86.6)).toBe('Logan · 87');
    expect(tagLabel('Jake', 140)).toBe('Jake · 100');
    expect(tagWidth('Logan', true) - tagWidth('Logan', false)).toBe(NAME_TAG.ICON_W);
  });

  it('pushes two overlapping tags apart, each keeping its side', () => {
    const a = { at: { x: 100, y: 50 }, width: 80 };
    const b = { at: { x: 140, y: 52 }, width: 80 };
    const s = separateTags(a, b, PANEL);
    expect(s.a.x + 80 + NAME_TAG.MARGIN).toBeLessThanOrEqual(s.b.x + 1e-9);
    expect(s.a.x).toBeLessThan(100);
    expect(s.b.x).toBeGreaterThan(140);
    // not overlapping (apart, or on different rows): unchanged
    expect(separateTags(a, { ...b, at: { x: 200, y: 52 } }, PANEL)).toEqual({
      a: a.at,
      b: { x: 200, y: 52 },
    });
    expect(separateTags(a, { ...b, at: { x: 140, y: 120 } }, PANEL).a).toEqual(a.at);
  });
});

describe('stepTag smoothing and fading', () => {
  it('follows the head with a short EMA and fades in', () => {
    let s = stepTag(emptyTag(), { x: 100, y: 100 }, 0, 0, PANEL);
    expect(s.pos).toEqual({ x: 100, y: 100 });
    s = stepTag(s, { x: 110, y: 100 }, 66, 66, PANEL);
    expect(s.pos!.x).toBeCloseTo(100 + NAME_TAG.EMA_ALPHA * 10, 6);
    expect(s.opacity).toBeCloseTo(66 / NAME_TAG.FADE_MS, 6);
    for (let t = 132; t <= 600; t += 66) s = stepTag(s, { x: 110, y: 100 }, t, 66, PANEL);
    expect(s.opacity).toBe(1);
    expect(s.pos!.x).toBeCloseTo(110, 1);
  });

  it('holds through a dropped frame, then fades out in place; fades back in where re-found', () => {
    let s: TagState = { pos: { x: 100, y: 100 }, opacity: 1, seen: true, lastSeenAt: 0 };
    s = stepTag(s, null, 66, 66, PANEL);
    expect(s.opacity).toBe(1); // within LOST_HOLD_MS
    for (let t = 132; t <= 600; t += 66) s = stepTag(s, null, t, 66, PANEL);
    expect(s.opacity).toBe(0);
    expect(s.pos).toEqual({ x: 100, y: 100 });
    // re-found elsewhere: it reappears there (no slide from the old spot), from transparent
    s = stepTag(s, { x: 250, y: 120 }, 666, 66, PANEL);
    expect(s.pos).toEqual({ x: 250, y: 120 });
    expect(s.opacity).toBeLessThan(0.5);
  });

  it('a big jump while visible blinks to the new spot instead of sliding across', () => {
    const s0 = { pos: { x: 80, y: 100 }, opacity: 1, seen: true, lastSeenAt: 0 };
    const far = { x: 80 + NAME_TAG.JUMP_SHARE * PANEL.width + 10, y: 100 };
    const s = stepTag(s0, far, 66, 66, PANEL);
    expect(s.pos).toEqual(far);
    expect(s.opacity).toBeLessThan(1);
    const near = stepTag(s0, { x: 90, y: 100 }, 66, 66, PANEL);
    expect(near.pos!.x).toBeLessThan(90);
    expect(near.opacity).toBe(1);
  });

  it('a stalled clock is not a long fade step', () => {
    const s = stepTag(
      { ...emptyTag(), pos: { x: 1, y: 1 }, opacity: 0.1, lastSeenAt: 0 },
      { x: 1, y: 1 },
      10_000,
      10_000,
      PANEL,
    );
    expect(s.opacity).toBeCloseTo(0.1 + NAME_TAG.MAX_STEP_MS / NAME_TAG.FADE_MS, 6);
  });
});

describe('createTagSmoother', () => {
  const inputs = (a: number[] | null, b: number[] | null) => ({
    A: { k: a, label: 'Logan · 87', icon: true },
    B: { k: b, label: 'Jake · 64', icon: false },
  });

  it('places both tags over their own players, A on the right when A stands there', () => {
    const sm = createTagSmoother();
    let out = sm.step(1, 0, RECT, PANEL, inputs(R, L));
    for (let v = 2, t = 66; v < 10; v++, t += 66) out = sm.step(v, t, RECT, PANEL, inputs(R, L));
    expect(out.A!.x).toBeGreaterThan(out.B!.x);
    expect(out.A!.opacity).toBe(1);
    expect(out.A!.icon).toBe(true);
    expect(out.A!.width).toBe(tagWidth('Logan · 87', true));
    for (const t of [out.A!, out.B!]) {
      expect(t.x).toBeGreaterThanOrEqual(NAME_TAG.MARGIN);
      expect(t.x + t.width).toBeLessThanOrEqual(PANEL.width - NAME_TAG.MARGIN);
    }
  });

  it('is idempotent per store version (a re-render never advances it), and resets', () => {
    const sm = createTagSmoother();
    sm.step(1, 0, RECT, PANEL, inputs(L, R));
    const a = sm.step(2, 66, RECT, PANEL, inputs(L, R));
    const again = sm.step(2, 132, RECT, PANEL, inputs(L, R));
    expect(again).toBe(a);
    sm.reset();
    expect(sm.step(3, 200, RECT, PANEL, inputs(L, R)).A).toBeNull(); // fading in from 0
  });

  it('a lost player’s tag fades out; the other one stays', () => {
    const sm = createTagSmoother();
    let out = sm.step(1, 0, RECT, PANEL, inputs(L, R));
    let v = 2;
    let t = 66;
    for (; v < 8; v++, t += 66) out = sm.step(v, t, RECT, PANEL, inputs(L, R));
    for (; v < 20; v++, t += 66) out = sm.step(v, t, RECT, PANEL, inputs(L, null));
    expect(out.B).toBeNull();
    expect(out.A!.opacity).toBe(1);
  });
});

describe('popups follow the player’s side', () => {
  it('A over the left half, unless A stands right of B', () => {
    expect(popupAnchor(PANEL, 'A').x).toBe(90);
    expect(popupAnchor(PANEL, 'B').x).toBe(270);
    expect(popupAnchor(PANEL, 'A', true).x).toBe(270);
    expect(popupAnchor(PANEL, 'B', true).x).toBe(90);
    expect(aRightOfB(L, R)).toBe(false);
    expect(aRightOfB(R, L)).toBe(true);
    expect(aRightOfB(R, null)).toBeNull();
  });
});
