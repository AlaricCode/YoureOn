//! Geometry helpers (§3.3). All arithmetic is i64 on values ≤ 10^4, products ≤ 2·10^8.
//!
//! Every rect/point coordinate is in `[0, COORD_MAX]` (decoder-validated records and regions,
//! sub-regions clamped at 0), so halving uses `>> 1` and the percentage/tenth divisions go
//! through `udiv` of non-negative values: both equal the contract's floor division here and
//! avoid the signed-division sequences on SBF.

pub type Rect = (i64, i64, i64, i64);
pub type Pt = (i64, i64);

/// `isqrt(n) = floor(sqrt(n))`, integer Newton's method (§0.4).
pub fn isqrt(n: u64) -> u64 {
    if n < 2 {
        return n;
    }
    // Initial guess ≥ sqrt(n): 2^ceil(bits/2).
    let bits = 64 - n.leading_zeros();
    let mut x: u64 = 1u64 << bits.div_ceil(2);
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

#[inline]
pub fn area(b: Rect) -> i64 {
    (b.2 - b.0) * (b.3 - b.1)
}

/// `inter(A,B)`; `None` if empty (`ix0 >= ix1 || iy0 >= iy1`).
#[inline]
pub fn inter(a: Rect, b: Rect) -> Option<Rect> {
    let r = (a.0.max(b.0), a.1.max(b.1), a.2.min(b.2), a.3.min(b.3));
    if r.0 >= r.2 || r.1 >= r.3 {
        None
    } else {
        Some(r)
    }
}

#[inline]
pub fn pt_in_rect(p: Pt, r: Rect) -> bool {
    r.0 <= p.0 && p.0 <= r.2 && r.1 <= p.1 && p.1 <= r.3
}

#[inline(always)]
pub fn center(b: Rect) -> Pt {
    debug_assert!(b.0 >= 0 && b.1 >= 0 && b.2 >= 0 && b.3 >= 0);
    ((b.0 + b.2) >> 1, (b.1 + b.3) >> 1)
}

/// Bottom-center (feet) anchor for persons.
#[inline(always)]
pub fn feet(b: Rect) -> Pt {
    debug_assert!(b.0 >= 0 && b.2 >= 0);
    ((b.0 + b.2) >> 1, b.3)
}

/// `v / d` for `v ≥ 0`, `d > 0` (floor), as an unsigned division.
#[inline(always)]
fn udiv(v: i64, d: u64) -> i64 {
    debug_assert!(v >= 0);
    (v as u64 / d) as i64
}

/// `side(L, P)` ∈ {-1, 0, 1}.
#[inline]
pub fn side(a: Pt, b: Pt, p: Pt) -> i64 {
    let v = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
    v.signum()
}

/// One polygon edge, pre-normalized for [`Poly::contains`].
#[derive(Clone, Copy, Default)]
struct Edge {
    xi: i64,
    yi: i64,
    /// `(vj − vi)` multiplied by `sign(vj.y − vi.y)`, so `dy ≥ 0`.
    dx: i64,
    dy: i64,
    ylo: i64,
    yhi: i64,
}

/// Maximum polygon size (`MAX_ZONE_POINTS`).
const POLY_MAX: usize = 8;

/// A zone polygon prepared once per leaf for the per-frame even-odd test: identical results
/// to [`pt_in_poly`] (§3.3) with a bbox reject and no per-frame sign/branch on the edge slope.
#[derive(Clone, Copy)]
pub struct Poly {
    n: usize,
    edges: [Edge; POLY_MAX],
    /// `polyBBox`.
    pub bb: Rect,
}

impl Poly {
    /// `v.len()` must be in `1..=8` (decoder-validated zones have 3..=8 points).
    pub fn new<T: Copy + Into<i64>>(v: &[(T, T)]) -> Poly {
        let n = v.len().min(POLY_MAX);
        let at = |k: usize| -> Pt { (v[k].0.into(), v[k].1.into()) };
        let mut edges = [Edge::default(); POLY_MAX];
        let mut bb = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
        let mut prev = if n > 0 { at(n - 1) } else { (0, 0) };
        for (i, ed) in edges.iter_mut().enumerate().take(n) {
            let (vi, vj) = (at(i), prev);
            prev = vi;
            let (mut dx, mut dy) = (vj.0 - vi.0, vj.1 - vi.1);
            if dy < 0 {
                dx = -dx;
                dy = -dy;
            }
            *ed = Edge { xi: vi.0, yi: vi.1, dx, dy, ylo: vi.1.min(vj.1), yhi: vi.1.max(vj.1) };
            bb = (bb.0.min(vi.0), bb.1.min(vi.1), bb.2.max(vi.0), bb.3.max(vi.1));
        }
        Poly { n, edges, bb }
    }

    /// `pt_in_poly(p, v)`. An edge `(vj, vi)` is crossed iff exactly one end is above `p.y`,
    /// i.e. `min(yi, yj) ≤ p.y < max(yi, yj)` (so `dy > 0`); it flips iff
    /// `(p.x − xi)·dy' < (p.y − yi)·dx'` with both deltas multiplied by `sign(dy)`, the same
    /// inequality as `pt_in_poly`'s two-sided comparison. Bbox reject: a point left of, right
    /// of, below (y ≥ max y) or above (y < min y) the bbox crosses an even number of edges to
    /// its right (or none), so `pt_in_poly` is false there too.
    #[inline(always)]
    pub fn contains(&self, p: Pt) -> bool {
        let bb = self.bb;
        if p.0 < bb.0 || p.0 > bb.2 || p.1 < bb.1 || p.1 >= bb.3 {
            return false;
        }
        let mut inside = false;
        for e in &self.edges[..self.n] {
            if e.ylo <= p.1 && p.1 < e.yhi && (p.0 - e.xi) * e.dy < (p.1 - e.yi) * e.dx {
                inside = !inside;
            }
        }
        inside
    }
}

/// Even-odd point in polygon, exact (§3.3).
#[inline(always)]
pub fn pt_in_poly<T: Copy + Into<i64>>(p: Pt, v: &[(T, T)]) -> bool {
    let n = v.len();
    if n == 0 {
        return false;
    }
    let mut inside = false;
    let at = |k: usize| -> Pt { (v[k].0.into(), v[k].1.into()) };
    // Edge (v[j], v[i]) with j = i − 1 (mod n).
    let mut prev = at(n - 1);
    for i in 0..n {
        let vi = at(i);
        let vj = prev;
        prev = vi;
        if (vi.1 > p.1) != (vj.1 > p.1) {
            let lhs = (p.0 - vi.0) * (vj.1 - vi.1);
            let rhs = (p.1 - vi.1) * (vj.0 - vi.0);
            let flip = if vj.1 - vi.1 > 0 { lhs < rhs } else { lhs > rhs };
            if flip {
                inside = !inside;
            }
        }
    }
    inside
}

/// `expand(B, pct)`, clamped to [0, 10000].
#[inline(always)]
pub fn expand(b: Rect, pct: i64) -> Rect {
    let ex = udiv((b.2 - b.0) * pct, 100);
    let ey = udiv((b.3 - b.1) * pct, 100);
    let c = |v: i64| v.clamp(0, 10000);
    (c(b.0 - ex), c(b.1 - ey), c(b.2 + ex), c(b.3 + ey))
}

/// `.opening` band (§2.3).
#[inline(always)]
pub fn opening(b: Rect) -> Rect {
    let w = b.2 - b.0;
    let h = b.3 - b.1;
    let (w10, h10) = (udiv(w, 10), udiv(h, 10));
    (b.0 + w10, (b.1 - h10).max(0), b.2 - w10, b.1 + udiv(h, 5))
}

/// `.interior` rect (§2.3).
#[inline(always)]
pub fn interior(b: Rect) -> Rect {
    let w = b.2 - b.0;
    let h = b.3 - b.1;
    let (w10, h10) = (udiv(w, 10), udiv(h, 10));
    (b.0 + w10, b.1 + h10, b.2 - w10, b.3 - h10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_exact() {
        for n in 0u64..20000 {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "n={n}");
        }
        for &n in &[u64::MAX, u64::MAX - 1, 1u64 << 63, 0xFFFF_FFFE_0000_0001, 0xFFFF_FFFE_0000_0000, 200_000_000] {
            let r = isqrt(n) as u128;
            assert!(r * r <= n as u128 && (r + 1) * (r + 1) > n as u128, "n={n}");
        }
    }

    #[test]
    fn poly_edges_and_vertices() {
        let sq: [(i64, i64); 4] = [(0, 0), (10, 0), (10, 10), (0, 10)];
        assert!(pt_in_poly((5, 5), &sq));
        assert!(!pt_in_poly((15, 5), &sq));
        // Even-odd with half-open rule: left/top edges in, right/bottom out.
        assert!(pt_in_poly((0, 5), &sq));
        assert!(!pt_in_poly((10, 5), &sq));
        assert!(pt_in_poly((0, 0), &sq));
        assert!(!pt_in_poly((10, 10), &sq));
    }

    #[test]
    fn poly_matches_pt_in_poly() {
        let polys: [&[(u16, u16)]; 4] = [
            &[(0, 0), (10, 0), (10, 10), (0, 10)],
            &[(1000, 3000), (2500, 7000), (3500, 3000), (4500, 7000), (5500, 3000), (6500, 7000), (7500, 3000), (9000, 7000)],
            &[(5, 0), (10, 5), (5, 10), (0, 5)],
            &[(0, 0), (20, 0), (20, 20), (10, 5), (0, 20), (3, 7), (8, 9), (1, 1)],
        ];
        for v in polys {
            let poly = Poly::new(v);
            let (mx, my) = v.iter().fold((0i64, 0i64), |a, &(x, y)| (a.0.max(x as i64), a.1.max(y as i64)));
            let step = (mx.max(my) / 60).max(1);
            let mut y = -step;
            while y <= my + step {
                let mut x = -step;
                while x <= mx + step {
                    assert_eq!(poly.contains((x, y)), pt_in_poly((x, y), v), "{v:?} at ({x}, {y})");
                    x += step;
                }
                y += step;
            }
            for &(x, y) in v {
                let p = (x as i64, y as i64);
                assert_eq!(poly.contains(p), pt_in_poly(p, v));
            }
        }
    }

    #[test]
    fn side_sign() {
        // §15.1 example: side(L, (1000, 9000)) = +1.
        assert_eq!(side((3000, 6000), (3000, 10000), (1000, 9000)), 1);
        assert_eq!(side((3000, 6000), (3000, 10000), (3000, 9000)), 0);
        assert_eq!(side((3000, 6000), (3000, 10000), (5000, 9000)), -1);
    }

    #[test]
    fn subregions() {
        assert_eq!(opening((100, 50, 200, 250)), (110, 30, 190, 90));
        assert_eq!(opening((100, 10, 200, 210)), (110, 0, 190, 50));
        assert_eq!(interior((100, 50, 200, 250)), (110, 70, 190, 230));
        assert_eq!(expand((100, 100, 200, 300), 10), (90, 80, 210, 320));
        assert_eq!(expand((0, 0, 10000, 10000), 10), (0, 0, 10000, 10000));
    }
}
