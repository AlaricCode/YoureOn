// Realtime / snapshot fixtures for the store, hub and machine tests: real, hash-checked Terms
// (the preview bottle flip), parsed through the shared schemas like the socket does.
import type { BetSnapshot } from '@youre-on/shared/api';
import { LOCK_SUBMIT_MARGIN_SECS } from '@youre-on/shared/constants';
import { RealtimeEvent } from '@youre-on/shared/realtime';
import { Ruling } from '@youre-on/shared/ruling';
import { TermsEnvelope } from '@youre-on/shared/terms';

import { bottleFlip } from '../../preview/data';

export const flip = bottleFlip('Logan', 'Jake');
export const BET = flip.terms.bet_id;
export const ME_A = { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', pubkey: flip.terms.party_a.pubkey, display_name: 'Logan', avatar_url: null };
export const ME_B = { user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', pubkey: flip.terms.party_b.pubkey, display_name: 'Jake', avatar_url: null };
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
export function ev(type: string, payload: unknown, seq?: number, source: 'server' | 'chain' = 'server'): RealtimeEvent {
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
  ev('bet.state', { state, prev: null, onchain_status: null, chain_ack: 'none', pending_tx: null, reason }, seq);

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
    deadlines: { accept_deadline: null, resolve_deadline: null, appeal_deadline: null, appeal_resolve_deadline: null },
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
