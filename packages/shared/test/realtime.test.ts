import { describe, expect, it } from 'vitest';
import {
  AuthorizeRequest,
  BetState,
  CameraEvidence,
  CHAIN_EVENT_NAMES,
  chainEventDedupKey,
  ChainEvents,
  Instruction,
  OnchainOutcome,
  OnchainStatus,
  parseRealtimeEvent,
  PartyAuthorization,
  PartyDecline,
  RealtimeEvent,
  sha256Hex,
  TxKind,
} from '../src';
import { betResolvedEvent, rulingExample, skillTerms } from './fixtures';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const DOC_TERMS_HASH = '05860f0a9c9034685ddbed902667f8453258056a21de30138b430ba3903f998f';
const SIG =
  '52i3cfdiJhBc6Wko6rxC2MUJBK2SoB7JBt6wLy8UEYUwyLPzxMvLr8PTvx1PjQJsCMjW3gCDWNaiymADMGhazeUk';
const envOf = (type: string, payload: unknown, source = 'server') => ({
  v: 1,
  type,
  bet_id: BET,
  seq: 3,
  ts: '2026-11-21T18:06:31.000Z',
  source,
  payload,
});

const authorizeRequest = () => ({
  bet_id: BET,
  lock_request_id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516',
  kind: 'atomic_lock',
  envelope: {
    terms: skillTerms(),
    terms_hash: DOC_TERMS_HASH,
    presentation: {
      title: 'Bottle flip',
      readback: 'Jake lands a water bottle flip upright on the table.',
      stakes_display: '$5 vs $5',
      odds_display: null,
      party_a_avatar_url: null,
      party_b_avatar_url: null,
    },
  },
  message_b64: 'AAAA',
  message_sha256: sha256Hex('message'),
  nonce_index: 3,
  accept_deadline: 1795284612,
  expires_at: '2026-11-21T18:10:07.000Z',
});

describe('enums mirror Postgres / Rust order (§9.3, X2, X6, X19)', () => {
  it('BetState: 18 values in DATA-MODEL order', () => {
    expect(BetState.options).toEqual([
      'DRAFTING',
      'TERMS_PROPOSED',
      'AWAITING_AUTHORIZATIONS',
      'AWAITING_LOCK',
      'LOCKED',
      'ATTEMPT',
      'JUDGING',
      'HEARING',
      'AWAITING_MARKET',
      'RULED',
      'CONCEDED',
      'FINALIZED',
      'APPEALED',
      'APPEAL_RESOLVED',
      'PAID',
      'VOIDED',
      'CANCELLED',
      'EXPIRED',
    ]);
  });
  it('OnchainStatus / OnchainOutcome = borsh order; TxKind = tx_kind; Instruction = chain_ix', () => {
    expect(OnchainStatus.options).toEqual([
      'Open',
      'Locked',
      'Resolved',
      'Appealed',
      'Settled',
      'Refunded',
      'Cancelled',
    ]);
    expect(OnchainOutcome.options).toEqual(['PartyA', 'PartyB', 'Split', 'Refund']);
    // Literal lists copied from DATA-MODEL §4 (tx_kind, chain_ix), not derived from each other.
    expect(TxKind.options).toEqual([
      'atomic_lock',
      'create_bet',
      'accept_bet',
      'cancel_open_bet',
      'resolve',
      'concede',
      'appeal',
      'resolve_appeal',
      'finalize',
      'timeout_refund',
      'close_bet',
      'nonce_advance',
    ]);
    expect(Instruction.options).toEqual([
      'create_bet',
      'accept_bet',
      'cancel_open_bet',
      'resolve',
      'concede',
      'appeal',
      'resolve_appeal',
      'finalize',
      'timeout_refund',
      'close_bet',
    ]);
  });
});

describe('authorization (§9)', () => {
  it('AuthorizeRequest parses and re-verifies the envelope hash', () => {
    expect(AuthorizeRequest.safeParse(authorizeRequest()).success).toBe(true);
    const tampered = authorizeRequest();
    (tampered.envelope.terms as Record<string, unknown>).claim = 'Jake lands it on the cap.';
    expect(AuthorizeRequest.safeParse(tampered).success).toBe(false);
    expect(AuthorizeRequest.safeParse({ ...authorizeRequest(), kind: 'resolve' }).success).toBe(
      false,
    );
    expect(AuthorizeRequest.safeParse({ ...authorizeRequest(), nonce_index: 16 }).success).toBe(
      false,
    );
    expect(
      AuthorizeRequest.safeParse({ ...authorizeRequest(), message_b64: 'A'.repeat(1645) }).success,
    ).toBe(false);
  });
  it('PartyAuthorization and PartyDecline', () => {
    const a = {
      bet_id: BET,
      lock_request_id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516',
      party: 'B',
      terms_hash: DOC_TERMS_HASH,
      method: 'passcode_hold',
      authorized_at: '2026-11-21T18:06:40.000Z',
      ms_since_auth_success: 12,
      message_sha256: sha256Hex('message'),
      party_signature: SIG,
    };
    expect(PartyAuthorization.safeParse(a).success).toBe(true);
    expect(PartyAuthorization.safeParse({ ...a, method: 'face_match' }).success).toBe(false);
    expect(PartyAuthorization.safeParse({ ...a, ms_since_auth_success: 60_001 }).success).toBe(
      false,
    );
    expect(
      PartyDecline.safeParse({
        bet_id: BET,
        party: 'A',
        lock_request_id: null,
        declined_at: a.authorized_at,
      }).success,
    ).toBe(true);
  });
});

