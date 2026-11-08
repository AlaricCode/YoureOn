/**
 * Closed-set matching (§8.3) over enrolled templates, via the engine's
 * `quantizeEmbedding` + `closedSetMatch`. Candidates are always a closed set
 * chosen by the caller (huddle members, recent huddles, …), never everyone.
 */
import { closedSetMatch, quantizeEmbedding, type Modality } from '@verdict/engine';
import type { UserRecord } from '../persistence/records.js';
import type { BiometricVault } from './biometrics.js';

export interface Candidate {
  user: UserRecord;
  template: Int8Array;
}

export interface MatchOutcome {
  matched: boolean;
  /** best candidate's user (null if there were no candidates) */
  best: UserRecord | null;
  cos1: number;
  cos2: number;
  /** all candidates, in candidate order */
  scores: { user: UserRecord; cos_bps: number }[];
}

/** Enrolled candidates (in the given order) that have a template for `modality`. */
export function enrolledCandidates(vault: BiometricVault, users: UserRecord[], modality: Modality): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const u of users) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    const t = vault.template(u.id, modality);
    if (t) out.push({ user: u, template: t.q });
  }
  return out;
}

/** Matches one float observation against the closed set. */
export function matchObservation(observed: number[], candidates: Candidate[], modality: Modality): MatchOutcome {
  const o = quantizeEmbedding(observed);
  const r = closedSetMatch(
    o,
    candidates.map((c, i) => ({ candidate: i, template: c.template })),
    modality,
  );
  return {
    matched: r.matched,
    best: r.best === null ? null : candidates[r.best]!.user,
    cos1: r.cos1,
    cos2: r.cos2,
    scores: r.scores.map((s) => ({ user: candidates[s.candidate]!.user, cos_bps: s.cos_bps })),
  };
}

/** Element-wise mean of float embeddings (then L2-normalized by quantizeEmbedding). */
export function meanEmbedding(es: number[][]): number[] {
  const dim = es[0]?.length ?? 0;
  const out = new Array<number>(dim).fill(0);
  for (const e of es) for (let i = 0; i < dim; i++) out[i]! += e[i]!;
  return out.map((x) => x / Math.max(1, es.length));
}
