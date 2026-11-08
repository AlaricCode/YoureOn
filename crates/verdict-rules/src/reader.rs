//! Minimal bounds-checked little-endian reader. Every read failure maps to the caller's error.

#[derive(Clone, Copy)]
pub(crate) struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }
    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }
    pub fn is_empty(&self) -> bool {
        self.pos == self.buf.len()
    }
    pub fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.remaining() < n {
            return None;
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Some(s)
    }
    pub fn array32(&mut self) -> Option<&'a [u8; 32]> {
        self.bytes(32).map(|s| s.try_into().unwrap())
    }
    pub fn u8(&mut self) -> Option<u8> {
        self.bytes(1).map(|s| s[0])
    }
    pub fn i8(&mut self) -> Option<i8> {
        self.u8().map(|v| v as i8)
    }
    pub fn u16(&mut self) -> Option<u16> {
        self.bytes(2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }
    pub fn u32(&mut self) -> Option<u32> {
        self.bytes(4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    pub fn u64(&mut self) -> Option<u64> {
        self.bytes(8).map(|s| u64::from_le_bytes(s.try_into().unwrap()))
    }
}

#[inline]
pub(crate) fn le_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

#[inline]
pub(crate) fn le_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
