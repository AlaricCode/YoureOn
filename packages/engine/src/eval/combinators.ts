/**
 * Combinators (§3.6). All O(|F|): running last-true positions and run-length
 * counters, reset at segment starts.
 */
import type { FrameSpace } from './frames.js';

type Signal = Uint8Array;

export function sigAnd(x: Signal, y: Signal): Signal {
  const out = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! & y[i]!;
  return out;
}

export function sigOr(x: Signal, y: Signal): Signal {
  const out = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! | y[i]!;
  return out;
}

export function sigNot(x: Signal): Signal {
  const out = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i]! ^ 1;
  return out;
}

/** `then_within(D, X, Y)[g] = Y[g] && ∃ f ∈ [max(segstart(g), g-D), g] : X[f]`. */
export function thenWithin(fs: FrameSpace, d: number, x: Signal, y: Signal): Signal {
  const out = new Uint8Array(fs.n);
  let lastX = -1;
  for (let pos = 0; pos < fs.n; pos++) {
    if (pos === fs.segStart[pos]) lastX = -1;
    if (x[pos]) lastX = pos;
    if (y[pos] && lastX >= 0 && fs.abs[pos]! - fs.abs[lastX]! <= d) out[pos] = 1;
  }
  return out;
}

/** `for_duration(D, X)[g] = g-D+1 >= segstart(g) && ∀ f ∈ [g-D+1, g] : X[f]`. */
export function forDuration(fs: FrameSpace, d: number, x: Signal): Signal {
  const out = new Uint8Array(fs.n);
  let run = 0;
  for (let pos = 0; pos < fs.n; pos++) {
    if (pos === fs.segStart[pos]) run = 0;
    run = x[pos] ? run + 1 : 0;
    if (run >= d) out[pos] = 1;
  }
  return out;
}

/** `before(D, X)[g] = X[g] && g < D` (absolute frame). */
export function beforeSig(fs: FrameSpace, d: number, x: Signal): Signal {
  const out = new Uint8Array(fs.n);
  for (let pos = 0; pos < fs.n; pos++) if (x[pos] && fs.abs[pos]! < d) out[pos] = 1;
  return out;
}

/**
 * `rising(X)[f] = X[f] && (f == 0 || (prev(f) exists && !X[prev(f)]))`.
 * Absolute frame 0 rises; any other segment start never does.
 */
export function rising(fs: FrameSpace, x: Signal): Signal {
  const out = new Uint8Array(fs.n);
  for (let pos = 0; pos < fs.n; pos++) {
    if (!x[pos]) continue;
    if (fs.abs[pos] === 0) out[pos] = 1;
    else if (pos > fs.segStart[pos]! && !x[pos - 1]) out[pos] = 1;
  }
  return out;
}
