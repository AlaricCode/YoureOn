// DANCE-OFF §1, §5, §7: the hashed-record widenings (Terms.type 'dance_off', Ruling 'undecidable'
// for DANCE_OFF_MODEL), the terms pipeline, DanceEvidence, dance.scored and the rematch helpers.
import { describe, expect, it } from 'vitest';
import {
  buildDanceEvidence,
  classifyChallenge,
  computeTermsHash,
  DANCE_OFF_MODEL,
  DANCE_RULE_LINE,
  danceEvidenceHash,
  DanceEvidence,
  danceRoutineLine,
  danceRulingOutcome,
  danceTermsText,
  DanceUpload,
  getRoutine,
  parseDanceRoutineLine,
  parseDanceTermsRoutine,
  parseRealtimeEvent,
  poseSha256,
  RealtimeEvent,
  Ruling,
  ROUTINES,
  routineSha256,
  Terms,
  TermsProposal,
} from '../src';
import {
  danceUploadPath,
  rematchPath,
  RematchResponse,
  suggestedRematchStakeUsd,
} from '../src/api';
import { DANCE_STAKES_USD, danceTermsArgs, DanceTermsRequest } from '../src/judge/dance-terms';
import { prefilterRefusal } from '../src/judge/guardrails';
import { mapProposeTermsArgs, PROPOSE_TERMS_BODY_SCHEMA } from '../src/judge/propose-terms';
import { DANCE_READBACK_TAIL, evaluateProposeTerms, readbackSay } from '../src/judge/reply';
import { TypedTermsRequest } from '../src/judge/typed-terms';
import { renderSignCard } from '../src/sign-card';
import { stageLineFor } from '../src/stage-voice';
import { lcg, makePlayer, seriesOf } from './dance-helpers';
import { rulingExample, skillTerms } from './fixtures';

/** The 15 s synthetic routine these hashed-text tests were written against. */
const R = getRoutine('wave-pop')!;

/** What the server's composeTerms makes of a dance proposal over the §2.5 base. */
function danceTerms(over: Record<string, unknown> = {}) {
  const text = danceTermsText(R, '5000000');
  return {
    ...skillTerms(),
    type: 'dance_off',
    claim: text.claim,
    performer: null,
    yes_party: 'A',
    attempts: { count: 1, rule: 'single' },
    success_criteria: text.success_criteria,
    failure_criteria: [],
    edge_cases: [],
    evidence_source: 'camera',
    market: null,
    stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
    ...over,
  };
}

