// Motion audit (tokens `motion`): reads the app's source and holds the two rules the gesture
// layer depends on.
// 1. One spring, and only to settle a released gesture: `withSpring(` appears in
//    ui/SwipeToConfirm.tsx alone, and every call there takes `motion.settle` (critically damped,
//    clamped; tokens.test pins the ratio).
// 2. Every reanimated `withTiming` / `withSpring` / `withDecay` passes `reduceMotion:`
//    explicitly. Reanimated's default (ReduceMotion.System) finishes an animation at once when
//    Reduce Motion is on, which would empty a countdown bar on mount; the components handle
//    Reduce Motion themselves (direct manipulation keeps following the finger) and pass Never.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Each `name(` call's argument text (balanced parentheses), with its 1-based line. */
function calls(src: string, name: string): { args: string; line: number }[] {
  const out: { args: string; line: number }[] = [];
  const re = new RegExp(`\\b${name}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push({
      args: src.slice(m.index + m[0].length, i - 1),
      line: src.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/** The call's own options: its arguments with any nested call's arguments blanked out. */
function ownArgs(args: string): string {
  let out = '';
  let depth = 0;
  for (const ch of args) {
    if (ch === '(') depth++;
    if (depth === 0) out += ch;
    if (ch === ')') depth--;
  }
  return out;
}

const files = sourceFiles(SRC).map((p) => ({
  path: relative(SRC, p),
  src: readFileSync(p, 'utf8'),
}));

describe('motion audit', () => {
  it('finds the animated components (sanity check of the scan)', () => {
    const animated = files.filter((f) => calls(f.src, 'withTiming').length > 0).map((f) => f.path);
    expect(animated).toEqual(
      expect.arrayContaining(['ui/SwipeToConfirm.tsx', 'ui/DrainBar.tsx', 'ui/press.tsx']),
    );
  });

  it('withSpring only settles the swipe, and only with motion.settle', () => {
    const springs = files.flatMap((f) =>
      calls(f.src, 'withSpring').map((c) => ({ path: f.path, ...c })),
    );
    expect(springs.length).toBeGreaterThan(0);
    for (const s of springs) {
      expect(s.path, `withSpring at ${s.path}:${s.line}`).toBe('ui/SwipeToConfirm.tsx');
      expect(ownArgs(s.args), `withSpring at ${s.path}:${s.line}`).toMatch(
        /\.\.\.motion\.settle\b/,
      );
    }
  });

  it('every withTiming / withSpring / withDecay passes reduceMotion explicitly', () => {
    const missing = files.flatMap((f) =>
      ['withTiming', 'withSpring', 'withDecay'].flatMap((name) =>
        calls(f.src, name)
          .filter((c) => !/\breduceMotion\s*:/.test(ownArgs(c.args)))
          .map((c) => `${f.path}:${c.line} ${name}`),
      ),
    );
    expect(missing).toEqual([]);
  });
});
