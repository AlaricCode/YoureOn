/**
 * Event primitives (pulse signals, §3.5).
 */
import type { DecodedRef } from '../types.js';
import { DESCEND_LOOKBACK, DISAPPEAR_FRAMES, HAND_EXPAND_PCT, RELEASE_HOLD } from '../constants.js';
import { type EvalCtx, aheadPos, anchorOf, bDefined, bOperand, backPos, boxAt, containerArr, lastSeenArr, prevPos, present } from './frames.js';
import { center, expand, ptInPoly, ptInRect, side } from './geometry.js';
import { insideAt, overlapsAt, pointwise, type Signal } from './state.js';

export function sigEnters(ctx: EvalCtx, a: DecodedRef, b: DecodedRef): Signal {
  const ls = lastSeenArr(ctx, a.entity);
  return pointwise(ctx, (f) => {
    const p = ls[f]!;
    if (p < 0) return false;
    if (!bDefined(ctx, b, f) || !bDefined(ctx, b, p)) return false;
    return insideAt(ctx, a, b, f) && !insideAt(ctx, a, b, p);
  });
}

export function sigLeaves(ctx: EvalCtx, a: DecodedRef, b: DecodedRef): Signal {
  const ls = lastSeenArr(ctx, a.entity);
  return pointwise(ctx, (f) => {
    if (!present(ctx, a.entity, f)) return false;
    const p = ls[f]!;
    if (p < 0) return false;
    if (!bDefined(ctx, b, f) || !bDefined(ctx, b, p)) return false;
    return !insideAt(ctx, a, b, f) && insideAt(ctx, a, b, p);
  });
}

export function sigTouches(ctx: EvalCtx, a: DecodedRef, b: DecodedRef): Signal {
  const ls = lastSeenArr(ctx, a.entity);
  return pointwise(ctx, (f) => {
    const p = ls[f]!;
    if (p < 0) return false;
    if (!bDefined(ctx, b, p)) return false;
    return overlapsAt(ctx, a, b, f) && !overlapsAt(ctx, a, b, p);
  });
}

export function sigCrosses(ctx: EvalCtx, a: DecodedRef, bRef: DecodedRef): Signal {
  const ls = lastSeenArr(ctx, a.entity);
  return pointwise(ctx, (f) => {
    const bf = boxAt(ctx, a.entity, f);
    if (bf === null) return false;
    const p = ls[f]!;
    if (p < 0) return false;
    const bp = boxAt(ctx, a.entity, p)!;
    const l = bOperand(ctx, bRef, f);
    if (l === null || l.kind !== 'line') return false;
    const sp = side(l.a, l.b, anchorOf(ctx, a.entity, bp));
    const sf = side(l.a, l.b, anchorOf(ctx, a.entity, bf));
    return sp !== 0 && sf !== 0 && sp !== sf;
  });
}

/**
 * `released_by(a, b)`. `heldrun` is computed in one forward pass over
 * lastSeen chains, saturating at RELEASE_HOLD.
 */
export function sigReleasedBy(ctx: EvalCtx, a: DecodedRef, b: DecodedRef): Signal {
  const n = ctx.fs.n;
  const ls = lastSeenArr(ctx, a.entity);
  const held = new Uint8Array(n);
  for (let g = 0; g < n; g++) {
    const ab = boxAt(ctx, a.entity, g);
    const bb = boxAt(ctx, b.entity, g);
    if (ab !== null && bb !== null && ptInRect(center(ab), expand(bb, HAND_EXPAND_PCT))) held[g] = 1;
  }
  const heldrun = new Int32Array(n);
  for (let g = 0; g < n; g++) {
    if (!held[g]) continue;
    const p = ls[g]!;
    heldrun[g] = p >= 0 && held[p] ? Math.min(RELEASE_HOLD, 1 + heldrun[p]!) : 1;
  }
  return pointwise(ctx, (f) => {
    if (!present(ctx, a.entity, f) || held[f]) return false;
    const p = ls[f]!;
    return p >= 0 && held[p] === 1 && heldrun[p]! >= RELEASE_HOLD;
  });
}

/** `disappears_into(a, b)` with b an `.opening` sub-region or a zone. */
export function sigDisappearsInto(ctx: EvalCtx, a: DecodedRef, bRef: DecodedRef): Signal {
  const { fs } = ctx;
  const bEnt = ctx.entities[bRef.entity]!;
  const isZone = bEnt.kind === 4;
  const containers = isZone ? null : containerArr(ctx, bRef.entity);

  const raw = pointwise(ctx, (f) => {
    // (1) present and b defined
    const af = boxAt(ctx, a.entity, f);
    if (af === null) return false;
    const b = bOperand(ctx, bRef, f);
    if (b === null) return false;
    const cf = center(af);
    // (2) entry
    if (b.kind === 'rect') {
      if (!ptInRect(cf, b.box)) return false;
    } else if (b.kind === 'zone') {
      if (!ptInPoly(cf, b.v)) return false;
    } else {
      return false;
    }
    // (3) descending
    let descending = false;
    for (let k = 1; k <= DESCEND_LOOKBACK && !descending; k++) {
      const p = backPos(fs, f, k);
      if (p < 0) break;
      const ap = boxAt(ctx, a.entity, p);
      if (ap !== null && cf.y > center(ap).y) descending = true;
    }
    if (!descending) return false;
    // (4) look-ahead fits
    if (aheadPos(fs, f, DISAPPEAR_FRAMES) < 0) return false;
    // (5) stays unseen-or-inside, (6) unseen at least once
    let absent = false;
    for (let k = 1; k <= DISAPPEAR_FRAMES; k++) {
      const g = f + k;
      const ag = boxAt(ctx, a.entity, g);
      if (ag === null) {
        absent = true;
        continue;
      }
      const cg = center(ag);
      if (isZone) {
        if (b.kind !== 'zone' || !ptInPoly(cg, b.v)) return false;
      } else {
        const cont = containers![g] ?? null;
        if (cont === null || !ptInRect(cg, cont)) return false;
      }
    }
    return absent;
  });

  const out = new Uint8Array(fs.n);
  for (let f = 0; f < fs.n; f++) {
    if (!raw[f]) continue;
    const p = prevPos(fs, f);
    if (!(p >= 0 && raw[p])) out[f] = 1;
  }
  return out;
}
