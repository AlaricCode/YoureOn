/**
 * §9.4 #5–#7: start, commit_evidence, end (§7.4 rolling evidence roots, §7.5 beacon).
 */
import {
  BEACON_MAX_AGE_SLOTS,
  BET_STATE,
  EVIDENCE_MAX_GAP_S,
  MAX_CHUNKS_PER_COMMIT,
  MAX_WITNESSES,
  START_WINDOW_S,
} from '../../constants.js';
import type { BetAccount, HeadArg, InstructionArgsMap, SlotHashEntry } from '../../types.js';
import { isValidPubkey, toHex, ZERO_HASH, ZERO_KEY } from '../bytes.js';
import { genesisHash, HEAD_NONE, headsRoot } from '../hashes.js';
import { check, type Env, isMarket, participantIndex } from './env.js';

/** Binary search over SlotHashes (descending by slot). */
export function findSlotHash(entries: readonly SlotHashEntry[], slot: bigint): SlotHashEntry | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = entries[mid]!.slot;
    if (s === slot) return entries[mid]!;
    if (s > slot) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

function storedRoot(bet: BetAccount): string {
  const heads = [];
  for (let w = 0; w < bet.n_witnesses; w++) {
    heads.push({ key: bet.witnesses[w]!, index: bet.witness_heads[w]!, hash: bet.witness_head_hashes[w]! });
  }
  return toHex(headsRoot(heads));
}

/** #5 start. */
export function start(bet: BetAccount, env: Env, a: InstructionArgsMap['start']): void {
  const auth = env.signer('authority');
  check(auth === bet.creator || auth === bet.oracle, 'Unauthorized');
  check(bet.state === BET_STATE.Funded, 'InvalidState');
  check(env.now <= bet.funded_at + BigInt(START_WINDOW_S), 'DeadlinePassed');

  const ws = a.witnesses;
  check(ws.length <= MAX_WITNESSES, 'TooManyWitnesses');
  check(new Set(ws.map((w) => w.key)).size === ws.length, 'TooManyWitnesses');
  check(
    ws.every((w) => isValidPubkey(w.key) && w.key !== ZERO_KEY && Number.isInteger(w.kind) && w.kind >= 0 && w.kind <= 2),
    'TooManyWitnesses',
  );

  let beaconHash = ZERO_HASH;
  if (isMarket(bet)) {
    check(a.beacon_slot === 0n, 'BeaconSlotNotFound');
    check(ws.length === 0, 'TooManyWitnesses');
  } else {
    check(a.beacon_slot <= env.ctx.slot, 'BeaconSlotNotFound');
    check(env.ctx.slot - a.beacon_slot <= BigInt(BEACON_MAX_AGE_SLOTS), 'BeaconTooOld');
    const e = findSlotHash(env.ctx.slot_hashes, a.beacon_slot);
    check(e !== null, 'BeaconSlotNotFound');
    beaconHash = e.hash.toLowerCase();
  }

  bet.beacon_slot = a.beacon_slot;
  bet.beacon_hash = beaconHash;
  bet.n_witnesses = ws.length;
  for (let w = 0; w < MAX_WITNESSES; w++) {
    const wa = ws[w];
    bet.witnesses[w] = wa ? wa.key : ZERO_KEY;
    bet.witness_kinds[w] = wa ? wa.kind : 0xff;
    bet.witness_heads[w] = HEAD_NONE;
    bet.witness_head_hashes[w] = wa
      ? toHex(genesisHash(env.betKey, wa.key, wa.kind, a.beacon_slot, beaconHash))
      : ZERO_HASH;
  }
  bet.gap_mask = 0;
  bet.evidence_seq = 0;
  bet.evidence_root = storedRoot(bet);
  bet.last_commit_at = env.now;
  bet.started_at = env.now;
  bet.state = BET_STATE.Live;
  env.emit('BetStarted', {
    bet: env.betKey,
    beacon_slot: a.beacon_slot,
    beacon_hash: beaconHash,
    started_at: env.now,
    n_witnesses: ws.length,
  });
}

/** Applies a full heads commit (§7.4 checks). */
function applyHeads(bet: BetAccount, env: Env, seq: number, heads: HeadArg[]): void {
  check(seq === bet.evidence_seq + 1, 'EvidenceSeq');
  check(heads.length === bet.n_witnesses, 'EvidenceHeads');
  let gap = bet.gap_mask;
  const newHashes: string[] = [];
  for (let w = 0; w < heads.length; w++) {
    const h = heads[w]!;
    const hash = h.hash.toLowerCase();
    check(Number.isInteger(h.index) && h.index >= 0 && h.index <= HEAD_NONE, 'EvidenceHeads');
    const oldIdx = bet.witness_heads[w]!;
    const oldN = oldIdx === HEAD_NONE ? -1 : oldIdx;
    const newN = h.index === HEAD_NONE ? -1 : h.index;
    check(newN >= oldN, 'EvidenceRegress');
    if (newN === oldN) check(hash === bet.witness_head_hashes[w], 'EvidenceRegress');
    if (newN - oldN > MAX_CHUNKS_PER_COMMIT) gap |= 1 << w;
    newHashes.push(hash);
  }
  if (env.now - bet.last_commit_at > BigInt(EVIDENCE_MAX_GAP_S)) gap |= (1 << bet.n_witnesses) - 1;
  for (let w = 0; w < heads.length; w++) {
    bet.witness_heads[w] = heads[w]!.index;
    bet.witness_head_hashes[w] = newHashes[w]!;
  }
  bet.gap_mask = gap;
  bet.evidence_seq = seq;
  bet.last_commit_at = env.now;
  bet.evidence_root = storedRoot(bet);
}

/** #6 commit_evidence (oracle). */
export function commitEvidence(bet: BetAccount, env: Env, a: InstructionArgsMap['commit_evidence']): void {
  const oracle = env.signer('oracle');
  check(oracle === bet.oracle, 'Unauthorized');
  check(bet.state === BET_STATE.Live, 'InvalidState');
  applyHeads(bet, env, a.seq, a.heads);
  env.emit('EvidenceCommitted', {
    bet: env.betKey,
    seq: bet.evidence_seq,
    root: bet.evidence_root,
    gap_mask: bet.gap_mask,
    is_final: false,
  });
}

/** #7 end. */
export function end(bet: BetAccount, env: Env, a: InstructionArgsMap['end']): void {
  const auth = env.signer('authority');
  check(bet.state === BET_STATE.Live, 'InvalidState');
  const isOracle = auth === bet.oracle;
  if (isMarket(bet)) {
    check(isOracle, 'Unauthorized');
    check(a.heads.length === 0, 'EvidenceHeads');
  } else if (isOracle) {
    if (a.heads.length > 0) applyHeads(bet, env, a.seq, a.heads);
  } else if (participantIndex(bet, auth) >= 0) {
    check(a.heads.length === 0, 'EvidenceHeads');
  } else {
    check(env.now >= bet.started_at + BigInt(bet.time_limit_s), 'DeadlineNotReached');
    check(a.heads.length === 0, 'EvidenceHeads');
  }
  bet.evidence_root = storedRoot(bet);
  bet.ended_at = env.now;
  bet.state = BET_STATE.Perceiving;
  env.emit('EvidenceCommitted', {
    bet: env.betKey,
    seq: bet.evidence_seq,
    root: bet.evidence_root,
    gap_mask: bet.gap_mask,
    is_final: true,
  });
  env.emit('BetEnded', { bet: env.betKey, evidence_root: bet.evidence_root, ended_at: env.now });
}
