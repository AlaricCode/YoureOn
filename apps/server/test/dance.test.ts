/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// Dance Off on the server (docs/planning/DANCE-OFF.md §1, §5): POST …/terms/dance, the dance
// attempt rules (A's judge cam, else A's own phone; never B's), POST …/attempts/:n/dance
// (routine / pose / frame hash checks, the server's own re-score), the round check (./dance.ts:
// the mock LLM's default answer is VALID) and the deterministic ruling (winner -> decisive, too
// close / failed / invalid -> VOID 'undecidable'), dance.scored in the ruling's commit, and the
// appeal / review gate. The LLM is the offline MockLlm; DB-backed suites skip without
// DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { attempts, betEvents, bets, betTermsVersions, devices, rulings } from '@youre-on/db';
import { danceTermsPath, DanceTermsResponse, requestSigningString } from '@youre-on/shared/api';
import { ESCROW_ID, USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { buildDanceEvidence } from '@youre-on/shared/dance/evidence';
import { poseSha256, type PoseSeries } from '@youre-on/shared/dance/pose';
import { getRoutine, routineSha256 } from '@youre-on/shared/dance/routine';
import { scoreRound } from '@youre-on/shared/dance/score';
import { danceRoutineLine, danceTermsText } from '@youre-on/shared/dance/terms';
import { DANCE_FRAME_MAX_BYTES, DanceEvidence } from '@youre-on/shared/evidence';
import { hashJcs, jcs } from '@youre-on/shared/jcs';
import { sha256Hex } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import { DANCE_OFF_MODEL, Ruling } from '@youre-on/shared/ruling';
import { stageLineFor } from '@youre-on/shared/stage-voice';
import { computeTermsHash, type Terms } from '@youre-on/shared/terms';
import { issueAppSession } from '../src/auth/sessions';
import type { AppDeps } from '../src/context';
import { silentLogger } from '../src/log';
import {
  defaultMockResponder,
  MockLlm,
  type MockReply,
  type MockResponder,
} from '../src/providers/mock/llm';
import type { ChatRequest } from '../src/providers/types';
import { routeModules } from '../src/routes';
import { lockedInstruction } from '../src/bets/cues';
import { danceArmedCue, danceRulingCue } from '../src/judge/cues';
import {
  buildDanceParts,
  buildDanceRuling,
  callDanceValidator,
  cannedDanceLine,
  clipText,
  crownsName,
  DANCE_CACHED_MODEL,
  DANCE_SYSTEM_PROMPT,
  DANCE_TIMEOUT_MS,
  startingPlaces,
  type DanceCheck,
} from '../src/judge/dance';
import { isDanceOffBet } from '../src/judge/dance-bet';
import { noteDanceFaces } from '../src/judge/dance-faces';
import {
  createJudgeRoutes,
  DANCE_BODY_LIMIT,
  DANCE_MAX_MS,
  STUCK_JUDGING_MS,
} from '../src/judge/routes';
import { loadFinalTerms } from '../src/judge/terms';
import { createLifecycle, installLifecycle, type Lifecycle } from '../src/lock/runtime';
import { presentationOf } from '../src/lock/terms';
import { mkBetRow } from './chain-db';
import { betFacts } from './chain-fixtures';
import {
  b64url,
  describeDb,
  newKey,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
} from './helpers';

const H = (s: string) => sha256Hex(s);
const ROUTINE = getRoutine('wave-pop')!;
const OTHER = getRoutine('bounce-back')!;
const NAMES = { A: 'Logan', B: 'Jake' };

/**
 * A round over the routine's own frames: 'dance' copies the reference (self-score 100.0),
 * 'still' holds its first pose the whole time (≈ 0), 'gone' is never seen.
 */
function series(a: 'dance' | 'still', b: 'dance' | 'still' | 'gone'): PoseSeries {
  const first = ROUTINE.frames[0]!.k;
  return {
    schema_version: 1,
    w: ROUTINE.w,
    h: ROUTINE.h,
    fps_cap: 15,
    sync_offset_ms: 0,
    frames: ROUTINE.frames.map((f) => ({
      t: f.t,
      n: b === 'gone' ? 1 : 2,
      a: a === 'dance' ? [...f.k] : [...first],
      b: b === 'dance' ? [...f.k] : b === 'still' ? [...first] : null,
    })),
  };
}

function jpeg(i: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(64), i & 0xff, 0xff, 0xd9]);
}

/** A server-built DanceEvidence for the pure tests (A dances, B stands still: A wins). */
function evidenceOf(s: PoseSeries = series('dance', 'still')): DanceEvidence {
  return buildDanceEvidence({
    bet_id: randomUUID(),
    attempt_no: 1,
    terms_hash: H('terms'),
    routine: ROUTINE,
    series: s,
    frames: [0, 1, 2, 3].map((i) => ({ index: i, t_ms: 1000 + i * 3000, sha256: H(`f${i}`) })),
    clip_sha256: null,
  }).evidence;
}

const ctxOf = (e: DanceEvidence) => ({
  ruling_id: randomUUID(),
  bet_id: e.bet_id,
  attempt_no: 1,
  terms_hash: e.terms_hash,
  evidence_hash: hashJcs(e),
  frame_hashes: e.frames.map((f) => f.sha256),
  created_at: '2026-11-21T18:07:04.512Z',
});

const valid = (line = ''): DanceCheck => ({
  kind: 'checked',
  model: 'anthropic/mock/claude-sonnet-5-5',
  verdict: 'valid',
  notes: 'Both danced the whole round.',
  line,
});

// ---- pure ------------------------------------------------------------------------------

