// Compiler input (design final.md §1 "Compilation"): the part of the agreed terms the
// compile_checks call reads. Field shapes are TermsV1's own (spread from its shape, never
// re-declared), so the compiler sees exactly what both parties confirm.
import { z } from 'zod/v4';
import { TermsV1, type Terms } from '../terms';
import type { CheckSpec, CompiledChecks } from './spec';

const T = TermsV1.shape;

export const CompileInput = z.strictObject({
  type: T.type,
  claim: T.claim,
  success_criteria: T.success_criteria,
  failure_criteria: T.failure_criteria,
  edge_cases: T.edge_cases,
  attempts: T.attempts,
});
export type CompileInput = z.infer<typeof CompileInput>;

/** The compiler's input from full terms (TermsV1 today; TermsV2 carries the same fields). */
export function fromTerms(
  terms: Pick<
    Terms,
    'type' | 'claim' | 'success_criteria' | 'failure_criteria' | 'edge_cases' | 'attempts'
  >,
): CompileInput {
  return {
    type: terms.type,
    claim: terms.claim,
    success_criteria: [...terms.success_criteria],
    failure_criteria: [...terms.failure_criteria],
    edge_cases: terms.edge_cases.map((e) => ({ ...e })),
    attempts: { ...terms.attempts },
  };
}

/** A CompiledChecks whose spec is already a canonical CheckSpec (few-shots, accepted results). */
export type CompiledChecksValid = Omit<CompiledChecks, 'spec'> &
  ({ decision: 'checks'; spec: CheckSpec } | { decision: 'judge_only'; spec: null });
