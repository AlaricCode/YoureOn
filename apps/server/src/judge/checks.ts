// Deterministic bottle-flip checks (planning README D10, MERGE-PLAN #4): the vision call returns
// two narrow yes/no observations next to its verdict, and this file compares them with the
// verdict by a fixed rule. If they disagree, the ruling is REDO. The rule never picks a winner;
// it can only refuse to accept one.
//
//   cap_tape_visible        the taped cap is visible at the TOP of the resting bottle (it landed
//                           base-down, not on its cap)
//   bottle_upright_at_rest  in the final frames the bottle stands on its base and does not move
//
// landed := cap_tape_visible && bottle_upright_at_rest
//   MET     and not landed  -> REDO (the model says it landed, the observations don't)
//   NOT_MET and landed      -> REDO (the observations say it landed, the model says it didn't)
//   UNCLEAR                 -> already REDO
// A null (unknown) observation counts as "not confirmed". The checks apply only to bottle-flip
// terms; any other bet is judged on the verdict alone.
import { z } from 'zod/v4';
import { VisionVerdict, type ClaimResult } from '@youre-on/shared/ruling';
import type { Terms } from '@youre-on/shared/terms';

export const BottleChecks = z.object({
  cap_tape_visible: z.boolean().nullable(),
  bottle_upright_at_rest: z.boolean().nullable(),
});
export type BottleChecks = z.infer<typeof BottleChecks>;

/**
 * The judge call's structured output: SCHEMAS VisionVerdict plus the deterministic checks, and
 * (for a throw the object tracker decides, ../ruling applyThrowOutcome) whether the frames show
 * a rule of the terms being broken. Optional: a stored or older verdict has neither field.
 */
export const JudgeVerdict = VisionVerdict.extend({
  checks: BottleChecks,
  rule_broken: z.boolean().optional(),
  rule_note: z.string().max(200).optional(),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** Do the bottle checks apply to these terms? */
export function isBottleFlip(terms: Pick<Terms, 'claim' | 'success_criteria'>): boolean {
  return /\bbottle\b/i.test([terms.claim, ...terms.success_criteria].join(' '));
}

export type CheckResult = { agree: true } | { agree: false; why: string };

export function compareChecks(
  claim: ClaimResult,
  checks: BottleChecks,
  applies: boolean,
): CheckResult {
  if (!applies || claim === 'UNCLEAR') return { agree: true };
  const landed = checks.cap_tape_visible === true && checks.bottle_upright_at_rest === true;
  if (claim === 'MET' && !landed) {
    const missing = [
      checks.bottle_upright_at_rest !== true ? 'upright at rest' : null,
      checks.cap_tape_visible !== true ? 'cap tape on top' : null,
    ].filter(Boolean);
    return {
      agree: false,
      why: `the call says it landed, but the checks miss ${missing.join(' and ')}`,
    };
  }
  if (claim === 'NOT_MET' && landed) {
    return {
      agree: false,
      why: 'the call says it missed, but the checks show it upright with the cap on top',
    };
  }
  return { agree: true };
}
