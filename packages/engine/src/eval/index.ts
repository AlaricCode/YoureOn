/**
 * Evaluation (§3): evaluate, evaluateProgram, evaluateSession, evalCost, leafSignals.
 * Consensus code: integer-only (§0.4), identical semantics to crates/verdict-rules.
 *
 * Only the §14 names are re-exported from the package root; internal helpers
 * (frame space, geometry, primitives, combinators, legs, identity, causes,
 * outcome, evaluateDecoded) are imported from their files by tests and by
 * other engine modules that need them.
 */
export { evaluate, evaluateProgram, evaluateSession } from './evaluate.js';
export { evalCost } from './code.js';
export { leafSignals } from './leafSignals.js';
