/**
 * §10.4 judge commit–reveal.
 */
import type { Hex32, JudgeCommitArgs, JudgeReveal, Pubkey } from '../types.js';
import { ascii, BorshWriter, bytesEqual, fromHex, sha256, toHex, utf8 } from '../chain/bytes.js';

/**
 * `commit_j = sha256("VERDICT/JUDGE-COMMIT/v1" ‖ bet[32] ‖ u8 j ‖ u8 outcome ‖ u16 confidence_bps
 *              ‖ sha256(utf8(rationale)) ‖ nonce[32])` → 32 bytes.
 */
export function judgeCommit(args: JudgeCommitArgs): Uint8Array {
  if (!Number.isInteger(args.judge) || args.judge < 0 || args.judge > 2) throw new Error('judge index must be 0..2');
  if (!Number.isInteger(args.outcome) || args.outcome < 0 || args.outcome > 2) throw new Error('outcome must be 0..2');
  if (!Number.isInteger(args.confidence_bps) || args.confidence_bps < 0 || args.confidence_bps > 10000) {
    throw new Error('confidence_bps must be 0..10000');
  }
  if (args.nonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const w = new BorshWriter(160)
    .raw(ascii('VERDICT/JUDGE-COMMIT/v1'))
    .pubkey(args.bet)
    .u8(args.judge)
    .u8(args.outcome)
    .u16(args.confidence_bps)
    .raw(sha256(utf8(args.rationale)))
    .raw(args.nonce);
  return sha256(w.toBytes());
}

/** Hex form of {@link judgeCommit} (as stored in the booth record). */
export function judgeCommitHex(args: JudgeCommitArgs): Hex32 {
  return toHex(judgeCommit(args));
}

/** True iff the reveal matches the recorded commit (§10.4: mismatching reveals are discarded). */
export function verifyReveal(bet: Pubkey, reveal: JudgeReveal, commit: Hex32 | Uint8Array): boolean {
  try {
    const c = judgeCommit({
      bet,
      judge: reveal.judge,
      outcome: reveal.outcome,
      confidence_bps: reveal.confidence_bps,
      rationale: reveal.rationale,
      nonce: fromHex(reveal.nonce.toLowerCase(), 32),
    });
    const expected = typeof commit === 'string' ? fromHex(commit.toLowerCase(), 32) : commit;
    return bytesEqual(c, expected);
  } catch {
    return false;
  }
}

/** Filters reveals down to those matching a commit of the same judge. */
export function matchReveals(
  bet: Pubkey,
  commits: readonly { judge: number; commit: Hex32 }[],
  reveals: readonly JudgeReveal[],
): JudgeReveal[] {
  return reveals.filter((r) => {
    const c = commits.find((x) => x.judge === r.judge);
    return c !== undefined && verifyReveal(bet, r, c.commit);
  });
}
