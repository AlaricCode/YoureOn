/**
 * §12.11 Receipt rows: Verified, Terms, Evidence, Compute, Proof, Settlement.
 * Built from the on-chain Bet (+ TrackBuffer flags), the chain event log and
 * the read-side sources of the other modules. Pure given its inputs.
 */
import {
  BET_FLAG_AI_JUDGED,
  BET_FLAG_ANY_ACTOR_BOUND,
  BET_FLAG_MARKET,
  BET_STATE,
  CHUNK_GAP_MAX_MS,
  HEAD_INDEX_NONE,
  SETTLE_PATH,
  TRACK_FLAG_AUDIO_DISAGREE,
  TRACK_FLAG_CROSS_CHECK_OK,
  TRACK_FLAG_PHONE_DISAGREE,
  ZERO_HASH_HEX,
  payouts as enginePayouts,
  type BetAccount,
} from '@verdict/engine';
import { betWitnesses } from '../booth/exhibits.js';
import type { AcceptanceMeta, BetArtifacts, ChunkMeta, PerceptionMeta, WitnessMeta } from '../integration/sources.js';
import type { LoggedEvent } from './eventLog.js';

export type ReceiptStatus = 'ok' | 'pending' | 'failed' | 'none';

export type ReceiptDetail =
  | {
      key: 'verified';
      participants: { name: string; accepted: boolean; voice_cos_bps: number | null }[];
      bio_checks: { participant_name: string; frame: number; modality: 'face' | 'voice' }[];
      cross_check_ok: boolean;
      audio_disagree: boolean;
      phone_disagree: boolean;
    }
  | { key: 'terms'; program_hash: string; readback: string[]; yaml_url: string }
  | {
      key: 'evidence';
      evidence_root: string;
      gap_mask: number;
      witnesses: { label: string; chunks: number; synced: boolean; gap: boolean; late_chunks: number; gaps_ms: number[] }[];
    }
  | {
      key: 'compute';
      hosts: { provider: string; job_id: string; url: string | null; network: 'mainnet' | 'mock'; model_hash: string }[];
      agreed: boolean;
      entity_agreement_bps: Record<string, number>;
    }
  | {
      key: 'proof';
      biometric: { participant_name: string; modality: 'face' | 'voice'; frame: number; tx_url: string | null }[];
      binding: 'trusted';
      sp1: { tx_url: string | null } | null;
    }
  | { key: 'settlement'; path: 'consent' | 'rule' | 'panel' | 'refund'; tx_url: string | null; payouts: { name: string; amount_units: number }[] };

export interface ReceiptRow {
  key: ReceiptDetail['key'];
  label: 'Verified' | 'Terms' | 'Evidence' | 'Compute' | 'Proof' | 'Settlement';
  status: ReceiptStatus;
  url: string | null;
  detail: ReceiptDetail;
}

export interface ReceiptInput {
  betId: string;
  bet: BetAccount;
  /** decoded track_bin flags (null: no finalized tracks) */
  trackFlags: number | null;
  artifacts: BetArtifacts | null;
  witnesses: WitnessMeta[];
  chunks: (witnessKey: string) => ChunkMeta[];
  perception: PerceptionMeta | null;
  acceptances: AcceptanceMeta[];
  events: LoggedEvent[];
  /** wallet → display name */
  nameOf: (wallet: string) => string;
  /** wallet → user id (acceptances are keyed by user) */
  userIdOf: (wallet: string) => string | null;
  /** explorer link for a tx signature / account (null in mock mode) */
  txUrl: (signature: string | null | undefined) => string | null;
  accountUrl: (address: string) => string | null;
  yamlUrl: string;
}

const MODALITY = ['face', 'voice'] as const;
const PATH: Record<number, 'consent' | 'rule' | 'panel' | 'refund'> = {
  [SETTLE_PATH.CONSENT]: 'consent',
  [SETTLE_PATH.RULE]: 'rule',
  [SETTLE_PATH.PANEL]: 'panel',
  [SETTLE_PATH.REFUND]: 'refund',
};

const toNum = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : 0);

export function buildReceipt(i: ReceiptInput): ReceiptRow[] {
  return [verifiedRow(i), termsRow(i), evidenceRow(i), computeRow(i), proofRow(i), settlementRow(i)];
}

function participantsOf(bet: BetAccount): string[] {
  return bet.participants.slice(0, bet.n_participants);
}

const isMarket = (b: BetAccount) => (b.flags & BET_FLAG_MARKET) !== 0;
const isAi = (b: BetAccount) => (b.flags & BET_FLAG_AI_JUDGED) !== 0;
const refundedEarly = (b: BetAccount) => b.state === BET_STATE.Refunded && b.started_at === 0n;
const pastPerception = (b: BetAccount) => b.state >= BET_STATE.PreRuled || (b.state === BET_STATE.Perceiving && b.tracks_finalized !== 0);

