//! Geometry helpers (§3.3). All arithmetic is i64 on values ≤ 10^4, products ≤ 2·10^8.

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

#[inline]
pub fn center(b: Rect) -> Pt {
    ((b.0 + b.2) / 2, (b.1 + b.3) / 2)
}

/// Bottom-center (feet) anchor for persons.
#[inline]
pub fn feet(b: Rect) -> Pt {
    ((b.0 + b.2) / 2, b.3)
}

/// `side(L, P)` ∈ {-1, 0, 1}.
#[inline]
pub fn side(a: Pt, b: Pt, p: Pt) -> i64 {
    let v = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
    v.signum()
}

/// Even-odd point in polygon, exact (§3.3).
pub fn pt_in_poly<T: Copy + Into<i64>>(p: Pt, v: &[(T, T)]) -> bool {
    let n = v.len();
    let mut inside = false;
    let at = |k: usize| -> Pt { (v[k].0.into(), v[k].1.into()) };
    for i in 0..n {
        let j = (i + n - 1) % n;
        let (vi, vj) = (at(i), at(j));
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
pub fn expand(b: Rect, pct: i64) -> Rect {
    let ex = (b.2 - b.0) * pct / 100;
    let ey = (b.3 - b.1) * pct / 100;
    let c = |v: i64| v.clamp(0, 10000);
    (c(b.0 - ex), c(b.1 - ey), c(b.2 + ex), c(b.3 + ey))
}

/// `.opening` band (§2.3).
pub fn opening(b: Rect) -> Rect {
    let w = b.2 - b.0;
    let h = b.3 - b.1;
    (b.0 + w / 10, (b.1 - h / 10).max(0), b.2 - w / 10, b.1 + h / 5)
}

/// `.interior` rect (§2.3).
pub fn interior(b: Rect) -> Rect {
    let w = b.2 - b.0;
    let h = b.3 - b.1;
    (b.0 + w / 10, b.1 + h / 10, b.2 - w / 10, b.3 - h / 10)
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
