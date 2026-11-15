/**
 * Replay-booth protocol pieces (§10.2–§10.5, §9.7) that do not touch storage:
 *  - advocate brief validation (slots, citation regex, exhibit ids);
 *  - judge output validation;
 *  - commit–reveal seats (engine.judgeCommit / matchReveals);
 *  - the ruling (engine.panelQuorum) and the panel signatures +
 *    Ed25519 precompile data (engine.panelMessage / ed25519PanelIxData).
 */
import { randomBytes } from 'node:crypto';
import {
  ADVOCATE_CLAIM_MAX_CHARS,
  ADVOCATE_EXHIBIT_SLOTS,
  CITATION_RE,
  JUDGE_RATIONALE_MAX_CHARS,
  ed25519PanelIxData,
  judgeCommitHex,
  matchReveals,
  panelMessage,
  panelQuorum,
  type Exhibit,
  type JudgeCommitRecord,
  type JudgeReveal,
  type PanelOutcome,
  type PanelRuling,
} from '@verdict/engine';
import type { KeyPair } from '../crypto/keys.js';
import type { AdvocateBrief, JudgeVote } from '../providers/types.js';
import { toHex } from '../util/bytes.js';

/** Max citations kept per brief (extras are dropped). */
export const MAX_CITATIONS = 8;

/** §10.2: 3 slots, +1 if a participant on that side registered a camera witness. */
export function exhibitSlots(sideHasCamera: boolean): number {
  return ADVOCATE_EXHIBIT_SLOTS + (sideHasCamera ? 1 : 0);
}

/**
 * Validates an advocate brief: the side is forced, the claim truncated to
 * 600 chars, exhibits restricted to known ids (dedup, ≤ slots), citations
 * restricted to the regex and to witnesses that exist (dedup, ≤ 8).
 */
export function validateBrief(raw: unknown, side: 0 | 1, slots: number, exhibits: Exhibit[], witnessLabels: string[]): AdvocateBrief {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const claim = typeof r['claim'] === 'string' ? [...r['claim']].slice(0, ADVOCATE_CLAIM_MAX_CHARS).join('') : '';
  const ids = new Set(exhibits.map((e) => e.id));
  const ex: string[] = [];
  for (const x of Array.isArray(r['exhibits']) ? r['exhibits'] : []) {
    if (typeof x === 'string' && ids.has(x) && !ex.includes(x) && ex.length < slots) ex.push(x);
  }
  const cites: string[] = [];
  for (const x of Array.isArray(r['citations']) ? r['citations'] : []) {
    if (typeof x !== 'string' || !CITATION_RE.test(x) || cites.includes(x)) continue;
    if (!witnessLabels.includes(x.split('@')[0]!)) continue;
    if (cites.length < MAX_CITATIONS) cites.push(x);
  }
  return { side, claim, citations: cites, exhibits: ex };
}

/** Validates a judge output; null if unusable (the judge is then absent). */
export function validateVote(raw: unknown): JudgeVote | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const o = r['outcome'];
  const c = r['confidence_bps'];
  if (o !== 0 && o !== 1 && o !== 2) return null;
  if (!Number.isInteger(c) || (c as number) < 0 || (c as number) > 10000) return null;
  const rationale = typeof r['rationale'] === 'string' ? [...r['rationale']].slice(0, JUDGE_RATIONALE_MAX_CHARS).join('') : '';
  return { outcome: o, confidence_bps: c as number, rationale };
}

/**
 * One judge's sealed vote. The commit is published first; the reveal (with
 * its nonce) is only handed out by `reveal()` after all commits are recorded.
 */
export class JudgeSeat {
  readonly commit: string;
  private readonly nonce: Uint8Array;

  constructor(
    readonly bet: string,
    readonly judge: number,
    private readonly vote: JudgeVote,
    nonce: Uint8Array = new Uint8Array(randomBytes(32)),
  ) {
    this.nonce = nonce;
    this.commit = judgeCommitHex({
      bet,
      judge,
      outcome: vote.outcome,
      confidence_bps: vote.confidence_bps,
      rationale: vote.rationale,
      nonce,
    });
  }

  reveal(): JudgeReveal {
    return {
      judge: this.judge,
      outcome: this.vote.outcome,
      confidence_bps: this.vote.confidence_bps,
      rationale: this.vote.rationale,
      nonce: toHex(this.nonce),
    };
  }
}

/** Reveals that match their recorded commit (others are discarded, §10.4). */
export function acceptedReveals(bet: string, commits: JudgeCommitRecord[], reveals: JudgeReveal[]): JudgeReveal[] {
  return matchReveals(bet, commits, reveals);
}

export function rule(reveals: JudgeReveal[]): PanelRuling {
  return panelQuorum(reveals);
}

export interface PanelSignatureInput {
  programId: string;
  bet: string;
  outcome: PanelOutcome;
  evidenceRoot: string;
  programHash: string;
  /** `Bet.judges` (on-chain order) */
  betJudges: string[];
  /** keys the backend holds (JUDGE_KEY_0..2) */
  keys: KeyPair[];
  signers: [number, number];
}

/**
 * Signs `M` (§9.7) with the two signer judges and returns the 367-byte
 * Ed25519 instruction data. Throws if a signer's key is not held.
 */
export function panelIxData(i: PanelSignatureInput): { data: Uint8Array; message: Uint8Array; signerKeys: [string, string] } {
  const M = panelMessage(i.programId, i.bet, i.outcome, i.evidenceRoot, i.programHash);
  const kp = i.signers.map((j) => {
    const pk = i.betJudges[j];
    const k = i.keys.find((x) => x.publicKey === pk);
    if (!pk || !k) throw new Error(`judge ${j} key (${pk ?? 'none'}) is not held by this backend`);
    return k;
  });
  const [a, b] = kp as [KeyPair, KeyPair];
  return { data: ed25519PanelIxData(a.publicKeyBytes, a.sign(M), b.publicKeyBytes, b.sign(M), M), message: M, signerKeys: [a.publicKey, b.publicKey] };
}