function verifiedRow(i: ReceiptInput): ReceiptRow {
  const { bet } = i;
  const ps = participantsOf(bet);
  const participants = ps.map((w, idx) => {
    const uid = i.userIdOf(w);
    const a = uid ? i.acceptances.find((x) => x.user_id === uid) : undefined;
    // The creator proposes; counterparties accept by voice (market: by funding, D-32).
    const accepted = a?.accepted ?? (idx === 0 || ((bet.funded_mask >> idx) & 1) === 1);
    return { name: i.nameOf(w), accepted, voice_cos_bps: a?.voice_cos_bps ?? null };
  });
  const bio_checks = bet.bio.slice(0, bet.n_bio).map((b) => ({
    participant_name: i.nameOf(ps[b.participant] ?? ''),
    frame: b.frame,
    modality: MODALITY[b.modality] ?? 'face',
  }));
  const f = i.trackFlags;
  const cross = f !== null ? (f & TRACK_FLAG_CROSS_CHECK_OK) !== 0 : (i.perception?.agreed ?? false);
  const detail: ReceiptDetail = {
    key: 'verified',
    participants,
    bio_checks,
    cross_check_ok: cross,
    audio_disagree: (f !== null && (f & TRACK_FLAG_AUDIO_DISAGREE) !== 0) || i.perception?.audio_disagree === true,
    phone_disagree: (f !== null && (f & TRACK_FLAG_PHONE_DISAGREE) !== 0) || i.perception?.phone_disagree === true,
  };
  let status: ReceiptStatus;
  const allAccepted = participants.every((p) => p.accepted);
  if (refundedEarly(bet)) status = 'none';
  else if (!allAccepted) status = 'pending';
  else if (isMarket(bet) || isAi(bet)) status = 'ok';
  else if (f !== null) status = cross ? 'ok' : 'failed';
  // The TrackBuffer is closed after settlement: fall back to the stored cross-check result.
  else if (pastPerception(bet) && i.perception) status = i.perception.agreed ? 'ok' : 'failed';
  else status = pastPerception(bet) ? 'failed' : 'pending';
  return { key: 'verified', label: 'Verified', status, url: null, detail };
}

function termsRow(i: ReceiptInput): ReceiptRow {
  const created = i.events.find((e) => e.name === 'BetCreated');
  return {
    key: 'terms',
    label: 'Terms',
    status: i.artifacts ? 'ok' : 'pending',
    url: created ? i.txUrl(created.signature) : i.accountUrl(i.betId),
    detail: { key: 'terms', program_hash: i.bet.program_hash, readback: i.artifacts?.readback ?? [], yaml_url: i.yamlUrl },
  };
}

/** Positive gaps between consecutive chunks (ms). */
export function chunkGaps(chunks: ChunkMeta[]): number[] {
  const s = [...chunks].sort((a, b) => a.index - b.index);
  const out: number[] = [];
  for (let k = 1; k < s.length; k++) {
    const g = s[k]!.start_ms - (s[k - 1]!.start_ms + s[k - 1]!.duration_ms);
    if (g > 0) out.push(g);
  }
  return out;
}

function evidenceRow(i: ReceiptInput): ReceiptRow {
  const { bet } = i;
  const ws = betWitnesses(bet);
  const witnesses = ws.map((w) => {
    const meta = i.witnesses.find((m) => m.witness_key === w.key);
    const chunks = i.chunks(w.key);
    const gaps = chunkGaps(chunks);
    const head = bet.witness_heads[w.index]!;
    const nChunks = head === HEAD_INDEX_NONE ? chunks.length : Math.max(head + 1, chunks.length);
    return {
      label: meta?.label ?? w.label,
      chunks: nChunks,
      synced: meta?.synced ?? (meta?.offset_ms !== null && meta?.offset_ms !== undefined),
      gap: ((bet.gap_mask >> w.index) & 1) === 1 || gaps.some((g) => g > CHUNK_GAP_MAX_MS),
      late_chunks: chunks.filter((c) => c.late).length,
      gaps_ms: gaps,
    };
  });
  const ended = i.events.find((e) => e.name === 'BetEnded');
  let status: ReceiptStatus;
  if (isMarket(bet) || refundedEarly(bet)) status = 'none';
  else if (bet.state <= BET_STATE.Live) status = 'pending';
  else if (bet.evidence_root === ZERO_HASH_HEX && bet.n_witnesses > 0) status = 'failed';
  else status = 'ok';
  return {
    key: 'evidence',
    label: 'Evidence',
    status,
    url: ended ? i.txUrl(ended.signature) : null,
    detail: { key: 'evidence', evidence_root: bet.evidence_root, gap_mask: bet.gap_mask, witnesses },
  };
}