describe('buildDanceRuling (DANCE-OFF §5)', () => {
  it('a winner on a valid round is decisive: MET <=> A wins, confidence 1, the dance model', () => {
    const e = evidenceOf();
    expect(e).toMatchObject({ winner: 'A', too_close: false, failed: null });
    expect(e.scores.a).toBe(1000);
    const { ruling, validation, announcer_line } = buildDanceRuling(ctxOf(e), e, valid(), NAMES);
    expect(Ruling.safeParse(ruling).success).toBe(true);
    expect(ruling).toMatchObject({
      outcome: 'A_WINS',
      claim_result: 'MET',
      confidence: 1,
      model: DANCE_OFF_MODEL,
      stage: 'attempt',
      redo_reason: null,
      void_reason: null,
      evidence_hash: hashJcs(e),
      frame_hashes: e.frames.map((f) => f.sha256),
      cited_frames: [0, 1, 2, 3],
    });
    expect(validation).toEqual({
      verdict: 'valid',
      notes: 'Both danced the whole round.',
      skipped: false,
    });
    // the model line ('' here) -> the canned line, which names the winner
    expect(announcer_line).toBe(ruling.reason);
    expect(ruling.reason).toContain('Logan');
    expect(ruling.reason).toBe(cannedDanceLine(e, NAMES));

    const b = { ...e, winner: 'B' as const, scores: { a: 300, b: 820 } };
    const rb = buildDanceRuling(ctxOf(b), b, valid(), NAMES).ruling;
    expect(rb).toMatchObject({ outcome: 'B_WINS', claim_result: 'NOT_MET', confidence: 1 });
    expect(rb.reason).toMatch(/^Jake .* 82\.0 to 30\.0\./);
  });

  it("uses the model's line only when it names the winner", () => {
    const e = evidenceOf();
    const line = 'Logan  hit\nevery beat. Jake hit the snacks.';
    const good = buildDanceRuling(ctxOf(e), e, valid(line), NAMES);
    expect(good.ruling.reason).toBe('Logan hit every beat. Jake hit the snacks.');
    const wrong = buildDanceRuling(ctxOf(e), e, valid('Jake takes the crown tonight!'), NAMES);
    expect(wrong.ruling.reason).toBe(cannedDanceLine(e, NAMES));
    // names the winner, but crowns the loser: the canned line, never a contradiction
    for (const l of ['Logan tried, but Jake wins this one!', 'Logan who? JAKE is the champion'])
      expect(buildDanceRuling(ctxOf(e), e, valid(l), NAMES).ruling.reason).toBe(
        cannedDanceLine(e, NAMES),
      );
    const ok = buildDanceRuling(ctxOf(e), e, valid('Logan wins it! Jake, nice try.'), NAMES);
    expect(ok.ruling.reason).toBe('Logan wins it! Jake, nice try.');
    expect(crownsName('Logan hit every beat. Jake hit the snacks.', 'Jake')).toBe(false);
    expect(crownsName('Jakes winning streak', 'Jake')).toBe(false);
    const long = buildDanceRuling(ctxOf(e), e, valid(`Logan ${'la '.repeat(200)}`), NAMES);
    expect(long.ruling.reason.length).toBeLessThanOrEqual(280);
  });

  it("too close to call is VOID 'undecidable' with a Too close to call line", () => {
    const e = evidenceOf(series('dance', 'dance'));
    expect(e).toMatchObject({ winner: null, too_close: true, failed: null });
    const r = buildDanceRuling(ctxOf(e), e, valid('Logan wins by a toe!'), NAMES).ruling;
    expect(Ruling.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({
      outcome: 'VOID',
      claim_result: 'UNCLEAR',
      void_reason: 'undecidable',
      redo_reason: null,
      confidence: 1,
      cited_frames: [],
    });
    expect(r.reason).toBe('Too close to call: 100.0 to 100.0.');
    const fromModel = buildDanceRuling(
      ctxOf(e),
      e,
      valid('Too close to call! Two dancing machines, one floor.'),
      NAMES,
    ).ruling;
    expect(fromModel.reason).toBe('Too close to call! Two dancing machines, one floor.');
    // the stage says the reason, then the refund
    expect(
      stageLineFor({ type: 'ruling.issued', payload: { ruling: r } }, { A: 'Logan', B: 'Jake' })!
        .text,
    ).toBe("Too close to call: 100.0 to 100.0. It's void: both stakes go back.");
  });

  it('a failed round (a dancer lost) is VOID too, and names who', () => {
    const e = evidenceOf(series('dance', 'gone'));
    expect(e.failed).toBe('coverage_b');
    const r = buildDanceRuling(ctxOf(e), e, valid(), NAMES).ruling;
    expect(r).toMatchObject({ outcome: 'VOID', void_reason: 'undecidable' });
    expect(r.reason).toBe('Too close to call: the camera lost Jake for too long.');
  });

  it("an INVALID round is VOID 'undecidable' and the reason names the problem", () => {
    const e = evidenceOf();
    const check: DanceCheck = {
      kind: 'checked',
      model: 'anthropic/x',
      verdict: 'invalid',
      notes: 'A third person danced in for Jake.',
      line: 'Logan wins!',
    };
    const d = buildDanceRuling(ctxOf(e), e, check, NAMES);
    expect(d.ruling).toMatchObject({ outcome: 'VOID', void_reason: 'undecidable' });
    expect(d.ruling.reason).toBe("This round doesn't count: A third person danced in for Jake.");
    expect(d.validation).toMatchObject({ verdict: 'invalid', skipped: false });
  });

  it('a skipped check settles on the score with the canned line', () => {
    const e = evidenceOf();
    const skipped: DanceCheck = {
      kind: 'skipped',
      model: 'anthropic/x',
      status: 'timeout',
      message: 'deadline',
    };
    const d = buildDanceRuling(ctxOf(e), e, skipped, NAMES);
    expect(d.ruling.outcome).toBe('A_WINS');
    expect(d.ruling.reason).toBe(cannedDanceLine(e, NAMES));
    expect(d.validation).toMatchObject({ verdict: 'skipped', skipped: true });
  });

  it('clipText: NFC, single spaces, no controls, cut at a code point', () => {
    expect(clipText('  a\u0085b\n\nc  ', 280)).toBe('a b c');
    expect(clipText('😀😀😀', 5)).toBe('😀😀');
    expect(clipText('\uD800x', 10)).toBe('x');
  });
});

describe('the round check (callDanceValidator)', () => {
  const deps = (llm: MockLlm, env: Record<string, string> = {}) =>
    ({ env: testEnv(env), providers: { llm }, log: silentLogger }) as unknown as Pick<
      AppDeps,
      'env' | 'providers' | 'log'
    >;
  const input = () => ({
    terms: danceTermsText(ROUTINE, '5000000'),
    names: NAMES,
    evidence: evidenceOf(),
    frames: [0, 1, 2, 3].map((i) => ({ t_ms: 1000 + i * 3000, bytes: jpeg(i) })),
  });

  it("the mock LLM's default answer is the happy path (VALID)", async () => {
    const llm = new MockLlm(defaultMockResponder);
    const c = await callDanceValidator(deps(llm), input());
    expect(c).toMatchObject({ kind: 'checked', verdict: 'valid' });
    const call = llm.calls.at(-1)! as ChatRequest<unknown>;
    expect(call).toMatchObject({ vendor: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' });
    expect(call.system).toBe(DANCE_SYSTEM_PROMPT);
    expect(call.timeoutMs).toBe(DANCE_TIMEOUT_MS);
    expect(DANCE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    expect(call.parts.filter((p) => p.kind === 'image')).toHaveLength(4);
  });

  it('cached_ruling: a canned VALID check, no model call', async () => {
    const llm = new MockLlm(defaultMockResponder);
    const c = await callDanceValidator(deps(llm, { CACHED_RULING: 'true' }), input());
    expect(c).toMatchObject({ kind: 'checked', verdict: 'valid', model: DANCE_CACHED_MODEL });
    expect(llm.calls).toHaveLength(0);
  });

  it('a timeout or bad JSON is a skipped check (never throws)', async () => {
    const timeout = await callDanceValidator(
      deps(new MockLlm(() => ({ fail: 'timeout' }))),
      input(),
    );
    expect(timeout).toMatchObject({ kind: 'skipped', status: 'timeout' });
    const junk = await callDanceValidator(deps(new MockLlm(() => ({ text: 'nope' }))), input());
    expect(junk.kind).toBe('skipped');
  });

  it('the prompt carries the terms (cached), both scores, the moves and the checks', () => {
    const parts = buildDanceParts(input());
    expect(parts[0]).toMatchObject({ kind: 'text', cache: true });
    const text = parts.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n');
    expect(text).toContain(danceRoutineLine(ROUTINE));
    expect(text).toContain('Logan (A) 100.0');
    expect(text).toContain('Logan (A) wins');
    expect(text).toContain('Side swaps');
    expect(text).toContain(
      'Starting places: Logan (A) on the LEFT of the picture, Jake (B) on the RIGHT',
    );
    expect(text).toContain('Frame 1/4 at t=1.00s:');
    expect(DANCE_SYSTEM_PROMPT).toMatch(/NEVER decide/);
    expect(DANCE_SYSTEM_PROMPT).toMatch(/family friendly/);
  });

  it('a face-identified round whose A started on the right says so (no left/right in the terms)', () => {
    const e = evidenceOf();
    const flipped = { ...e, checks: { ...e.checks, a_start_side: 'right' as const } };
    expect(DanceEvidence.safeParse(flipped).success).toBe(true);
    expect(startingPlaces(flipped, NAMES)).toBe(
      '- Starting places: Logan (A) on the RIGHT of the picture, Jake (B) on the LEFT (both recognized by face)',
    );
    const parts = buildDanceParts({ ...input(), evidence: flipped });
    expect((parts[0] as { text: string }).text).not.toMatch(/LEFT|RIGHT/);
    expect(DANCE_SYSTEM_PROMPT).toMatch(/A may start on the RIGHT/);
  });
});

describe('dance cues', () => {
  it('RULING reads the line and asks for GG (no "check it again"); VOIDED says why', () => {
    const e = evidenceOf();
    const won = buildDanceRuling(ctxOf(e), e, valid(), NAMES).ruling;
    const c = danceRulingCue(won, e.scores, null, NAMES, 10);
    expect(c.cue).toBe('RULING');
    expect(c.text).toMatch(/^\[EVENT\] RULING outcome=A_WINS winner=Logan score=100\.0-/);
    expect(c.text).toMatch(/tell Jake to tap GG\.$/);
    expect(c.text).not.toMatch(/check it again/i);

    const tie = evidenceOf(series('dance', 'dance'));
    const v = buildDanceRuling(ctxOf(tie), tie, valid(), NAMES).ruling;
    const vc = danceRulingCue(v, tie.scores, 'too_close', NAMES, 10);
    expect(vc.text).toMatch(/^\[EVENT\] VOIDED reason=undecidable why=too_close :: /);
    expect(vc.text).toMatch(/too close to call/);
    expect(vc.text).not.toMatch(/three tries|check it again/i);
    expect(danceRulingCue(v, tie.scores, 'invalid', NAMES, 10).text).toMatch(/doesn't count/);
    expect(danceArmedCue(1, NAMES)).toMatchObject({ cue: 'ATTEMPT_ARMED', speak: false });
  });

  it("the LOCKED cue never tells the voice judge to start a dance off (the phone's Start does)", () => {
    const dance = lockedInstruction('dance_off', NAMES);
    expect(dance).toMatch(/Logan and Jake to get in frame for the dance off/);
    expect(dance).toMatch(/Do not call request_attempt\.$/);
    expect(dance).not.toMatch(/attempt_no/);
    expect(lockedInstruction('skill', NAMES)).toMatch(/call request_attempt with attempt_no 1\.$/);
    expect(lockedInstruction(undefined, NAMES)).toMatch(/call request_attempt with attempt_no 1/);
  });
});

describe('dance terms presentation', () => {
  it('the card is titled by the routine', () => {
    const t = danceTermsText(ROUTINE, '5000000');
    const { terms } = computeTermsHash({
      schema_version: 1,
      bet_id: randomUUID(),
      escrow: { cluster: 'devnet', program_id: ESCROW_ID, mint: USDC_MINT_DEVNET },
      party_a: { pubkey: newKey().pubkey, display_name: 'Logan' },
      party_b: { pubkey: newKey().pubkey, display_name: 'Jake' },
      type: 'dance_off',
      claim: t.claim,
      performer: null,
      yes_party: 'A',
      attempts: { count: 1, rule: 'single' },
      success_criteria: [...t.success_criteria],
      failure_criteria: [],
      edge_cases: [],
      evidence_source: 'camera',
      market: null,
      stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
      deadline: '2026-11-21T18:20:00.000Z',
      created_at: '2026-11-21T18:10:00.000Z',
    });
    const p = presentationOf(terms);
    expect(p).toMatchObject({
      title: 'Dance Off: Wave Pop',
      stakes_display: '$5 each',
      odds_display: null,
    });
  });
});

// ---- POST /v1/bets/:id/terms/dance -----------------------------------------------------

describeDb('dance terms: POST /v1/bets/:id/terms/dance (DB)', () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startTestServer({ env: { MAX_STAKE_MICRO: '20000000' } });
  });
  afterAll(async () => {
    await ctx?.server.close();
  });
  const post = (u: SignedUp, path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };

  async function newBet() {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const room = await post(A, '/v1/rooms', { name: 'Dance', kind: 'session' });
    expect((await post(B, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const bet = await post(A, '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(bet.status).toBe(201);
    return { A, B, betId: bet.json!.bet.bet_id as string };
  }

  it('A picks a routine and a stake -> TERMS_PROPOSED with the routine bound into the hash', async () => {
    const { A, betId } = await newBet();
    const r = await post(A, danceTermsPath(betId), { routine_id: 'wave-pop', amount_usd: '5' });
    expect(r.status).toBe(200);
    const body = DanceTermsResponse.parse(r.json);
    expect(body).toMatchObject({ ok: true, kind: 'proposed', state: 'TERMS_PROPOSED' });
    const [row] = await ctx.deps.db.select().from(bets).where(eq(bets.id, betId));
    expect(row).toMatchObject({
      state: 'TERMS_PROPOSED',
      stake_a: 5_000_000n,
      stake_b: 5_000_000n,
      evidence_source: 'camera',
      title: 'Dance Off: Wave Pop',
    });
    const [v] = await ctx.deps.db
      .select()
      .from(betTermsVersions)
      .where(eq(betTermsVersions.bet_id, betId));
    expect(v).toMatchObject({ drafted_by: 'party_a', source_tool: 'dance' });
    const terms = JSON.parse(v!.canonical_json) as Terms;
    expect(terms).toMatchObject({
      type: 'dance_off',
      performer: null,
      yes_party: 'A',
      attempts: { count: 1, rule: 'single' },
      edge_cases: [],
      failure_criteria: [],
      market: null,
      stakes: { a: '5000000', b: '5000000' },
    });
    expect(terms.success_criteria[0]).toBe(danceRoutineLine(ROUTINE));
    expect(terms.claim).toBe(danceTermsText(ROUTINE, '5000000').claim);
    // even money: no odds offer
    const types = (
      await ctx.deps.db.select().from(betEvents).where(eq(betEvents.bet_id, betId))
    ).map((e) => e.type);
    expect(types).toContain('terms.proposed');
    expect(types.filter((t) => t.startsWith('odds.'))).toEqual([]);
  });

  it('unknown routine 404, bad amount 422, over the cap is a draft, B is refused', async () => {
    const { A, B, betId } = await newBet();
    const unknown = await post(A, danceTermsPath(betId), {
      routine_id: 'moonwalk',
      amount_usd: '5',
    });
    expect(unknown.status).toBe(404);
    expect(unknown.json!.error.details.routines).toEqual([
      'bye-bye-shuffle',
      'wave-pop',
      'bounce-back',
    ]);
    expect(
      (await post(A, danceTermsPath(betId), { routine_id: 'wave-pop', amount_usd: 'lots' })).status,
    ).toBe(422);
    const over = await post(A, danceTermsPath(betId), { routine_id: 'wave-pop', amount_usd: '50' });
    expect(over.json).toMatchObject({ ok: false, kind: 'draft' });
    const asB = await post(B, danceTermsPath(betId), { routine_id: 'wave-pop', amount_usd: '5' });
    expect(asB.json!.error.code).toBe('NOT_A_PARTY');
    const [row] = await ctx.deps.db.select().from(bets).where(eq(bets.id, betId));
    expect(row!.state).toBe('DRAFTING');
  });
});

// ---- the judge pipeline ----------------------------------------------------------------

describeDb('dance judge pipeline (DB)', () => {
  let ctx: Ctx;
  let lc: Lifecycle;
  const termsByBet = new Map<string, Terms>();
  const judge = createJudgeRoutes({
    loadTerms: async (db, bet) => termsByBet.get(bet.id) ?? loadFinalTerms(db, bet),
  });
  const modules = routeModules.map((m) => (m.name === 'judge' ? judge : m));
  let llm: MockLlm;
  let replies: MockReply[] = [];
  let hook: MockResponder | null = null;
  const ruled: { betId: string; ruling: Ruling }[] = [];

  let A: SignedUp;
  let B: SignedUp;
  let CAM: SignedUp; // A's second device
  let roomId: string;
  const uid = (u: SignedUp) => u.session.user.user_id;

  const signed = (u: SignedUp, method: string, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method,
      headers: signedHeaders(u, method, path, raw),
      body: raw || undefined,
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };
  const post = (u: SignedUp, path: string, body?: unknown) => signed(u, 'POST', path, body);

  beforeAll(async () => {
    ctx = await startTestServer({ modules });
    llm = new MockLlm((req) => hook?.(req) ?? replies.shift() ?? defaultMockResponder(req));
    ctx.deps.providers.llm = llm;
    lc = installLifecycle(
      ctx.deps,
      createLifecycle(ctx.deps, { runtime: async () => null, timers: false }),
    );
    ctx.deps.onRuling = (betId, ruling) => {
      ruled.push({ betId, ruling });
    };
    A = await signUp(ctx.base, 'Logan');
    B = await signUp(ctx.base, 'Jake');
    const r = await post(A, '/v1/rooms', { name: 'Dance floor', kind: 'session' });
    roomId = r.json!.room_id;
    expect((await post(B, '/v1/rooms/join', { code: r.json!.code })).status).toBe(200);
    const camKey = newKey();
    const [dev] = await ctx.deps.db
      .insert(devices)
      .values({ user_id: uid(A), device_pubkey: camKey.pubkey })
      .returning({ id: devices.id });
    const s = await issueAppSession(ctx.deps.db, {
      user_id: uid(A),
      device_id: dev!.id,
      now: Date.now(),
    });
    CAM = {
      device: camKey,
      wallet: A.wallet,
      session: { ...A.session, token: s.token, session_id: s.session_id, device_id: dev!.id },
    };
  });
  afterAll(async () => {
    await judge.idle();
    lc?.stop();
    await ctx?.server.close();
  });

  /** A dance off A vs B on `routine` (`over`: other terms fields), frozen + LOCKED in the DB. */
  async function lockedDance(
    routine = ROUTINE,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const created = await post(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'list',
    });
    expect(created.status).toBe(201);
    const betId: string = created.json!.bet.bet_id;
    const now = new Date();
    const deadline = new Date(Math.ceil(now.getTime() / 1000) * 1000 + 3600_000);
    const t = danceTermsText(routine, '5000000');
    const { terms, terms_hash } = computeTermsHash({
      schema_version: 1,
      bet_id: betId,
      escrow: { cluster: 'devnet', program_id: ESCROW_ID, mint: USDC_MINT_DEVNET },
      party_a: { pubkey: A.wallet.pubkey, display_name: 'Logan' },
      party_b: { pubkey: B.wallet.pubkey, display_name: 'Jake' },
      type: 'dance_off',
      claim: t.claim,
      performer: null,
      yes_party: 'A',
      attempts: { count: 1, rule: 'single' },
      success_criteria: [...t.success_criteria],
      failure_criteria: [],
      edge_cases: [],
      evidence_source: 'camera',
      market: null,
      stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
      deadline: deadline.toISOString(),
      created_at: now.toISOString(),
      ...over,
    });
    termsByBet.set(betId, terms);
    await ctx.deps.db
      .update(bets)
      .set({
        state: 'LOCKED',
        terms_hash,
        stake_a: 5_000_000n,
        stake_b: 5_000_000n,
        evidence_source: 'camera',
        party_a_wallet: A.wallet.pubkey,
        party_b_wallet: B.wallet.pubkey,
        a_authorized_at: now,
        b_authorized_at: now,
        a_authorization_method: 'faceid_hold',
        b_authorization_method: 'faceid_hold',
        onchain_status: 'locked',
        locked_at: now,
      })
      .where(eq(bets.id, betId));
    return betId;
  }

  async function unbindCam() {
    await ctx.deps.db
      .update(devices)
      .set({ role: 'phone', judge_room_id: null })
      .where(eq(devices.id, CAM.session.device_id));
  }

  /** Signed multipart dance upload; the overrides break one check each. */
  async function uploadDance(
    u: SignedUp,
    betId: string,
    attemptNo: number,
    o: {
      series?: PoseSeries;
      poseSha?: string;
      routine?: { id: string; sha: string };
      frames?: Uint8Array[];
      tamper?: number;
      /** The bet's routine (default ROUTINE): local score and the routine id / hash. */
      of?: typeof ROUTINE;
    } = {},
  ) {
    const s = o.series ?? series('dance', 'still');
    const R = o.of ?? ROUTINE;
    const local = scoreRound(R, s);
    const frames = o.frames ?? [0, 1, 2, 3].map((i) => jpeg(i));
    const upload = {
      routine_id: o.routine?.id ?? R.id,
      routine_sha256: o.routine?.sha ?? routineSha256(R),
      series: s,
      pose_sha256: o.poseSha ?? poseSha256(s),
      client_scores: { a: local.a.score_x10, b: local.b.score_x10 },
      clip_sha256: null,
      frames: frames.map((f, i) => ({
        index: i,
        t_ms: 1000 + i * 3000,
        sha256: sha256Hex(f),
        width: 288,
        height: 512,
        bytes: f.length,
      })),
    };
    const form = new FormData();
    form.append('upload', new Blob([JSON.stringify(upload)], { type: 'application/json' }));
    frames.forEach((f, i) => {
      const bytes = i === o.tamper ? jpeg(99) : f;
      form.append(
        'frame',
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
        `${i}.jpg`,
      );
    });
    const req = new Request('http://x/', { method: 'POST', body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    expect(body.length).toBeLessThan(DANCE_BODY_LIMIT);
    const path = `/v1/bets/${betId}/attempts/${attemptNo}/dance`;
    const ts = String(Date.now());
    const idem = randomUUID();
    const sig = u.device.sign(
      requestSigningString({
        method: 'POST',
        path_and_query: path,
        timestamp_ms: ts,
        idempotency_key: idem,
        session_id: u.session.session_id,
        body_sha256_hex: sha256Hex(body),
      }),
    );
    const res = await fetch(ctx.base + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.session.token}`,
        'X-YO-Device': u.session.device_id,
        'X-YO-Timestamp': ts,
        'Idempotency-Key': idem,
        'X-YO-Signature': b64url(sig),
        'Content-Type': req.headers.get('content-type')!,
      },
      body,
    });
    const text = await res.text();
    return {
      status: res.status,
      json: text ? (JSON.parse(text) as Record<string, any>) : null,
      frames,
      upload,
    };
  }

  const betRow = async (id: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, id)).limit(1))[0]!;
  const events = async (id: string) =>
    (
      await ctx.deps.db
        .select()
        .from(betEvents)
        .where(eq(betEvents.bet_id, id))
        .orderBy(asc(betEvents.seq))
    ).map((e) => e.envelope as any);
  const rulingRows = async (id: string) =>
    ctx.deps.db
      .select()
      .from(rulings)
      .where(eq(rulings.bet_id, id))
      .orderBy(asc(rulings.created_at));
  const invalid: MockReply = {
    value: {
      verdict: 'invalid',
      danced_full_time: true,
      nobody_left: false,
      no_third_person: true,
      no_side_swap: true,
      notes: 'Jake walked out of the picture halfway.',
      announcer_line: 'Logan wins by default!',
    },
  };

  it("A's phone records itself (B's never does): max_ms 30 s, attempt.started names A", async () => {
    await unbindCam();
    const betId = await lockedDance();
    // B dances too and would upload the whole PoseSeries: B's phone never records a dance off
    const asB = await post(B, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' });
    expect(asB.status).toBe(403);
    expect(asB.json!.error).toMatchObject({
      code: 'NOT_A_PARTY',
      details: { reason: 'recorder_is_a' },
    });
    expect((await betRow(betId)).state).toBe('LOCKED');
    const r = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      attempt_no: 1,
      performer: 'A',
      recorder_device_id: A.session.device_id,
      max_ms: DANCE_MAX_MS,
    });
    const started = (await events(betId)).find((e) => e.type === 'attempt.started');
    expect(parseRealtimeEvent(started).ok).toBe(true);
    const cue = (await events(betId)).find((e) => e.type === 'judge.cue');
    expect(cue.payload).toMatchObject({ cue: 'ATTEMPT_ARMED', speak: false });
  });

  it("A's judge cam (A's own second device) films the dance; no phone records over it", async () => {
    const bound = await signed(CAM, 'PATCH', '/v1/devices/current', {
      role: 'judge_cam',
      room_id: roomId,
    });
    expect(bound.status).toBe(204);
    try {
      const betId = await lockedDance();
      // with a judge cam in the room, A's phone can't film the round itself
      const self = await post(A, `/v1/bets/${betId}/attempts`, {
        attempt_no: 1,
        recorder: 'self',
      });
      expect(self.status).toBe(409);
      expect(self.json!.error).toMatchObject({
        code: 'INVALID_STATE',
        details: { reason: 'judge_cam_present' },
      });
      expect((await betRow(betId)).state).toBe('LOCKED');
      const r = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 });
      expect(r.status).toBe(201);
      expect(r.json!.recorder_device_id).toBe(CAM.session.device_id);
      expect((await uploadDance(A, betId, 1)).status).toBe(403); // only the recorder uploads
      expect((await uploadDance(CAM, betId, 1)).status).toBe(202);
      await judge.idle();
      expect((await rulingRows(betId)).map((x) => x.outcome)).toEqual(['A_WINS']);
    } finally {
      await unbindCam();
    }
  });

  it('a judge cam B binds to the room never films a dance off (A films it)', async () => {
    await unbindCam();
    const [bCam] = await ctx.deps.db
      .insert(devices)
      .values({
        user_id: uid(B),
        device_pubkey: newKey().pubkey,
        role: 'judge_cam',
        judge_room_id: roomId,
      })
      .returning({ id: devices.id });
    try {
      const betId = await lockedDance();
      const cam = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1 });
      expect(cam.status).toBe(409);
      expect(cam.json!.error).toMatchObject({
        code: 'INVALID_STATE',
        details: { reason: 'no_judge_cam' },
      });
      const r = await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' });
      expect(r.status).toBe(201);
      expect(r.json!.recorder_device_id).toBe(A.session.device_id);
    } finally {
      await ctx.deps.db
        .update(devices)
        .set({ role: 'phone', judge_room_id: null })
        .where(eq(devices.id, bCam!.id));
    }
  });

  it('A on the right is a side swap unless this server identified both by face', async () => {
    await unbindCam();
    /** A dances on the right of the picture, B stands on the left. */
    const shift = (k: number[], dx: number) =>
      k.map((v, i) => (i % 3 === 0 ? Math.max(0, Math.min(10_000, v + dx)) : v));
    const base = series('dance', 'still');
    const aRight: PoseSeries = {
      ...base,
      frames: base.frames.map((f) => ({ ...f, a: shift(f.a!, 1_500), b: shift(f.b!, -1_500) })),
    };
    const stored = async (byFace: boolean) => {
      const betId = await lockedDance();
      if (byFace) noteDanceFaces(ctx.deps, betId, true);
      expect(
        (await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' })).status,
      ).toBe(201);
      expect((await uploadDance(A, betId, 1, { series: aRight })).status).toBe(202);
      await judge.idle();
      const [att] = await ctx.deps.db.select().from(attempts).where(eq(attempts.bet_id, betId));
      return DanceEvidence.parse(JSON.parse(att!.evidence_canonical!));
    };
    const plain = await stored(false);
    expect(plain.checks.side_swaps).toBe(1);
    expect('a_start_side' in plain.checks).toBe(false);
    const byFace = await stored(true);
    expect(byFace.checks).toMatchObject({ side_swaps: 0, a_start_side: 'right' });
  });

  it('upload -> re-scored DanceEvidence -> JUDGING -> dance.scored + ruling.issued + judge.cue', async () => {
    await unbindCam();
    const betId = await lockedDance();
    expect(
      (await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' })).status,
    ).toBe(201);
    replies = [];
    const calls0 = llm.calls.length;
    const up = await uploadDance(A, betId, 1);
    expect(up.status).toBe(202);
    const hashes = up.frames.map((f) => sha256Hex(f));
    expect(up.json).toMatchObject({
      judging: true,
      pose_sha256: up.upload.pose_sha256,
      scores: up.upload.client_scores,
      client_mismatch: false,
      frame_hashes: hashes,
    });
    expect(up.json!.scores.a).toBe(1000);
    await judge.idle();

    const [att] = await ctx.deps.db.select().from(attempts).where(eq(attempts.bet_id, betId));
    const stored = DanceEvidence.parse(JSON.parse(att!.evidence_canonical!));
    expect(stored).toMatchObject({
      kind: 'dance',
      bet_id: betId,
      routine: { id: ROUTINE.id, version: ROUTINE.version, sha256: routineSha256(ROUTINE) },
      scorer_version: 'dance-score@1',
      winner: 'A',
      clip_sha256: null,
    });
    expect(att!.evidence_canonical).toBe(jcs(stored));
    expect(up.json!.evidence_hash).toBe(hashJcs(stored));
    expect(att).toMatchObject({ status: 'ruled', frame_hashes: hashes });
    expect(att!.client_clip_hash).toBe(hashJcs(stored)); // the stand-in (no clip kept)

    const [row] = await rulingRows(betId);
    expect(row).toMatchObject({
      outcome: 'A_WINS',
      claim_result: 'MET',
      model: DANCE_OFF_MODEL,
      confidence: '1.00',
      evidence_kind: 'camera',
      evidence_hash: hashJcs(stored),
      evidence_canonical: att!.evidence_canonical,
      frame_hashes: hashes,
    });
    expect(sha256Hex(row!.evidence_canonical!)).toBe(row!.evidence_hash);
    const ruling = Ruling.parse(JSON.parse(row!.record_canonical));
    expect(ruled.filter((x) => x.betId === betId).map((x) => x.ruling)).toEqual([ruling]);

    // one round check: the configured model, the 4 key frames, under the 10 s cap
    expect(llm.calls.length - calls0).toBe(1);
    const call = llm.calls.at(-1)! as ChatRequest<unknown>;
    expect(call.system).toBe(DANCE_SYSTEM_PROMPT);
    expect(call.parts.filter((p) => p.kind === 'image')).toHaveLength(4);
    expect(DANCE_TIMEOUT_MS + 2_000).toBeLessThan(STUCK_JUDGING_MS);

    const evs = await events(betId);
    expect(evs.slice(-4).map((e) => e.type)).toEqual([
      'bet.state',
      'dance.scored',
      'ruling.issued',
      'judge.cue',
    ]);
    for (const e of evs.slice(-4)) expect(parseRealtimeEvent(e).ok).toBe(true);
    const scored = evs.at(-3)!.payload;
    expect(scored).toMatchObject({
      evidence_hash: hashJcs(stored),
      validation: { verdict: 'valid', skipped: false },
      announcer_line: ruling.reason,
    });
    expect(evs.at(-1)!.payload.text).toMatch(/^\[EVENT\] RULING outcome=A_WINS winner=Logan /);
    expect(evs.at(-1)!.payload.text).not.toMatch(/check it again/);
    expect((await betRow(betId)).state).toBe('JUDGING'); // RULED comes with resolve (payout)

    // the same round replays the 202; another is refused; nothing is ruled twice
    const replay = await uploadDance(A, betId, 1, { frames: up.frames });
    expect(replay.status).toBe(202);
    expect(replay.json!.evidence_hash).toBe(up.json!.evidence_hash);
    const other = await uploadDance(A, betId, 1, { series: series('still', 'still') });
    expect(other.json!.error.code).toBe('ATTEMPT_NOT_OPEN');
    await judge.idle();
    expect(await rulingRows(betId)).toHaveLength(1);

    // the dance ruling's bet is a dance off for the appeal / review gate
    expect(await isDanceOffBet(ctx.deps.db, betId)).toBe(true);
    // no slow-mo replay for a dance round (no_frames, not a 500)
    const rep = await fetch(`${ctx.base}/v1/bets/${betId}/replay`, {
      headers: { Authorization: `Bearer ${A.session.token}` },
    });
    expect(rep.status).toBe(200);
    expect(await rep.json()).toMatchObject({ replay: null });
  });

  it('bad pose hash, a tampered frame and the wrong routine are refused; nothing is stored', async () => {
    await unbindCam();
    const betId = await lockedDance();
    expect(
      (await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' })).status,
    ).toBe(201);
    const pose = await uploadDance(A, betId, 1, { poseSha: H('not the series') });
    expect(pose.status).toBe(422);
    expect(pose.json!.error).toMatchObject({
      code: 'EVIDENCE_HASH_MISMATCH',
      details: { what: 'pose' },
    });
    const frame = await uploadDance(A, betId, 1, { tamper: 2 });
    expect(frame.json!.error).toMatchObject({ code: 'FRAME_HASH_MISMATCH', details: { index: 2 } });
    const wrong = await uploadDance(A, betId, 1, {
      routine: { id: OTHER.id, sha: routineSha256(OTHER) },
    });
    expect(wrong.status).toBe(422);
    expect(wrong.json!.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'wrong_routine' },
    });
    const wrongSha = await uploadDance(A, betId, 1, {
      routine: { id: ROUTINE.id, sha: H('another take') },
    });
    expect(wrongSha.json!.error.details.reason).toBe('wrong_routine');
    expect((await uploadDance(B, betId, 1)).status).toBe(403); // not the recorder
    expect((await betRow(betId)).state).toBe('ATTEMPT');
    expect(await rulingRows(betId)).toEqual([]);
    // and the good round still goes in
    expect((await uploadDance(A, betId, 1)).status).toBe(202);
    await judge.idle();
  });

  it("too close to call -> VOID 'undecidable'; an INVALID round -> VOID; a failed check settles", async () => {
    await unbindCam();
    const tie = await lockedDance();
    await post(A, `/v1/bets/${tie}/attempts`, { attempt_no: 1, recorder: 'self' });
    expect((await uploadDance(A, tie, 1, { series: series('dance', 'dance') })).status).toBe(202);
    await judge.idle();
    const [t] = await rulingRows(tie);
    expect(t).toMatchObject({
      outcome: 'VOID',
      void_reason: 'undecidable',
      model: DANCE_OFF_MODEL,
    });
    expect(t!.reason).toMatch(/^Too close to call/);
    const tieCue = (await events(tie)).at(-1)!;
    expect(tieCue.payload.text).toMatch(/^\[EVENT\] VOIDED reason=undecidable why=too_close/);

    const bad = await lockedDance();
    await post(A, `/v1/bets/${bad}/attempts`, { attempt_no: 1, recorder: 'self' });
    replies = [invalid];
    expect((await uploadDance(A, bad, 1)).status).toBe(202);
    await judge.idle();
    const [v] = await rulingRows(bad);
    expect(v).toMatchObject({ outcome: 'VOID', void_reason: 'undecidable' });
    expect(v!.reason).toBe("This round doesn't count: Jake walked out of the picture halfway.");
    const scored = (await events(bad)).find((e) => e.type === 'dance.scored')!;
    expect(scored.payload.validation).toMatchObject({ verdict: 'invalid', skipped: false });

    const down = await lockedDance();
    await post(A, `/v1/bets/${down}/attempts`, { attempt_no: 1, recorder: 'self' });
    replies = [{ fail: 'timeout' }];
    expect((await uploadDance(A, down, 1)).status).toBe(202);
    await judge.idle();
    const [d] = await rulingRows(down);
    expect(d).toMatchObject({ outcome: 'A_WINS', model: DANCE_OFF_MODEL });
    const s2 = (await events(down)).find((e) => e.type === 'dance.scored')!;
    expect(s2.payload.validation).toMatchObject({ verdict: 'skipped', skipped: true });
  });

  it('the keeper sweep settles a lost dance job on its score (no new model call)', async () => {
    await unbindCam();
    const betId = await lockedDance();
    await post(A, `/v1/bets/${betId}/attempts`, { attempt_no: 1, recorder: 'self' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHook = new Promise<void>((r) => (entered = r));
    hook = async (req) => {
      entered();
      await gate;
      return defaultMockResponder(req);
    };
    const rebooted = createJudgeRoutes({
      loadTerms: async (_db, bet) => termsByBet.get(bet.id) ?? null,
    });
    try {
      expect((await uploadDance(A, betId, 1)).status).toBe(202);
      await inHook;
      const calls0 = llm.calls.length;
      expect(await rebooted.resumeStuck(ctx.deps, Date.now() + 25_000)).toBe(1);
      await rebooted.idle();
      expect(llm.calls.length).toBe(calls0);
      const [r] = await rulingRows(betId);
      expect(r).toMatchObject({ outcome: 'A_WINS', model: DANCE_OFF_MODEL });
      expect(sha256Hex(r!.evidence_canonical!)).toBe(r!.evidence_hash);
      const s = (await events(betId)).find((e) => e.type === 'dance.scored')!;
      expect(s.payload.validation.skipped).toBe(true);
    } finally {
      release();
      await judge.idle();
      hook = null;
    }
    expect(await rulingRows(betId)).toHaveLength(1);
  });

  it('a 32.6 s routine: a 30 fps round + count-in and 6 full-size key frames fit the body limit and score', async () => {
    await unbindCam();
    const LONG = getRoutine('bye-bye-shuffle')!;
    expect(LONG.duration_ms).toBe(32_600);
    const betId = await lockedDance(LONG);
    const [bet] = await ctx.deps.db.select().from(bets).where(eq(bets.id, betId));
    expect(termsByBet.get(betId)!.claim).toMatch(/^Dance Off: Bye Bye Bye, 33 seconds,/);
    expect(bet!.state).toBe('LOCKED');
    const started = await post(A, `/v1/bets/${betId}/attempts`, {
      attempt_no: 1,
      recorder: 'self',
    });
    expect(started.status).toBe(201);
    expect(started.json!.max_ms).toBeGreaterThanOrEqual(LONG.duration_ms + 3 * (60_000 / LONG.bpm));
    // What the phone sends: 30 fps from the count-in (−1.1 s) to the end + the 600 ms tail, A on
    // the reference, B standing still, every int at full width.
    const first = LONG.frames[0]!.k;
    const frames: PoseSeries['frames'] = [];
    for (let t = -1_100; t <= LONG.duration_ms + 600; t += 33) {
      let k = first;
      for (const f of LONG.frames) if (f.t <= t) k = f.k;
      frames.push({ t, n: 2, a: [...k], b: [...first] });
    }
    const long: PoseSeries = {
      schema_version: 1,
      w: LONG.w,
      h: LONG.h,
      fps_cap: 30,
      sync_offset_ms: 0,
      frames,
    };
    const big = (i: number) => {
      const b = randomBytes(DANCE_FRAME_MAX_BYTES - 16);
      return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...b, i & 0xff, 0xff, 0xd9]);
    };
    const up = await uploadDance(A, betId, 1, {
      of: LONG,
      series: long,
      frames: [0, 1, 2, 3, 4, 5].map(big),
    });
    expect(up.status).toBe(202);
    expect(up.json!.scores.a).toBeGreaterThanOrEqual(990);
    expect(up.json!.client_mismatch).toBe(false);
    await judge.idle();
    const [att] = await ctx.deps.db.select().from(attempts).where(eq(attempts.bet_id, betId));
    const stored = DanceEvidence.parse(JSON.parse(att!.evidence_canonical!));
    expect(stored).toMatchObject({
      routine: { id: LONG.id, sha256: routineSha256(LONG) },
      pose_frames: frames.length,
      winner: 'A',
      failed: null,
    });
    expect(stored.key_moves).toHaveLength(LONG.key_moves.length);
  });

  it('a skill bet refuses the /dance upload', async () => {
    await unbindCam();
    // a locked bet whose frozen terms are a bottle flip (B performs)
    const skill = await lockedDance(ROUTINE, {
      type: 'skill',
      claim: 'Jake lands a bottle flip upright on its base.',
      performer: 'B',
      yes_party: 'B',
      success_criteria: ['The bottle comes to rest standing upright on its base.'],
    });
    expect(
      (await post(A, `/v1/bets/${skill}/attempts`, { attempt_no: 1, recorder: 'self' })).status,
    ).toBe(201);
    const r = await uploadDance(A, skill, 1);
    expect(r.json!.error).toMatchObject({
      code: 'INVALID_STATE',
      details: { reason: 'not_dance' },
    });
    expect(await isDanceOffBet(ctx.deps.db, skill)).toBe(false);
  });

  it('the spoken review is refused for a dance off (the score is final)', async () => {
    const f = betFacts();
    const betId = await mkBetRow(ctx.deps.db, f, {
      partyA: uid(A),
      partyB: uid(B),
      state: 'RULED',
      extra: {
        outcome: 'party_a',
        appeal_deadline: new Date(Date.now() + 10_000),
        ruling_hash: 'ab'.repeat(32),
      },
    });
    const canonical = jcs({ type: 'dance_off', bet_id: betId });
    await ctx.deps.db.insert(betTermsVersions).values({
      bet_id: betId,
      version: 1,
      canonical_json: canonical,
      terms_hash: sha256Hex(canonical),
      is_final: true,
    });
    expect(await isDanceOffBet(ctx.deps.db, betId)).toBe(true);
    const r = await lc.review.request(betId, { source: 'demo' });
    expect(r).toMatchObject({ ok: false, fix: 'FINAL' });
  });
});
