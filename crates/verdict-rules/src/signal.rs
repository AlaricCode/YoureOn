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
    pub fn put(&mut self, pos: usize, v: bool) {
        if v {
            self.set(pos);
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
    /// Complement restricted to the first `n` positions.
    pub fn not(mut self, n: usize) -> Self {
        for (i, w) in self.0.iter_mut().enumerate() {
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
