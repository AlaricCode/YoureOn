/**
 * §9.7 panel message and §10.5 quorum.
 */
import { PANEL_CONF_FLOOR_BPS, PANEL_MESSAGE_BYTES } from '../constants.js';
import type { Hex32, JudgeReveal, PanelOutcome, PanelRuling, Pubkey } from '../types.js';
import { ascii, concatBytes, hash32, pubkeyBytes } from '../chain/bytes.js';

/**
 * `M = "VERDICT/PANEL/v1" ‖ program_id[32] ‖ bet[32] ‖ u8 outcome ‖ evidence_root[32] ‖ program_hash[32]` (145 bytes).
 * Keys are base58 strings or raw 32-byte arrays; hashes are hex or raw bytes.
 */
export function panelMessage(
  programId: Pubkey | Uint8Array,
  bet: Pubkey | Uint8Array,
  outcome: PanelOutcome | number,
  evidenceRoot: Hex32 | Uint8Array,
  programHash: Hex32 | Uint8Array,
): Uint8Array {
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 2) throw new Error(`panel outcome must be 0..2, got ${outcome}`);
  const m = concatBytes(
    ascii('VERDICT/PANEL/v1'),
    pubkeyBytes(programId),
    pubkeyBytes(bet),
    new Uint8Array([outcome]),
    hash32(evidenceRoot),
    hash32(programHash),
  );
  if (m.length !== PANEL_MESSAGE_BYTES) throw new Error('panel message length');
  return m;
}

/**
 * §10.5 ruling from the revealed judges (reveals already matched to their
 * commits). Votes count only judges with `confidence_bps >= PANEL_CONF_FLOOR_BPS`.
 * An outcome with ≥ 2 votes wins; otherwise No contest, signed by judges 0 and 1.
 * Duplicate reveals for one judge: the first is used. Invalid entries are ignored.
 */
export function panelQuorum(reveals: readonly JudgeReveal[]): PanelRuling {
  const seen = new Set<number>();
  const votes: [number, number, number] = [0, 0, 0];
  const voters: [number[], number[], number[]] = [[], [], []];
  for (const r of reveals) {
    if (!Number.isInteger(r.judge) || r.judge < 0 || r.judge > 2 || seen.has(r.judge)) continue;
    seen.add(r.judge);
    if (!Number.isInteger(r.outcome) || r.outcome < 0 || r.outcome > 2) continue;
    if (!Number.isInteger(r.confidence_bps) || r.confidence_bps < PANEL_CONF_FLOOR_BPS || r.confidence_bps > 10000) {
      continue;
    }
    votes[r.outcome]++;
    voters[r.outcome].push(r.judge);
  }
  for (const o of [0, 1, 2] as const) {
    if (votes[o] >= 2) {
      const s = voters[o].slice().sort((a, b) => a - b);
      return { outcome: o, votes, signers: [s[0]!, s[1]!] };
    }
  }
  return { outcome: 0, votes, signers: [0, 1] };
}