function computeRow(i: ReceiptInput): ReceiptRow {
  const { bet, perception } = i;
  const posted = i.events.find((e) => e.name === 'TracksPosted');
  let status: ReceiptStatus;
  // Market / AI-judged bets run no perception hosts (§3.11): nothing to show unless a host actually ran.
  const ranHosts = !!perception && perception.hosts.length > 0;
  if (isMarket(bet) || isAi(bet) || refundedEarly(bet)) status = ranHosts ? (perception!.agreed ? 'ok' : 'failed') : 'none';
  else if (perception) status = perception.agreed ? 'ok' : 'failed';
  else if (i.trackFlags !== null) status = (i.trackFlags & TRACK_FLAG_CROSS_CHECK_OK) !== 0 ? 'ok' : 'failed';
  else status = bet.state >= BET_STATE.PreRuled ? 'none' : 'pending';
  const hostUrl = perception?.hosts.find((h) => h.url)?.url ?? null;
  return {
    key: 'compute',
    label: 'Compute',
    status,
    url: hostUrl ?? (posted ? i.txUrl(posted.signature) : null),
    detail: {
      key: 'compute',
      hosts: perception?.hosts ?? [],
      agreed: perception?.agreed ?? (i.trackFlags !== null && (i.trackFlags & TRACK_FLAG_CROSS_CHECK_OK) !== 0),
      entity_agreement_bps: perception?.entity_agreement_bps ?? {},
    },
  };
}

function proofRow(i: ReceiptInput): ReceiptRow {
  const { bet } = i;
  const ps = participantsOf(bet);
  const bio = i.events
    .filter((e) => e.name === 'BiometricVerified')
    .map((e) => ({
      participant_name: i.nameOf(ps[toNum(e.data['participant_idx'])] ?? ''),
      modality: MODALITY[toNum(e.data['modality'])] ?? 'face',
      frame: toNum(e.data['frame']),
      tx_url: i.txUrl(e.signature),
    }));
  // Checkpoints present on the Bet but whose event was not observed still count.
  for (const b of bet.bio.slice(0, bet.n_bio)) {
    const name = i.nameOf(ps[b.participant] ?? '');
    const modality = MODALITY[b.modality] ?? 'face';
    if (!bio.some((x) => x.participant_name === name && x.frame === b.frame && x.modality === modality)) {
      bio.push({ participant_name: name, modality, frame: b.frame, tx_url: null });
    }
  }
  const sp1Settled = bet.settle_path === SETTLE_PATH.RULE;
  const preruled = i.events.find((e) => e.name === 'PreRuled');
  const actorBound = (bet.flags & BET_FLAG_ANY_ACTOR_BOUND) !== 0;
  let status: ReceiptStatus;
  if (bio.length > 0 || sp1Settled) status = 'ok';
  else if (!actorBound || refundedEarly(bet)) status = 'none';
  else status = bet.state >= BET_STATE.PreRuled ? 'failed' : 'pending';
  return {
    key: 'proof',
    label: 'Proof',
    status,
    url: bio.find((b) => b.tx_url)?.tx_url ?? null,
    detail: { key: 'proof', biometric: bio, binding: 'trusted', sp1: sp1Settled ? { tx_url: preruled ? i.txUrl(preruled.signature) : null } : null },
  };
}

function settlementRow(i: ReceiptInput): ReceiptRow {
  const { bet } = i;
  const ps = participantsOf(bet);
  const terminal = bet.state === BET_STATE.Settled || bet.state === BET_STATE.Refunded;
  const ev = [...i.events].reverse().find((e) => e.name === (bet.state === BET_STATE.Refunded ? 'Refunded' : 'Settled'));
  let amounts: number[] = [];
  const raw = ev ? (ev.data['payouts'] ?? ev.data['amounts']) : null;
  if (Array.isArray(raw)) amounts = raw.slice(0, ps.length).map(toNum);
  else if (terminal) {
    try {
      const winner = bet.state === BET_STATE.Refunded ? 0 : bet.final_winner_mask;
      const upheld = bet.settle_path === SETTLE_PATH.PANEL && bet.preruling === 1 && bet.final_winner_mask === bet.winner_mask;
      amounts = enginePayouts(bet, winner, upheld).payouts.map((x) => Number(x));
    } catch {
      amounts = [];
    }
  }
  const path = PATH[bet.settle_path] ?? (bet.state === BET_STATE.Refunded ? 'refund' : 'consent');
  return {
    key: 'settlement',
    label: 'Settlement',
    status: terminal ? 'ok' : 'pending',
    url: ev ? i.txUrl(ev.signature) : null,
    detail: {
      key: 'settlement',
      path,
      tx_url: ev ? i.txUrl(ev.signature) : null,
      payouts: terminal ? ps.map((w, k) => ({ name: i.nameOf(w), amount_units: amounts[k] ?? 0 })) : [],
    },
  };
}
