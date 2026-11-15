// Independent-review additions: Hermes-safe JCS, normTextDeep prototype safety, AuthorizeRequest
// invariants, and spec rows the first pass did not pin (SCHEMAS §3, §4, §6, §9, §10.1, X16).
import { describe, expect, it } from 'vitest';
import {
  AuthorizeRequest,
  CameraEvidence,
  ClarificationQuestion,
  computeTermsHash,
  ensureStringIsWellFormed,
  HearingTurn,
  jcs,
  normTextDeep,
  RealtimeEvent,
  sha256Hex,
  Terms,
  TermsStepOutput,
} from '../src';
import { realWorldTerms, skillTerms } from './fixtures';

const DOC_TERMS_HASH = '05860f0a9c9034685ddbed902667f8453258056a21de30138b430ba3903f998f';
const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';

describe('JCS without native String#isWellFormed (Hermes, SCHEMAS §11 rule 6)', () => {
  it('canonicalize@5.1.0 needs isWellFormed; jcs installs an equivalent fallback when absent', () => {
    const proto = String.prototype as { isWellFormed?: unknown };
    const native = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed');
    expect(native).toBeDefined(); // Node 22 has it; the test removes it to simulate an engine without it
    try {
      delete proto.isWellFormed;
      expect(typeof proto.isWellFormed).toBe('undefined');
      const { terms_hash } = computeTermsHash(skillTerms());
      expect(terms_hash).toBe(DOC_TERMS_HASH);
      expect(typeof proto.isWellFormed).toBe('function');
      // Fallback semantics: lone surrogates are still refused by canonicalize.
      expect(() => jcs({ k: '\ud800' })).toThrow();
      expect(jcs({ k: '😀' })).toBe('{"k":"😀"}');
    } finally {
      if (native) Object.defineProperty(String.prototype, 'isWellFormed', native);
    }
    // With the native method present the guard is a no-op.
    ensureStringIsWellFormed();
    expect(Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed')).toEqual(native);
  });
});

describe('normTextDeep keeps "__proto__" an own key (strict parse still rejects it)', () => {
  it('a JSON __proto__ key cannot smuggle a required field past Terms.parse', () => {
    const t = skillTerms();
    const claim = t.claim;
    delete t.claim;
    const raw = JSON.parse(
      JSON.stringify(t).replace('{', `{"__proto__":{"claim":${JSON.stringify(claim)}},`),
    ) as unknown;
    const n = normTextDeep(raw) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(n, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(n)).toBe(Object.prototype);
    expect(Terms.safeParse(n).success).toBe(false);
  });
});

describe('AuthorizeRequest invariants (§9 field comments, API-CONTRACT §2.8)', () => {
  const req = () => ({
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
    nonce_index: 2,
    accept_deadline: 1795284618,
    expires_at: '2026-11-21T18:10:13.000Z', // API-CONTRACT §8 trace: accept_deadline − 5 s
  });
  const paths = (x: unknown): string[] => {
    const r = AuthorizeRequest.safeParse(x);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  };
  it('the API-CONTRACT trace values parse', () => {
    expect(paths(req())).toEqual([]);
  });
  it("nonce_index is set iff kind = 'atomic_lock' (sequential requests carry null)", () => {
    expect(paths({ ...req(), nonce_index: null })).toContain('nonce_index');
    expect(paths({ ...req(), kind: 'accept_bet' })).toContain('nonce_index');
    expect(paths({ ...req(), kind: 'create_bet', nonce_index: null })).toEqual([]);
  });
  it('expires_at = accept_deadline − LOCK_SUBMIT_MARGIN_SECS', () => {
    expect(paths({ ...req(), expires_at: '2026-11-21T18:10:18.000Z' })).toContain('expires_at');
    expect(paths({ ...req(), expires_at: '2026-11-21T18:10:13.001Z' })).toContain('expires_at');
  });
  it('a terms edit after the hash was computed fails the envelope check', () => {
    const r = req();
    (r.envelope.terms as Record<string, unknown>).stakes = {
      a: '20000000',
      b: '20000000',
      currency: 'USDC',
    };
    expect(paths(r)).toContain('envelope.terms_hash');
  });
});

describe('spec rows pinned by this review', () => {
  it('§2.1 real-world with A on NO: yes_party B, stakes swapped', () => {
    const rw = realWorldTerms();
    const no = {
      ...rw,
      yes_party: 'B',
      market: { ...rw.market, side: 'NO' },
      stakes: { a: '3800000', b: '6200000', currency: 'USDC' },
    };
    expect(Terms.safeParse(no).success).toBe(true);
    expect(Terms.safeParse({ ...no, stakes: rw.stakes }).success).toBe(false);
    expect(Terms.safeParse({ ...no, yes_party: 'A' }).success).toBe(false);
  });
  it('§3 there is no 3rd clarification (index ∈ {1, 2})', () => {
    const q = {
      question_id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
      index: 2,
      field: 'attempts',
      question: 'One flip or best of three?',
      options: ['One flip', 'Best of three'],
      addressed_to: 'both',
      asked_at: '2026-11-21T18:04:58.100Z',
    };
    expect(ClarificationQuestion.safeParse(q).success).toBe(true);
    expect(ClarificationQuestion.safeParse({ ...q, index: 3 }).success).toBe(false);
    expect(ClarificationQuestion.safeParse({ ...q, index: 0 }).success).toBe(false);
  });
  it('§3 TermsStepOutput propose / refuse variants', () => {
    const proposal = {
      type: 'skill',
      claim: 'Jake lands a water bottle flip upright on the table.',
      performer: 'B',
      yes_party: 'B',
      attempts: { count: 3, rule: 'best_of' },
      success_criteria: ['The bottle comes to rest standing upright on its base.'],
      failure_criteria: [],
      edge_cases: [],
      evidence_source: 'camera',
      amount: '5000000',
      market_query: null,
      deadline_minutes: 10,
    };
    expect(
      TermsStepOutput.safeParse({ kind: 'propose', proposal, readback: 'Best of three, $5.' })
        .success,
    ).toBe(true);
    expect(
      TermsStepOutput.safeParse({ kind: 'propose', proposal, readback: 'two  spaces' }).success,
    ).toBe(false);
    expect(
      TermsStepOutput.safeParse({
        kind: 'refuse',
        refusal: { refused: true, category: 'dangerous', quip: 'Not on my watch.' },
      }).success,
    ).toBe(true);
    expect(TermsStepOutput.safeParse({ kind: 'rule', ruling: {} }).success).toBe(false);
  });
  it('X16: a clip is ≤ 30 s and ≤ 24 frames; frame indices are 0..23', () => {
    const frame = (i: number) => ({ index: i, t_ms: i * 250, sha256: sha256Hex(`f${i}`) });
    const ev = {
      schema_version: 1,
      kind: 'camera',
      bet_id: BET,
      attempt_no: 1,
      clip_sha256: sha256Hex('example clip bytes'),
      clip_bytes: 4_200_000,
      mime: 'video/quicktime',
      duration_ms: 30_000,
      recorded_by: 'A',
      recorded_at: '2026-11-21T18:07:00.000Z',
      frames: Array.from({ length: 24 }, (_, i) => frame(i)),
    };
    expect(CameraEvidence.safeParse(ev).success).toBe(true);
    expect(CameraEvidence.safeParse({ ...ev, duration_ms: 30_001 }).success).toBe(false);
    expect(
      CameraEvidence.safeParse({ ...ev, frames: Array.from({ length: 25 }, (_, i) => frame(i)) })
        .success,
    ).toBe(false);
    expect(CameraEvidence.safeParse({ ...ev, frames: [] }).success).toBe(false);
    expect(CameraEvidence.safeParse({ ...ev, attempt_no: 0 }).success).toBe(false);
  });
  it('§6 a hearing turn is 10 s + 2 s grace; party/turn_index are A=0, B=1 by schema range', () => {
    const turn = {
      schema_version: 1,
      turn_id: 'a1c2e3f4-5b6d-4e7f-8a9b-0c1d2e3f4a5b',
      hearing_id: 'c0ffee00-1234-4abc-8def-001122334455',
      bet_id: BET,
      turn_index: 1,
      party: 'B',
      started_at: '2026-11-21T18:07:20.000Z',
      ended_at: '2026-11-21T18:07:32.000Z',
      duration_ms: 12_000,
      transcript: 'It ended standing up. Pay me.',
      transcript_sha256: 'fcc0bf64f8e66de852e163db4057a57f85158e6410077b38989066aee153ab58',
      stt: 'device',
    };
    expect(HearingTurn.safeParse(turn).success).toBe(true);
    expect(sha256Hex(turn.transcript)).toBe(turn.transcript_sha256);
    expect(HearingTurn.safeParse({ ...turn, duration_ms: 12_001 }).success).toBe(false);
    expect(HearingTurn.safeParse({ ...turn, turn_index: 2 }).success).toBe(false);
  });
  it('§10.1: the 32 spec types + 4 API-CONTRACT §3.4 extensions; source is chain iff type starts with chain.', () => {
    const opts = RealtimeEvent.options.map((o) => ({
      type: o.shape.type.value,
      source: o.shape.source.value,
    }));
    expect(opts).toHaveLength(36);
    expect(new Set(opts.map((o) => o.type)).size).toBe(36);
    for (const t of ['bet.invite_answered', 'tx.sign_request', 'judge.cue', 'hearing.turn_open']) {
      expect(opts.map((o) => o.type)).toContain(t);
    }
    for (const o of opts) expect(o.source).toBe(o.type.startsWith('chain.') ? 'chain' : 'server');
    expect(opts.filter((o) => o.source === 'chain')).toHaveLength(10);
  });
});
