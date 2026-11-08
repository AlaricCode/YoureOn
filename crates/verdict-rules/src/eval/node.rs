//! Recursive expression evaluation over prefix code (§5.1) and combinators (§3.6).
//! Signals are returned by value; recursion depth ≤ MAX_EXPR_DEPTH (validated at decode).

use super::ctx::Ctx;
use crate::expr::*;
use crate::reader::{le_u16, le_u32};
use crate::signal::Signal;

impl<'p, 'a, const W: usize> Ctx<'p, 'a, W> {
    /// Evaluates a whole (already validated) leg expression.
    pub(crate) fn eval_expr(&self, code: &[u8]) -> Signal<W> {
        let mut pos = 0usize;
        self.eval_node(code, &mut pos)
    }

    fn eval_node(&self, code: &[u8], pos: &mut usize) -> Signal<W> {
        let op = code[*pos];
        *pos += 1;
        match op {
            OP_AND => {
                let l = self.eval_node(code, pos);
                let r = self.eval_node(code, pos);
                l.and(&r)
            }
            OP_OR => {
                let l = self.eval_node(code, pos);
                let r = self.eval_node(code, pos);
                l.or(&r)
            }
            OP_NOT => self.eval_node(code, pos).not(self.n),
            OP_THEN_WITHIN => {
                let d = le_u16(code, *pos) as u32;
                *pos += 2;
                let x = self.eval_node(code, pos);
                let y = self.eval_node(code, pos);
                self.then_within(d, &x, &y)
            }
            OP_FOR_DURATION => {
                let d = le_u16(code, *pos) as u32;
                *pos += 2;
                let x = self.eval_node(code, pos);
                self.for_duration(d, &x)
            }
            OP_BEFORE => {
                let d = le_u32(code, *pos);
                *pos += 4;
                let x = self.eval_node(code, pos);
                self.before(d, &x)
            }
            _ => {
                let a = code[*pos];
                let b = code[*pos + 1];
                let p = le_u32(code, *pos + 2) as i32;
                *pos += 6;
                self.leaf(op, a, b, p)
            }
        }
    }

    /// `then_within(D, X, Y)[g] = Y[g] ∧ ∃ f ∈ [max(segstart(g), g−D), g] : X[f]`.
    pub(crate) fn then_within(&self, d: u32, x: &Signal<W>, y: &Signal<W>) -> Signal<W> {
        let mut out = Signal::zero();
        for s in self.segs() {
            let mut last_x: Option<u32> = None;
            for i in 0..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                let g = s.frame_start + i as u32;
                if x.get(pos) {
                    last_x = Some(g);
                }
                if y.get(pos) {
                    if let Some(f) = last_x {
                        if g - f <= d {
                            out.set(pos);
                        }
                    }
                }
            }
        }
        out
    }

    /// `for_duration(D, X)[g] = g−D+1 ≥ segstart(g) ∧ ∀ f ∈ [g−D+1, g] : X[f]`.
    pub(crate) fn for_duration(&self, d: u32, x: &Signal<W>) -> Signal<W> {
        let mut out = Signal::zero();
        for s in self.segs() {
            let mut run: u32 = 0;
            for i in 0..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                run = if x.get(pos) { run + 1 } else { 0 };
                if run >= d {
                    out.set(pos);
                }
            }
        }
        out
    }

    /// `before(D, X)[g] = X[g] ∧ g < D` (absolute frame).
    pub(crate) fn before(&self, d: u32, x: &Signal<W>) -> Signal<W> {
        let mut out = Signal::zero();
        for s in self.segs() {
            for i in 0..s.n_frames as usize {
                let pos = s.pos_start as usize + i;
                if x.get(pos) && s.frame_start + (i as u32) < d {
                    out.set(pos);
                }
            }
        }
        out
    }
}