describe('RealtimeEvent (§10)', () => {
  it('§10.1 chain.BetResolved example parses', () => {
    const e = RealtimeEvent.parse(betResolvedEvent());
    expect(e.type).toBe('chain.BetResolved');
    if (e.type === 'chain.BetResolved') expect(e.payload.outcome).toBe('PartyB');
  });
  it('source is fixed per type', () => {
    expect(RealtimeEvent.safeParse({ ...betResolvedEvent(), source: 'server' }).success).toBe(
      false,
    );
    expect(RealtimeEvent.safeParse(envOf('terms.declined', { party: 'A' }, 'chain')).success).toBe(
      false,
    );
  });
  it('unknown types fail safeParse (clients drop them)', () => {
    const r = parseRealtimeEvent(envOf('future.thing', {}));
    expect(r.ok).toBe(false);
  });
  it('server events parse: bet.state, terms.authorize_request, terms.authorized, ruling.issued, tx.*', () => {
    const ok = (type: string, payload: unknown) => {
      const r = RealtimeEvent.safeParse(envOf(type, payload));
      expect(r.success, `${type}: ${r.success ? '' : r.error.message}`).toBe(true);
    };
    ok('bet.state', {
      state: 'AWAITING_LOCK',
      prev: 'AWAITING_AUTHORIZATIONS',
      onchain_status: null,
      chain_ack: 'none',
      pending_tx: {
        kind: 'atomic_lock',
        signature: SIG,
        submitted_at: '2026-11-21T18:06:41.000Z',
        rpc_processed_at: null,
        rpc_confirmed_at: null,
      },
      reason: null,
    });
    ok('terms.authorize_request', authorizeRequest());
    ok('terms.authorized', {
      party: 'A',
      method: 'faceid_hold',
      authorized_at: '2026-11-21T18:06:40.000Z',
      count: 1,
    });
    ok('ruling.issued', {
      ruling: rulingExample(),
      ruling_hash: '997ce27843ff323b7f7f8816f9eff0d0044a485a43c5625512a8967f82755daa',
    });
    ok('tx.submitted', { kind: 'nonce_advance', signature: SIG });
    ok('tx.failed', { kind: 'atomic_lock', signature: null, error: 'preflight rejected' });
    ok('hearing.opened', {
      hearing_id: 'c0ffee00-1234-4abc-8def-001122334455',
      trigger: 'demo',
      order: ['A', 'B'],
      turn_ms: 10_000,
    });
    ok('attempt.evidence', {
      evidence: CameraEvidence.parse({
        schema_version: 1,
        kind: 'camera',
        bet_id: BET,
        attempt_no: 1,
        clip_sha256: sha256Hex('example clip bytes'),
        clip_bytes: 4_200_000,
        mime: 'video/mp4',
        duration_ms: 5_800,
        recorded_by: 'A',
        recorded_at: '2026-11-21T18:07:00.000Z',
        frames: [{ index: 0, t_ms: 0, sha256: sha256Hex('example frame 0') }],
      }),
      frame_urls: ['https://storage.example.com/f0.jpg?sig=x'],
    });
  });
  it('API-CONTRACT §3.4 extensions parse (bet.invite_answered, judge.cue, hearing.turn_open, attempt.started+)', () => {
    const ok = (type: string, payload: unknown) => {
      const r = parseRealtimeEvent(envOf(type, payload));
      expect(r.ok, `${type}: ${r.ok ? '' : r.error.message}`).toBe(true);
    };
    ok('bet.invite_answered', { party: 'B', answer: 'declined' });
    ok('judge.cue', { cue: 'DECLINED', text: '[EVENT] cue=DECLINED party=B', speak: true });
    ok('hearing.turn_open', {
      hearing_id: 'c0ffee00-1234-4abc-8def-001122334455',
      turn_index: 0,
      party: 'A',
      closes_at: '2026-11-21T18:08:10.000Z',
    });
    ok('attempt.started', {
      attempt_no: 1,
      performer: 'A',
      max_ms: 15_000,
      recorder_device_id: 'c0ffee00-1234-4abc-8def-001122334466',
      go_at: '2026-11-21T18:07:00.000Z',
    });
    expect(
      parseRealtimeEvent(envOf('bet.invite_answered', { party: 'A', answer: 'accepted' })).ok,
    ).toBe(false);
    expect(parseRealtimeEvent(envOf('judge.cue', { cue: 'NOPE', text: '', speak: true })).ok).toBe(
      false,
    );
  });
  it('strict envelope: extra keys rejected', () => {
    expect(RealtimeEvent.safeParse({ ...betResolvedEvent(), extra: 1 }).success).toBe(false);
  });
});

describe('chain events (§10.2)', () => {
  it('exposes the 10 events and the dedup key', () => {
    expect(CHAIN_EVENT_NAMES).toHaveLength(10);
    expect(chainEventDedupKey({ signature: SIG, outer_ix: 3, inner_ix: 0 })).toBe(`${SIG}:3:0`);
  });
  it('BetFinalized (terminal) parses with u64 strings', () => {
    const p = ChainEvents.BetFinalized.parse({
      signature: SIG,
      slot: 1,
      block_height: null,
      outer_ix: 2,
      inner_ix: 1,
      block_time: null,
      observed_via: 'rpc_poll',
      bet_id: BET,
      final_status: 'Settled',
      outcome: 'Refund',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      party_a: 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4',
      party_b: 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr',
      party_a_token: '11111111111111111111111111111111',
      party_b_token: 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr',
      to_a: '6200000',
      to_b: '3800000',
      ts: 1795284440,
      caller: 'B1Qtn1Zk68Sqx2rFDNdqGbMv5m5t4pCKU2P1MDjZ7NWi',
    });
    expect(p.to_a).toBe('6200000');
    expect(ChainEvents.BetFinalized.safeParse({ ...p, to_a: 6200000 }).success).toBe(false);
  });
});