const issuePaths = (input: unknown): string[] => {
  const r = Terms.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('Terms dance_off (§1)', () => {
  it('parses, hashes and names its routine in the text fields', () => {
    const { terms, terms_hash } = computeTermsHash(danceTerms());
    expect(terms.type).toBe('dance_off');
    expect(terms_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(terms.claim).toBe('Dance Off: Wave Pop, 15 seconds, higher match score wins, $5 each');
    expect(terms.success_criteria[0]).toBe(
      `Routine wave-pop v1 sha256:${routineSha256(R).slice(0, 16)}`,
    );
    expect(terms.success_criteria[1]).toBe(
      'Higher match score wins; scores within 2 points are too close to call (refund)',
    );
  });

  it('the three-way refinement: camera, no market, no performer, A is yes, single, even', () => {
    expect(issuePaths(danceTerms({ evidence_source: 'gemini' }))).toContain('evidence_source');
    expect(issuePaths(danceTerms({ performer: 'B' }))).toContain('performer');
    expect(issuePaths(danceTerms({ yes_party: 'B' }))).toContain('yes_party');
    expect(issuePaths(danceTerms({ attempts: { count: 3, rule: 'best_of' } }))).toContain(
      'attempts',
    );
    expect(
      issuePaths(danceTerms({ stakes: { a: '5000000', b: '2500000', currency: 'USDC' } })),
    ).toContain('stakes');
    expect(issuePaths(danceTerms({ type: 'dancing' }))).toContain('type');
  });

  it('skill and real_world rules are unchanged (the dance branch is separate)', () => {
    expect(issuePaths(skillTerms())).toEqual([]);
    expect(issuePaths({ ...skillTerms(), performer: null })).toContain('performer');
    expect(issuePaths({ ...danceTerms(), type: 'skill' })).toContain('performer');
  });

  it('parseDanceTermsRoutine verifies id, version and sha prefix against the registry', () => {
    const t = Terms.parse(danceTerms());
    const p = parseDanceTermsRoutine(t);
    expect(p.ok && p.routine).toBe(R);
    expect(p).toMatchObject({ ok: true, routine_id: 'wave-pop', version: 1 });
    const line = (s: string) => parseDanceTermsRoutine({ ...t, success_criteria: [s] });
    expect(line('Routine wave-pop v1 sha256:0000000000000000')).toEqual({
      ok: false,
      reason: 'sha_mismatch',
    });
    expect(line(danceRoutineLine(R).replace(' v1 ', ' v2 ')).ok).toBe(false);
    expect(line(danceRoutineLine(R).replace(' v1 ', ' v2 '))).toMatchObject({
      reason: 'version_mismatch',
    });
    expect(line('Routine moonwalk v1 sha256:0000000000000000')).toMatchObject({
      reason: 'unknown_routine',
    });
    expect(line('a routine')).toMatchObject({ reason: 'malformed' });
    expect(parseDanceTermsRoutine(Terms.parse(skillTerms()))).toMatchObject({
      reason: 'not_dance',
    });
    expect(parseDanceRoutineLine(danceRoutineLine(R))).toEqual({
      routine_id: 'wave-pop',
      version: 1,
      sha16: routineSha256(R).slice(0, 16),
    });
  });

  it('every routine claim is benign: no guardrail hit, category other (no odds prior)', () => {
    for (const r of ROUTINES) {
      const text = danceTermsText(r, '20000000');
      expect(prefilterRefusal({ ...text, edge_cases: [] }), `${r.id}: ${text.claim}`).toBeNull();
      expect(classifyChallenge(text)).toBe('other');
      expect(text.claim.length).toBeLessThanOrEqual(200);
    }
    expect(DANCE_RULE_LINE.length).toBeLessThanOrEqual(160);
  });
});

describe('the /terms/dance pipeline', () => {
  it('danceTermsArgs -> evaluateProposeTerms gives a complete even-money proposal', () => {
    expect([...DANCE_STAKES_USD]).toEqual([1, 5, 10, 20]);
    const req = DanceTermsRequest.parse({ routine_id: 'bounce-back', amount_usd: '$10' });
    const args = danceTermsArgs(req);
    expect(args).not.toBeNull();
    const ev = evaluateProposeTerms(args);
    expect(ev.kind).toBe('proposal');
    if (ev.kind !== 'proposal') return;
    expect(ev.missing).toEqual([]);
    const p: TermsProposal = ev.proposal;
    expect(p).toMatchObject({
      type: 'dance_off',
      performer: null,
      yes_party: 'A',
      evidence_source: 'camera',
      amount: '10000000',
      amount_b: null,
      market_query: null,
      edge_cases: [],
      failure_criteria: [],
    });
    expect(p.claim).toContain('Bounce Back');
    const say = readbackSay(p);
    expect(say.length).toBeLessThanOrEqual(200);
    expect(say.endsWith(DANCE_READBACK_TAIL)).toBe(true);
    expect(danceTermsArgs({ routine_id: 'moonwalk', amount_usd: '5' })).toBeNull();
    const bad = evaluateProposeTerms(
      danceTermsArgs({ routine_id: 'wave-pop', amount_usd: 'lots' }),
    );
    expect(bad.kind).toBe('issue');
    const big = evaluateProposeTerms(danceTermsArgs({ routine_id: 'wave-pop', amount_usd: '50' }));
    expect(big).toMatchObject({ kind: 'issue', issue: { code: 'STAKE_ABOVE_MAX' } });
  });

  it('cross rules catch a hand-made dance_off (performer, yes party, odds, routine line)', () => {
    const args = danceTermsArgs({ routine_id: 'wave-pop', amount_usd: '5' })!;
    const paths = (over: Record<string, unknown>) => {
      const m = mapProposeTermsArgs({ ...args, ...over });
      return m.ok ? [] : m.issues.map((i) => i.path);
    };
    expect(paths({})).toEqual([]);
    expect(paths({ performer: 'A' })).toContain('performer');
    expect(paths({ yes_party: 'B' })).toContain('yes_party');
    expect(paths({ stake_b_usd: '2' })).toContain('stake_b_usd');
    expect(paths({ success_criteria: ['Dance well.'] })).toContain('success_criteria');
  });

  it('a voice webhook body cannot propose a dance_off, even with a correct routine line', () => {
    const args = danceTermsArgs({ routine_id: 'wave-pop', amount_usd: '5' })!;
    const webhook = { conversation_id: 'conv_1', bet_id: 'bet_1', ...args };
    expect(evaluateProposeTerms(webhook)).toEqual({
      kind: 'invalid',
      issues: [{ path: 'type', message: 'dance_off only via /terms/dance' }],
    });
    expect(evaluateProposeTerms(webhook, { allowDanceOff: true }).kind).toBe('proposal');
    expect(evaluateProposeTerms(args, { allowDanceOff: false }).kind).toBe('invalid');
    expect(evaluateProposeTerms(args, { allowDanceOff: true }).kind).toBe('proposal');
  });

  it('the voice agent and the typed endpoint never offer dance_off', () => {
    expect(PROPOSE_TERMS_BODY_SCHEMA.properties.type.enum).toEqual(['skill', 'real_world']);
    expect(
      TypedTermsRequest.safeParse({ claim: 'x', amount_usd: '5', type: 'dance_off' }).success,
    ).toBe(false);
  });
});

describe('Ruling: undecidable for DANCE_OFF_MODEL (§5)', () => {
  const base = () => ({ ...(rulingExample() as Record<string, unknown>), confidence: 1 });
  it('VOID undecidable parses only with the dance-off model', () => {
    const voided = {
      ...base(),
      outcome: 'VOID',
      claim_result: 'UNCLEAR',
      void_reason: 'undecidable',
      cited_frames: [],
    };
    expect(Ruling.safeParse({ ...voided, model: DANCE_OFF_MODEL }).success).toBe(true);
    expect(Ruling.safeParse(voided).success).toBe(false);
    const won = { ...base(), model: DANCE_OFF_MODEL, outcome: 'A_WINS', claim_result: 'MET' };
    expect(Ruling.safeParse(won).success).toBe(true);
    expect(Ruling.safeParse({ ...base(), model: DANCE_OFF_MODEL, frame_hashes: [] }).success).toBe(
      false,
    );
  });

  it('danceRulingOutcome: a winner is decisive (MET <=> A), else VOID undecidable', () => {
    const e = { winner: 'A' as const, too_close: false, failed: null };
    expect(danceRulingOutcome(e, true)).toEqual({
      outcome: 'A_WINS',
      claim_result: 'MET',
      void_reason: null,
    });
    expect(danceRulingOutcome({ ...e, winner: 'B' }, true).outcome).toBe('B_WINS');
    expect(danceRulingOutcome(e, false).void_reason).toBe('undecidable');
    expect(danceRulingOutcome({ ...e, winner: null, too_close: true }, true).outcome).toBe('VOID');
    expect(danceRulingOutcome({ ...e, failed: 'coverage_a' }, true).outcome).toBe('VOID');
  });
});

describe('DanceEvidence, DanceUpload and dance.scored (§5)', () => {
  const rng = lcg(5);
  const a = makePlayer(R, { angleDeg: 8, lagMs: 200, jitter: 0.003, shiftX: -0.2 }, rng);
  const b = makePlayer(R, { stand: true, jitter: 0.003, shiftX: 0.2 }, rng);
  const series = seriesOf(R, a, b);
  const hex = (c: string) => c.repeat(64);
  const frames = [0, 1, 2, 3].map((index) => ({ index, t_ms: 3000 * index, sha256: hex('a') }));
  const built = buildDanceEvidence({
    bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
    attempt_no: 1,
    terms_hash: hex('b'),
    routine: R,
    series,
    frames,
    clip_sha256: null,
  });

  it('buildDanceEvidence re-scores and produces a strict, hashable record', () => {
    const e = built.evidence;
    expect(DanceEvidence.safeParse(e).success).toBe(true);
    expect(e.scores).toEqual({ a: built.result.a.score_x10, b: built.result.b.score_x10 });
    expect(e.winner).toBe('A');
    expect(e.routine).toEqual({ id: R.id, version: R.version, sha256: routineSha256(R) });
    expect(e.pose_sha256).toBe(poseSha256(series));
    expect(e.key_moves).toHaveLength(R.key_moves.length);
    expect(e.checks.side_swaps).toBe(0);
    expect(danceEvidenceHash(e)).toBe(danceEvidenceHash(DanceEvidence.parse(structuredClone(e))));
    expect(DanceEvidence.safeParse({ ...e, extra: 1 }).success).toBe(false);
    expect(DanceEvidence.safeParse({ ...e, frames: [] }).success).toBe(false);
    expect(DanceEvidence.safeParse({ ...e, scores: { a: 1001, b: 0 } }).success).toBe(false);
  });

  it('DanceUpload carries the series and up to 6 frames', () => {
    const up = {
      routine_id: R.id,
      routine_sha256: routineSha256(R),
      series,
      pose_sha256: poseSha256(series),
      client_scores: built.evidence.scores,
      clip_sha256: null,
      frames: frames.map((f) => ({ ...f, width: 288, height: 512, bytes: 40_000 })),
    };
    expect(DanceUpload.safeParse(up).success).toBe(true);
    const tooBig = { ...up, frames: up.frames.map((f) => ({ ...f, bytes: 200_001 })) };
    expect(DanceUpload.safeParse(tooBig).success).toBe(false);
    expect(danceUploadPath('x', 2)).toBe('/v1/bets/x/attempts/2/dance');
  });

  it('dance.scored envelope', () => {
    const ev = {
      v: 1,
      type: 'dance.scored',
      bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
      seq: 9,
      ts: '2026-11-21T18:07:04.512Z',
      source: 'server',
      payload: {
        evidence: built.evidence,
        evidence_hash: danceEvidenceHash(built.evidence),
        validation: { verdict: 'valid', notes: '', skipped: false },
        announcer_line: 'Logan owned that floor.',
      },
    };
    expect(parseRealtimeEvent(ev).ok).toBe(true);
    const skipped = { verdict: 'skipped', notes: 'timeout', skipped: true };
    expect(
      RealtimeEvent.safeParse({ ...ev, payload: { ...ev.payload, validation: skipped } }).success,
    ).toBe(true);
    const inconsistent = { verdict: 'valid', notes: '', skipped: true };
    expect(
      RealtimeEvent.safeParse({ ...ev, payload: { ...ev.payload, validation: inconsistent } })
        .success,
    ).toBe(false);
  });
});

describe('rematch (§7)', () => {
  it('bet.invited takes optional rematch_of and suggested_stake_usd', () => {
    const invited = {
      v: 1,
      type: 'bet.invited',
      bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
      seq: 0,
      ts: '2026-11-21T18:07:04.512Z',
      source: 'server',
      payload: {
        challenger: {
          user_id: '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73',
          pubkey: 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4',
          display_name: 'Logan',
          avatar_url: null,
        },
        room_id: '0b8e5d2c-9a41-4f37-b6e2-5c1d0a9f8e73',
        rematch_of: '3d6f0e1a-2b4c-4d8e-9f10-a1b2c3d4e5f6',
        suggested_stake_usd: 10,
      },
    };
    expect(RealtimeEvent.safeParse(invited).success).toBe(true);
    const { rematch_of: _r, suggested_stake_usd: _s, ...older } = invited.payload;
    expect(RealtimeEvent.safeParse({ ...invited, payload: older }).success).toBe(true);
  });

  it('suggests double the per-side stake, capped at max_stake', () => {
    expect(suggestedRematchStakeUsd({ a: '5000000', b: '5000000' })).toBe(10);
    expect(suggestedRematchStakeUsd({ a: '15000000', b: '15000000' })).toBe(20);
    expect(suggestedRematchStakeUsd({ a: '1500000', b: '500000' })).toBe(3);
    expect(suggestedRematchStakeUsd({ a: '100000', b: '100000' })).toBe(0.2);
    expect(rematchPath('b1')).toBe('/v1/bets/b1/rematch');
    const res = { bet_id: rulingExample().bet_id, suggested_stake_usd: 10 };
    expect(RematchResponse.safeParse(res).success).toBe(true);
  });
});

describe('stage voice and the sign card for a dance off', () => {
  const names = { A: 'Logan', B: 'Jake' };
  const ruling = (over: Record<string, unknown>) => ({
    ...(rulingExample() as Record<string, unknown>),
    model: DANCE_OFF_MODEL,
    ...over,
  });
  it('a decisive ruling is "<Winner> wins. <reason>"; a VOID speaks its reason', () => {
    const decisive = ruling({ outcome: 'A_WINS', reason: 'Logan hit every beat.' });
    const won = stageLineFor({ type: 'ruling.issued', payload: { ruling: decisive } }, names);
    expect(won?.text).toBe('Logan wins. Logan hit every beat.');
    const tie = stageLineFor(
      {
        type: 'ruling.issued',
        payload: {
          ruling: ruling({
            outcome: 'VOID',
            void_reason: 'undecidable',
            reason: 'Too close to call. 81.2 to 80.9',
          }),
        },
      },
      names,
    );
    expect(tie?.text).toBe("Too close to call. 81.2 to 80.9. It's void: both stakes go back.");
    const hearing = { ...ruling({ outcome: 'VOID', void_reason: 'undecidable' }), model: 'x/y' };
    const other = stageLineFor({ type: 'ruling.issued', payload: { ruling: hearing } }, names);
    expect(other?.text).toBe("I can't call this one. It's void: both stakes go back.");
  });

  it('the GG card: even stakes, no odds line', () => {
    const terms = Terms.parse(danceTerms());
    const card = renderSignCard({
      kind: 'concede',
      terms,
      terms_hash: computeTermsHash(terms).terms_hash,
      me: 'B',
      appeal_deadline: 1_795_284_435,
    });
    expect(card.odds_display).toBeNull();
    expect(card.stakes_line).toBe('$5');
    expect(card.pot_line).toBe('$10');
    expect(card.prompt_message).toBe('Pay Logan');
  });
});
