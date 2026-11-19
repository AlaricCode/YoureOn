// Realtime / snapshot fixtures for the store, hub and machine tests: real, hash-checked Terms
// (the preview bottle flip), parsed through the shared schemas like the socket does.
import type { BetSnapshot } from '@youre-on/shared/api';
import { AppealResult, AppealVote, decideAppeal } from '@youre-on/shared/appeal';
import { LOCK_SUBMIT_MARGIN_SECS } from '@youre-on/shared/constants';
import { RealtimeEvent } from '@youre-on/shared/realtime';
import { Ruling } from '@youre-on/shared/ruling';
import { TermsEnvelope } from '@youre-on/shared/terms';

import { bottleFlip, danceOff } from '../../preview/data';

export const flip = bottleFlip('Logan', 'Jake');
export const BET = flip.terms.bet_id;
export const ME_A = {
  user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  pubkey: flip.terms.party_a.pubkey,
  display_name: 'Logan',
  avatar_url: null,
};
export const ME_B = {
  user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  pubkey: flip.terms.party_b.pubkey,
  display_name: 'Jake',
  avatar_url: null,
};
export const DEVICE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddd0a';
export const DEVICE_CAM = 'dddddddd-dddd-4ddd-8ddd-dddddddddcaa';
export const ROOM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const envelope = () =>
  TermsEnvelope.parse({
    terms: flip.terms,
    terms_hash: flip.termsHash,
    presentation: {
      title: 'Bottle flip',
      readback: 'One flip.',
      stakes_display: '$5 each',
      odds_display: null,
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  });

/** A Dance Off (DANCE-OFF §1): real, hash-checked dance terms on the bundled Wave Pop routine. */
export const dance = danceOff('Logan', 'Jake');
export const danceEnvelope = () =>
  TermsEnvelope.parse({
    terms: dance.terms,
    terms_hash: dance.termsHash,
    presentation: {
      title: 'Dance off',
      readback: 'Wave Pop, 15 seconds.',
      stakes_display: '$5 each',
      odds_display: null,
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  });

const ACCEPT_DEADLINE = 1_795_000_000;
export const authorizeRequest = () => ({
  bet_id: BET,
  lock_request_id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516',
  kind: 'atomic_lock' as const,
  envelope: envelope(),
  message_b64: 'AQID',
  message_sha256: 'ab'.repeat(32),
  nonce_index: 3,
  accept_deadline: ACCEPT_DEADLINE,
  expires_at: new Date((ACCEPT_DEADLINE - LOCK_SUBMIT_MARGIN_SECS) * 1000).toISOString(),
});

export const ruling = (outcome: 'A_WINS' | 'B_WINS' | 'REDO', attempt_no = 1) =>
  Ruling.parse({
    schema_version: 1,
    ruling_id: '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a',
    bet_id: BET,
    outcome,
    claim_result: outcome === 'REDO' ? 'UNCLEAR' : outcome === 'B_WINS' ? 'MET' : 'NOT_MET',
    confidence: outcome === 'REDO' ? 0.4 : 0.93,
    reason: 'Frame 7 shows the bottle on its side.',
    cited_frames: [7],
    frame_hashes: Array.from({ length: 8 }, (_, i) => i.toString(16).repeat(64)),
    model: 'anthropic/claude-sonnet-5',
    evidence_hash: 'cd'.repeat(32),
    terms_hash: flip.termsHash,
    created_at: '2026-11-21T18:08:00.000Z',
    stage: 'attempt',
    attempt_no,
    redo_reason: outcome === 'REDO' ? 'unclear' : null,
    void_reason: null,
  });

let seqCounter = 0;
export function ev(
  type: string,
  payload: unknown,
  seq?: number,
  source: 'server' | 'chain' = 'server',
): RealtimeEvent {
  return RealtimeEvent.parse({
    v: 1,
    type,
    bet_id: BET,
    seq: seq ?? ++seqCounter,
    ts: '2026-11-21T18:06:31.000Z',
    source,
    payload,
  });
}

export const stateEv = (state: string, seq?: number, reason: string | null = null) =>
  ev(
    'bet.state',
    { state, prev: null, onchain_status: null, chain_ack: 'none', pending_tx: null, reason },
    seq,
  );

export function snapshot(o: Partial<BetSnapshot> = {}): BetSnapshot {
  return {
    bet_id: BET,
    room_id: ROOM,
    state: 'DRAFTING',
    prev_state: null,
    onchain_status: null,
    chain_ack: 'none',
    pending_tx: null,
    party_a: ME_A,
    party_b: ME_B,
    my_party: 'A',
    envelope: null,
    draft: null,
    authorizations: { A: null, B: null },
    deadlines: {
      accept_deadline: null,
      resolve_deadline: null,
      appeal_deadline: null,
      appeal_resolve_deadline: null,
    },
    attempt_no: null,
    redo_count: 0,
    latest_ruling: null,
    appeal: null,
    payout: null,
    signatures: {},
    end_reason: null,
    last_seq: 2,
    ...o,
  } as BetSnapshot;
}

// ---- Beat 5: the appeal panel (SCHEMAS §7) -------------------------------------------------

export const APPEAL_ID = 'e9f8a7b6-c5d4-4e3f-a2b1-c0d9e8f7a6b5';
const PROVIDERS = ['anthropic', 'openai', 'google'] as const;

/** One panel vote (`counted` = how it counts; ABSTAIN = a seat that timed out). */
export function appealVote(seat: 0 | 1 | 2, counted: 'A_WINS' | 'B_WINS' | 'ABSTAIN') {
  const ok = counted !== 'ABSTAIN';
  return AppealVote.parse({
    schema_version: 1,
    appeal_id: APPEAL_ID,
    bet_id: BET,
    seat,
    provider: PROVIDERS[seat],
    model: `${PROVIDERS[seat]}/model-${seat}`,
    status: ok ? 'ok' : 'timeout',
    outcome: ok ? counted : 'REDO',
    confidence: ok ? 0.82 : 0,
    reason: ok ? `Seat ${seat}: it ends on its side in frame 6.` : '',
    counted_as: counted,
    latency_ms: 2400,
    created_at: '2026-11-21T18:08:12.000Z',
  });
}

/** The panel's result for B's appeal of an A_WINS ruling: `counted` decides it (decideAppeal). */
export function appealResult(counted: readonly ('A_WINS' | 'B_WINS' | 'ABSTAIN')[]) {
  const votes = counted.map((c, i) => appealVote(i as 0 | 1 | 2, c));
  const d = decideAppeal('A_WINS', votes);
  return AppealResult.parse({
    schema_version: 1,
    appeal_id: APPEAL_ID,
    bet_id: BET,
    appellant: 'B',
    original_outcome: 'A_WINS',
    original_ruling_hash: 'ef'.repeat(32),
    votes,
    tally: d.tally,
    final_outcome: d.final_outcome,
    decided_by: d.decided_by,
    flipped: d.flipped,
    evidence_hash: 'cd'.repeat(32),
    frame_hashes: [],
    terms_hash: flip.termsHash,
    created_at: '2026-11-21T18:08:14.000Z',
  });
}
