import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_MOMENT_MS, MAX_TRANSITION_MS } from '../../ui/tokens';
import {
  advancePhase,
  coreOpacity,
  dashOffset,
  displayCornerRadius,
  fmt,
  glowOpacity,
  hslToRgb,
  LOOP,
  loopGeometry,
  roundedRectPerimeter,
  segmentDashes,
  spectrumColor,
  spectrumColors,
} from '../spectrum';

// ---------------------------------------------------------------------------------------
// A tiny walker for the path commands loopGeometry emits (M, H, V, A, Z), absolute only.
// ---------------------------------------------------------------------------------------

type Walk = {
  commands: string[];
  length: number;
  start: [number, number];
  end: [number, number];
  points: [number, number][];
  /** Direction of each straight run, in order: +x, +y, -x, -y. */
  runs: string[];
};

function walk(d: string): Walk {
  const tokens = [...d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let length = 0;
  const commands: string[] = [];
  const points: [number, number][] = [];
  const runs: string[] = [];
  for (const t of tokens) {
    const cmd = t[1] as string;
    const nums = (t[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length > 0)
      .map(Number);
    for (const n of nums) expect(Number.isFinite(n), `${cmd} ${t[2]}`).toBe(true);
    commands.push(cmd);
    switch (cmd) {
      case 'M':
        expect(nums).toHaveLength(2);
        [x, y] = nums as [number, number];
        [sx, sy] = [x, y];
        break;
      case 'H': {
        expect(nums).toHaveLength(1);
        const nx = nums[0] as number;
        if (nx !== x) runs.push(nx > x ? '+x' : '-x');
        length += Math.abs(nx - x);
        x = nx;
        break;
      }
      case 'V': {
        expect(nums).toHaveLength(1);
        const ny = nums[0] as number;
        if (ny !== y) runs.push(ny > y ? '+y' : '-y');
        length += Math.abs(ny - y);
        y = ny;
        break;
      }
      case 'A': {
        expect(nums).toHaveLength(7);
        const [rx, ry, rot, large, sweep, nx, ny] = nums as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        expect(rx).toBe(ry);
        expect(rot).toBe(0);
        expect(large).toBe(0);
        expect(sweep).toBe(1); // clockwise on screen (y down)
        // A quarter circle: the chord is r * sqrt(2) and both legs are r.
        expect(Math.abs(nx - x)).toBeCloseTo(rx, 2);
        expect(Math.abs(ny - y)).toBeCloseTo(rx, 2);
        length += (Math.PI * rx) / 2;
        x = nx;
        y = ny;
        break;
      }
      case 'Z':
        expect(nums).toHaveLength(0);
        if (sx !== x) runs.push(sx > x ? '+x' : '-x');
        length += Math.hypot(sx - x, sy - y);
        x = sx;
        y = sy;
        break;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
    points.push([x, y]);
  }
  return { commands, length, start: [sx, sy], end: [x, y], points, runs };
}

const PHONE = { width: 393, height: 852 }; // iPhone 15 / 16
/** The shortest loop we expect (an iPhone SE): the overlap must stay a sliver of a segment. */
const L_MIN = 2 * (320 + 568);

describe('perimeter', () => {
  it('is four straight runs plus one full circle', () => {
    expect(roundedRectPerimeter(100, 100, 0)).toBe(400);
    expect(roundedRectPerimeter(100, 100, 50)).toBeCloseTo(2 * Math.PI * 50, 9);
    expect(roundedRectPerimeter(393, 852, 55)).toBeCloseTo(
      2 * (393 - 110) + 2 * (852 - 110) + 2 * Math.PI * 55,
      9,
    );
  });

  it('clamps the radius to fit (and to >= 0) and is 0 when degenerate', () => {
    expect(roundedRectPerimeter(100, 40, 500)).toBeCloseTo(roundedRectPerimeter(100, 40, 20), 9);
    expect(roundedRectPerimeter(100, 40, -5)).toBe(280);
    expect(roundedRectPerimeter(0, 40, 10)).toBe(0);
    expect(roundedRectPerimeter(100, Number.NaN, 10)).toBe(0);
  });
});

describe('loopGeometry', () => {
  it('draws a closed, clockwise rounded rect from the top centre whose length is the perimeter', () => {
    const g = loopGeometry(PHONE.width, PHONE.height, 55);
    expect(g.radius).toBe(55);
    const w = walk(g.d);
    expect(w.commands).toEqual(['M', 'H', 'A', 'V', 'A', 'H', 'A', 'V', 'A', 'Z']);
    expect(w.start).toEqual([Math.round(PHONE.width / 2), 0]);
    expect(w.end).toEqual(w.start);
    expect(w.runs).toEqual(['+x', '+y', '-x', '-y', '+x']);
    expect(w.length).toBeCloseTo(g.length, 2);
    expect(g.length).toBeCloseTo(roundedRectPerimeter(PHONE.width, PHONE.height, 55), 9);
    for (const [x, y] of w.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(PHONE.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(PHONE.height);
    }
  });

  it('an inset pulls every side in and shrinks the radius by as much (concentric corners)', () => {
    const g = loopGeometry(400, 800, 50, 4);
    expect(g.radius).toBe(46);
    expect(g.length).toBeCloseTo(roundedRectPerimeter(392, 792, 46), 9);
    const w = walk(g.d);
    expect(w.start).toEqual([200, 4]);
    for (const [x, y] of w.points) {
      expect(x).toBeGreaterThanOrEqual(4);
      expect(x).toBeLessThanOrEqual(396);
      expect(y).toBeGreaterThanOrEqual(4);
      expect(y).toBeLessThanOrEqual(796);
    }
    expect(w.length).toBeCloseTo(g.length, 2);
  });

  it('square corners draw no arcs', () => {
    const g = loopGeometry(375, 667, 0);
    const w = walk(g.d);
    expect(w.commands).toEqual(['M', 'H', 'V', 'H', 'V', 'Z']);
    expect(g.length).toBe(2 * (375 + 667));
    expect(w.length).toBeCloseTo(g.length, 6);
  });

  it('a radius too big for the box is clamped to half its short side', () => {
    const g = loopGeometry(100, 300, 999);
    expect(g.radius).toBe(50);
    expect(walk(g.d).length).toBeCloseTo(g.length, 2);
  });

  it('starts on a whole point, kept on the top run when the radius fills an odd width', () => {
    for (const width of [393, 430, 375, 402, 440]) {
      const [sx] = walk(loopGeometry(width, 852, 55).d).start;
      expect(Number.isInteger(sx)).toBe(true);
      expect(Math.abs(sx - width / 2)).toBeLessThanOrEqual(0.5);
    }
    const g = loopGeometry(101, 300, 999);
    expect(g.radius).toBe(50.5);
    const w = walk(g.d);
    expect(w.start).toEqual([50.5, 0]);
    expect(w.length).toBeCloseTo(g.length, 2);
  });

  it('a degenerate box draws nothing', () => {
    expect(loopGeometry(0, 800, 40)).toEqual({ d: '', length: 0, radius: 0 });
    expect(loopGeometry(10, 10, 4, 5)).toEqual({ d: '', length: 0, radius: 0 });
  });

  it('path numbers carry at most 3 decimals and never "-0"', () => {
    expect(fmt(1 / 3)).toBe('0.333');
    expect(fmt(-0)).toBe('0');
    expect(fmt(-0.0001)).toBe('0');
    expect(fmt(47.33)).toBe('47.33');
    const g = loopGeometry(390, 844, 47.33, 0.5);
    for (const n of g.d.match(/-?\d+(\.\d+)?/g) ?? []) {
      expect(n.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
      expect(n.startsWith('-')).toBe(false);
    }
  });
});

describe('segments', () => {
  const L = loopGeometry(PHONE.width, PHONE.height, 55).length;

  it('one dash per lap: every dash array sums to the perimeter', () => {
    for (const n of [1, 24, 36]) {
      const segs = segmentDashes(L, n);
      expect(segs).toHaveLength(n);
      for (const s of segs) {
        expect(s.dash[0] + s.dash[1]).toBeCloseTo(L, 9);
        expect(s.dash[0]).toBeGreaterThan(0);
        expect(s.dash[1]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('starts are evenly spaced from 0 and the dashes overlap into the next (no seam)', () => {
    const n = LOOP.coreSegments;
    const segs = segmentDashes(L, n);
    const seg = L / n;
    segs.forEach((s, i) => {
      expect(s.start).toBeCloseTo(i * seg, 9);
      expect(s.dash[0]).toBeCloseTo(seg + LOOP.overlap, 9);
      const next = i + 1 < n ? (segs[i + 1]?.start ?? 0) : L;
      expect(s.start + s.dash[0]).toBeGreaterThan(next);
    });
  });

  it('no overlap gives dashes that tile the loop exactly', () => {
    const segs = segmentDashes(L, 24, 0);
    for (const s of segs) expect(s.dash[0]).toBeCloseTo(L / 24, 9);
  });

  it('one segment is the whole loop; a zero-length loop has none', () => {
    expect(segmentDashes(100, 1)).toEqual([{ start: 0, dash: [100, 0] }]);
    expect(segmentDashes(0, 36)).toEqual([]);
    expect(segmentDashes(100, 0)).toHaveLength(1);
  });
});

describe('dashOffset', () => {
  const L = 2000;
  /** Where a dash with this offset shows up along the path. */
  const shownAt = (o: number) => (L - o) % L;

  it('stays in [0, L) and puts the dash at start + phase * L', () => {
    for (const start of [0, 100, 1999]) {
      for (const phase of [0, 0.1, 0.5, 0.999, 1, 2.25, -0.25]) {
        const o = dashOffset(start, phase, L);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThan(L);
        const want = (((start + phase * L) % L) + L) % L;
        expect(shownAt(o)).toBeCloseTo(want, 6);
      }
    }
  });

  it('one full turn is the same picture (the wrap is seamless)', () => {
    for (const start of [0, 333, 1500]) {
      expect(dashOffset(start, 1, L)).toBeCloseTo(dashOffset(start, 0, L), 6);
      expect(dashOffset(start, 0.3 + 1, L)).toBeCloseTo(dashOffset(start, 0.3, L), 6);
    }
  });

  it('a phase step moves every dash the same way (clockwise = forward along the path)', () => {
    const a = shownAt(dashOffset(100, 0, L));
    const b = shownAt(dashOffset(100, 0.01, L));
    expect(b - a).toBeCloseTo(20, 6);
  });

  it('is 0 for an empty loop', () => {
    expect(dashOffset(10, 0.5, 0)).toBe(0);
  });
});

describe('advancePhase', () => {
  const run = (ms: number, level: number, step = 16) => {
    let p = 0;
    for (let t = 0; t < ms; t += step) p = advancePhase(p, step, level);
    return p;
  };

  it('listening laps in listeningTurnMs, thinking in thinkingTurnMs', () => {
    expect(advancePhase(0, LOOP.listeningTurnMs / 4 / 40, 1) * 40).toBeCloseTo(0.25, 9);
    expect(run(LOOP.listeningTurnMs / 2, 1, 16)).toBeCloseTo(0.5, 2);
    expect(run(LOOP.thinkingTurnMs / 2, 0, 20)).toBeCloseTo(0.5, 2);
    expect(LOOP.listeningTurnMs).toBeLessThan(LOOP.thinkingTurnMs);
  });

  it('wraps into [0, 1)', () => {
    let p = 0.99;
    p = advancePhase(p, 40, 1);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
    expect(p).toBeCloseTo(0.99 + 40 / LOOP.listeningTurnMs - 1, 9);
  });

  it('a missing or negative frame adds nothing; a stall adds at most maxFrameMs', () => {
    expect(advancePhase(0.4, null, 1)).toBe(0.4);
    expect(advancePhase(0.4, -16, 1)).toBe(0.4);
    expect(advancePhase(0, 5000, 1)).toBeCloseTo(LOOP.maxFrameMs / LOOP.listeningTurnMs, 9);
  });

  it('the speed glides between the modes', () => {
    const fast = advancePhase(0, 16, 1);
    const mid = advancePhase(0, 16, 0.5);
    const slow = advancePhase(0, 16, 0);
    expect(fast).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(slow);
    expect(advancePhase(0, 16, 7)).toBe(fast);
    expect(advancePhase(0, 16, -3)).toBe(slow);
  });
});

describe('layer opacity', () => {
  it('the glow breathes inside its band; listening is brighter than thinking', () => {
    expect(glowOpacity(0, 1)).toBeCloseTo(LOOP.glowListening[0], 9);
    expect(glowOpacity(1, 1)).toBeCloseTo(LOOP.glowListening[1], 9);
    expect(glowOpacity(0, 0)).toBeCloseTo(LOOP.glowThinking[0], 9);
    expect(glowOpacity(1, 0)).toBeCloseTo(LOOP.glowThinking[1], 9);
    for (const b of [0, 0.5, 1]) expect(glowOpacity(b, 1)).toBeGreaterThan(glowOpacity(b, 0));
    for (const b of [-1, 0, 0.3, 1, 2]) {
      for (const l of [-1, 0, 0.5, 1, 2]) {
        const o = glowOpacity(b, l);
        expect(o).toBeGreaterThan(0);
        expect(o).toBeLessThanOrEqual(0.6);
      }
    }
  });

  it('the core is opaque listening, slightly dimmer thinking', () => {
    expect(coreOpacity(1)).toBe(1);
    expect(coreOpacity(0)).toBe(LOOP.coreThinking);
    expect(LOOP.coreThinking).toBeGreaterThanOrEqual(0.6);
    expect(LOOP.coreThinking).toBeLessThan(1);
  });
});

describe('colour', () => {
  const RGB = /^rgb\((\d{1,3}), (\d{1,3}), (\d{1,3})\)$/;
  const channels = (c: string) => {
    const m = RGB.exec(c);
    expect(m, c).not.toBeNull();
    return [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])] as [number, number, number];
  };
  const hueOf = ([r, g, b]: [number, number, number]) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const circular = (a: number, b: number) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };

  it('hsl -> rgb hits the primaries, white, black and grey', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
    expect(hslToRgb(60, 1, 0.5)).toEqual([255, 255, 0]);
    expect(hslToRgb(360, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(-120, 1, 0.5)).toEqual([0, 0, 255]);
    expect(hslToRgb(200, 0, 1)).toEqual([255, 255, 255]);
    expect(hslToRgb(200, 1, 0)).toEqual([0, 0, 0]);
    expect(hslToRgb(10, 0, 0.5)).toEqual([128, 128, 128]);
  });

  it('a turn of the loop is the same colour (the spectrum wraps)', () => {
    for (const t of [0, 0.2, 0.75]) {
      expect(spectrumColor(t + 1)).toBe(spectrumColor(t));
      expect(spectrumColor(t - 1)).toBe(spectrumColor(t));
    }
    expect(spectrumColor(0)).toBe(spectrumColor(1));
  });

  it('n colours are rgb() strings, distinct, the hue at each segment middle', () => {
    for (const n of [LOOP.glowSegments, LOOP.coreSegments]) {
      const cs = spectrumColors(n);
      expect(cs).toHaveLength(n);
      expect(new Set(cs).size).toBe(n);
      cs.forEach((c, i) => {
        expect(c).toMatch(RGB);
        for (const v of channels(c)) expect(v).toBeLessThanOrEqual(255);
        expect(c).toBe(spectrumColor((i + 0.5) / n));
      });
      // One more step past the last lands on the first: the wrap is just another neighbour.
      expect(spectrumColor((n + 0.5) / n)).toBe(cs[0]);
    }
  });

  it('neighbouring hues are evenly spaced all the way round, across the wrap too', () => {
    const n = LOOP.coreSegments;
    const hues = spectrumColors(n).map((c) => hueOf(channels(c)));
    for (let i = 0; i < n; i++) {
      const a = hues[i] as number;
      const b = hues[(i + 1) % n] as number;
      expect(circular(a, b)).toBeCloseTo(360 / n, -0.5); // within ~1.6 deg (8-bit rounding)
    }
    expect(hues[0]).toBeCloseTo(0.5 * (360 / n), -0.5);
  });

  it('options shift the wheel and set saturation / lightness', () => {
    expect(spectrumColor(0, { hueStart: 120, saturation: 1, lightness: 0.5 })).toBe(
      'rgb(0, 255, 0)',
    );
    expect(spectrumColor(0.5, { saturation: 0, lightness: 1 })).toBe('rgb(255, 255, 255)');
    expect(spectrumColors(0)).toHaveLength(1);
  });

  it('the loop source carries no hex colour literals (colours are computed, not scattered)', () => {
    for (const f of ['../spectrum.ts', '../RainbowLoop.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');
      expect(src, f).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    }
  });
});

describe('display corners', () => {
  it('knows the current iPhones, in either orientation', () => {
    expect(displayCornerRadius(393, 852)).toBe(55);
    expect(displayCornerRadius(852, 393)).toBe(55);
    expect(displayCornerRadius(390, 844)).toBe(47.33);
    expect(displayCornerRadius(402, 874)).toBe(62);
    expect(displayCornerRadius(392.7, 851.6)).toBe(55);
  });

  it('home-button phones are square; iPads small; anything else the default', () => {
    expect(displayCornerRadius(375, 667)).toBe(0);
    expect(displayCornerRadius(820, 1180)).toBe(18);
    expect(displayCornerRadius(400, 900)).toBe(LOOP.defaultCornerRadius);
    expect(LOOP.defaultCornerRadius).toBe(48);
  });
});

describe('motion budget', () => {
  it('fades sit inside the caps: in is one moment, out and mode changes one transition', () => {
    expect(LOOP.fadeInMs).toBeGreaterThan(0);
    expect(LOOP.fadeInMs).toBeLessThanOrEqual(MAX_MOMENT_MS);
    expect(LOOP.fadeOutMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
    expect(LOOP.modeMs).toBeLessThanOrEqual(MAX_TRANSITION_MS);
  });

  it('the layers keep their shape: core crisp, glow wider, halo widest and fainter', () => {
    expect(LOOP.coreWidth).toBeLessThan(LOOP.glowWidth);
    expect(LOOP.glowWidth).toBeLessThan(LOOP.haloWidth);
    expect(LOOP.haloOpacity).toBeLessThan(1);
    expect(LOOP.coreSegments).toBeGreaterThanOrEqual(24);
    expect(LOOP.coreSegments).toBeLessThanOrEqual(36);
    expect(LOOP.overlap).toBeGreaterThan(0);
    expect(LOOP.overlap).toBeLessThan(L_MIN / LOOP.coreSegments);
  });
});
