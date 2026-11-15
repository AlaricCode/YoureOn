//! Fixed-size bitset signals indexed by position in F (§3.13).

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Signal<const W: usize>(pub [u64; W]);

impl<const W: usize> Default for Signal<W> {
    fn default() -> Self {
        Self::zero()
    }
}

impl<const W: usize> Signal<W> {
    /// Capacity in positions.
    pub const CAPACITY: usize = W * 64;

    #[inline]
    pub const fn zero() -> Self {
        Signal([0u64; W])
    }
    #[inline]
    pub fn get(&self, pos: usize) -> bool {
        (self.0[pos >> 6] >> (pos & 63)) & 1 != 0
    }
    #[inline]
    pub fn set(&mut self, pos: usize) {
        self.0[pos >> 6] |= 1u64 << (pos & 63);
    }
    #[inline]
    pub fn clear(&mut self, pos: usize) {
        self.0[pos >> 6] &= !(1u64 << (pos & 63));
    }
    /// ORs `v` into position `pos` (branch-free).
    #[inline]
    pub fn put(&mut self, pos: usize, v: bool) {
        self.0[pos >> 6] |= (v as u64) << (pos & 63);
    }
    /// Sets positions `[lo, hi)`.
    pub fn set_range(&mut self, lo: usize, hi: usize) {
        let mut p = lo;
        while p < hi {
            let wi = p >> 6;
            let b = p & 63;
            let end = core::cmp::min(hi, (wi + 1) << 6);
            let len = end - p;
            let m = if len == 64 { u64::MAX } else { ((1u64 << len) - 1) << b };
            self.0[wi] |= m;
            p = end;
        }
    }
    pub fn and(mut self, o: &Self) -> Self {
        for (a, b) in self.0.iter_mut().zip(o.0.iter()) {
            *a &= *b;
        }
        self
    }
    pub fn or(mut self, o: &Self) -> Self {
        for (a, b) in self.0.iter_mut().zip(o.0.iter()) {
            *a |= *b;
        }
        self
    }
    /// `self ∧ o` over the first `nw` words only. Signals never have bits at positions ≥ |F|,
    /// so with `nw = ⌈|F|/64⌉` this equals [`Signal::and`] at a cost that scales with |F|.
    #[inline]
    pub fn and_words(mut self, o: &Self, nw: usize) -> Self {
        for (a, b) in self.0.iter_mut().zip(o.0.iter()).take(nw) {
            *a &= *b;
        }
        self
    }
    /// `self ∨ o` over the first `nw` words only (see [`Signal::and_words`]).
    #[inline]
    pub fn or_words(mut self, o: &Self, nw: usize) -> Self {
        for (a, b) in self.0.iter_mut().zip(o.0.iter()).take(nw) {
            *a |= *b;
        }
        self
    }
    /// Complement restricted to the first `n` positions.
    pub fn not(mut self, n: usize) -> Self {
        // Words at or past ⌈n/64⌉ are 0 in and out.
        for (i, w) in self.0.iter_mut().enumerate().take(n.div_ceil(64)) {
            let lo = i * 64;
            let valid = if n >= lo + 64 {
                u64::MAX
            } else if n <= lo {
                0
            } else {
                (1u64 << (n - lo)) - 1
            };
            *w = !*w & valid;
        }
        self
    }
    pub fn any(&self) -> bool {
        self.0.iter().any(|&w| w != 0)
    }
}
