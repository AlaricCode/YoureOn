/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and envelopes are loosely typed in tests */
// Camera checks, option B (non-binding; judge/camera-checks.ts, judge/sam.ts): the SAM client over
// a fake fetch, the veto -> ruling text, the realtime shapes, compile-at-terms-time (fake LLM) and
// the ruling pipeline with a fake SAM serving the real clip replies (packages/shared/test/fixtures/
// sam3). No network, no key; DB suites skip without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { attemptChecks, betChecks, betEvents, bets, devices, rulings } from '@youre-on/db';
import { requestSigningString } from '@youre-on/shared/api';
import { ESCROW_ID, USDC_MINT_DEVNET } from '@youre-on/shared/chain/constants';
import { CheckReport, evaluateChecks } from '@youre-on/shared/checks/evaluate';
import { ChecksCompiledPayload, ChecksReportPayload } from '@youre-on/shared/checks/events';
import { CheckSpec, describeChecks } from '@youre-on/shared/checks/spec';
import { hashJcs } from '@youre-on/shared/jcs';
import { judgeFrameTimesMs } from '@youre-on/shared/judge/frames';
import {
  bottleFlipClaim,
  termsConfirmPath,
  typedTermsPath,
  typedTermsRequest,
  TypedTermsResponse,
} from '@youre-on/shared/judge/typed-terms';
import { sha256Hex } from '@youre-on/shared/primitives';
import { parseRealtimeEvent } from '@youre-on/shared/realtime';
import type { Ruling } from '@youre-on/shared/ruling';
import { computeTermsHash, type Terms } from '@youre-on/shared/terms';
import { issueAppSession } from '../src/auth/sessions';
import { DemoToggles, DemoTogglesRequest, togglesOf } from '../src/demo/toggles';
import {
  applyCameraVeto,
  checksIdle,
  reportPayload,
  scheduleCompile,
  scheduleCompileCurrent,
  type CheckRun,
} from '../src/judge/camera-checks';
import { clearCompileChecksCache } from '../src/judge/compile-checks';
import { createJudgeRoutes } from '../src/judge/routes';
import { buildRuling, type Judged } from '../src/judge/ruling';
import { createSamClient, type SamClient } from '../src/judge/sam';
import { loadFinalTerms } from '../src/judge/terms';
import { MockLlm, type MockReply } from '../src/providers/mock/llm';
import type { ChatRequest } from '../src/providers/types';
import { loadEnvelope } from '../src/lock/terms';
import { routeModules } from '../src/routes';
import {
  b64url,
  describeDb,
  newKey,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  type Ctx,
  type SignedUp,
} from './helpers';

// ---- fixtures -----------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
interface Fixture {
  clip: string;
  duration_ms: number;
  frames: number;
  reply: any;
}
const fx = (name: string): Fixture =>
  JSON.parse(
    readFileSync(join(here, `../../../packages/shared/test/fixtures/sam3/${name}.json`), 'utf8'),
  ) as Fixture;
const SUCCESS = fx('bottle_flip_2_success'); // gate true, needs true
const TILTED = fx('bottle_flip_1'); // upright unknown (25 deg)
const FLING = fx('bottle_flip_3_fling'); // gate false (gone at the end)

const BOTTLE_FLIP = CheckSpec.parse({
  predicates: 'p1',
  entities: [{ key: 'bottle', prompt: 'bottle', count: 1 }],
  assertions: [
    { role: 'gate', test: { p: 'visible', e: 'bottle', window: 'end' } },
    { role: 'need', test: { p: 'at_rest', e: 'bottle', ref: null } },
    { role: 'need', test: { p: 'upright', e: 'bottle' } },
  ],
});
const UNCONFIRMED_WHY = "Couldn't confirm the bottle stands upright. Film from the side.";
const NOT_ON_CAMERA_WHY = "Couldn't see the bottle at the end. Keep it in frame and run it back.";

const H = (s: string) => sha256Hex(s);
const silent = { info: () => {}, warn: () => {} };

/** A fetch that answers /segment from `answer` and /health with 200; records every call. */
function fakeFetch(answer: (n: number, body: any, signal: AbortSignal) => Promise<Response>) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith('/health')) return new Response('{"ok":true}', { status: 200 });
    return answer(++n, body, init!.signal!);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
/** Never answers; rejects when aborted (like fetch). */
const hang = (signal: AbortSignal) =>
  new Promise<Response>((_, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
  );

const runOf = (f: Fixture, sam_ms = 3500): CheckRun => {
  const times = judgeFrameTimesMs(f.duration_ms, f.frames);
  const report = CheckReport.parse(
    evaluateChecks(BOTTLE_FLIP, f.reply, times, f.duration_ms, {
      terms_hash: H('terms'),
      frame_hashes: times.map((t) => H(`f${t}`)),
      created_at: '2026-11-18T00:00:00.000Z',
    }),
  );
  return { spec: BOTTLE_FLIP, report, report_hash: hashJcs(report), sam_ms, reply: f.reply };
};

// ---- the SAM client ---------------------------------------------------------------------

describe('SAM client (judge/sam.ts)', () => {
  const TOKEN = 'tok-secret-123';
  const frames = [new Uint8Array([0xff, 0xd8, 0xff, 1]), new Uint8Array([0xff, 0xd8, 0xff, 2])];

  it('POST /segment with the bearer token, base64 frames, masks; parses the reply', async () => {
    const { f, calls } = fakeFetch(async () => json(SUCCESS.reply));
    const sam = createSamClient({ url: 'https://sam.test/', token: TOKEN, log: silent, fetch: f });
    const r = await sam.segment(['bottle'], frames, { timeoutMs: 5000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tries).toBe(1);
    expect(r.raw).toEqual(SUCCESS.reply);
    expect(calls[0]!.url).toBe('https://sam.test/segment');
    expect(calls[0]!.headers['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({
      prompts: ['bottle'],
      frames: frames.map((b) => Buffer.from(b).toString('base64')),
      prompt_frame: 0,
      masks: true,
    });
    expect(sam.stats()).toMatchObject({ calls: 1, failures: 0, last_error: null });
    expect(sam.stats().last_ok_ms).not.toBeNull();
  });

  it('one retry after a fast 5xx / network error, inside the deadline', async () => {
    const { f, calls } = fakeFetch(async (n) =>
      n === 1 ? json({ detail: 'boom' }, 503) : json(SUCCESS.reply),
    );
    const sam = createSamClient({ url: 'https://sam.test', token: TOKEN, log: silent, fetch: f });
    const r = await sam.segment(['bottle'], frames, { timeoutMs: 8000 });
    expect(r).toMatchObject({ ok: true, tries: 2 });
    expect(calls).toHaveLength(2);

    const net = fakeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const sam2 = createSamClient({
      url: 'https://sam.test',
      token: TOKEN,
      log: silent,
      fetch: net.f,
    });
    expect(await sam2.segment(['bottle'], frames, { timeoutMs: 8000 })).toMatchObject({
      ok: false,
      status: 'network',
      tries: 2,
    });
  });

  it('no retry for a 401 / 422, nor once too little time is left; a timeout is not retried', async () => {
    const unauth = fakeFetch(async () => json({ detail: 'unauthorized' }, 401));
    const s1 = createSamClient({
      url: 'https://sam.test',
      token: TOKEN,
      log: silent,
      fetch: unauth.f,
    });
    expect(await s1.segment(['bottle'], frames, { timeoutMs: 8000 })).toMatchObject({
      ok: false,
      status: 'http',
      tries: 1,
    });
    const short = fakeFetch(async () => json({}, 500));
    const s2 = createSamClient({
      url: 'https://sam.test',
      token: TOKEN,
      log: silent,
      fetch: short.f,
    });
    expect(await s2.segment(['bottle'], frames, { timeoutMs: 2000 })).toMatchObject({ tries: 1 });

    const slow = fakeFetch(async (_n, _b, signal) => hang(signal));
    const s3 = createSamClient({
      url: 'https://sam.test',
      token: TOKEN,
      log: silent,
      fetch: slow.f,
    });
    const t0 = Date.now();
    const r = await s3.segment(['bottle'], frames, { timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, status: 'timeout', tries: 1 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(slow.calls).toHaveLength(1);
  });

  it('an unreadable reply is invalid_reply; the token is never logged', async () => {
    const lines: string[] = [];
    const log = {
      info: (m: string, f?: object) => lines.push(m + JSON.stringify(f ?? {})),
      warn: (m: string, f?: object) => lines.push(m + JSON.stringify(f ?? {})),
    };
    // A server echoing the Authorization header back in its error body.
    const echo = fakeFetch(async () => new Response(`bad token Bearer ${TOKEN}`, { status: 500 }));
    const s = createSamClient({ url: 'https://sam.test', token: TOKEN, log, fetch: echo.f });
    const r = await s.segment(['bottle'], frames, { timeoutMs: 8000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain(TOKEN);
    expect(s.stats().last_error).not.toContain(TOKEN);
    expect(lines.join('\n')).not.toContain(TOKEN);
    const bad = fakeFetch(async () => json({ rev: 'x', results: [] }));
    const s2 = createSamClient({ url: 'https://sam.test', token: TOKEN, log, fetch: bad.f });
    expect(await s2.segment(['bottle'], frames, { timeoutMs: 8000 })).toMatchObject({
      ok: false,
      status: 'invalid_reply',
    });
  });

  it('warm() is GET /health, fire-and-forget', async () => {
    const { f, calls } = fakeFetch(async () => json({}));
    const sam = createSamClient({ url: 'https://sam.test', token: TOKEN, log: silent, fetch: f });
    sam.warm();
    expect(calls.map((c) => c.url)).toEqual(['https://sam.test/health']);
    expect(sam.stats().last_warm_at).not.toBeNull();
  });
});

// ---- the runtime toggle (pure; demo-valves covers the HTTP route only with escrow.so) -------

describe('checks toggle (DemoToggles, pure)', () => {
  it('defaults on; off/back on at runtime; the view carries checks, checks_source, checks_env', () => {
    const t = new DemoToggles();
    const env = { CACHED_RULING: false, CHECKS_ENABLED: false };
    expect(t.view(env)).toEqual({
      cached_ruling: false,
      cached_ruling_source: 'env',
      cached_ruling_env: false,
      checks: true,
      checks_source: 'env',
      checks_env: false,
      updated_at: null,
    });
    expect(t.apply({ checks: false }, env, Date.parse('2026-11-18T00:00:00Z'))).toEqual([
      { toggle: 'checks', from: true, to: false, source: 'runtime' },
    ]);
    expect(t.checksOn()).toBe(false);
    expect(t.view({ ...env, CHECKS_ENABLED: true })).toMatchObject({
      checks: false,
      checks_source: 'runtime',
      checks_env: true,
      updated_at: '2026-11-18T00:00:00.000Z',
    });
    expect(t.apply({ checks: null }, env, 0)).toEqual([
      { toggle: 'checks', from: false, to: true, source: 'env' },
    ]);
    expect(t.view(env)).toMatchObject({ checks: true, checks_source: 'env' });
    expect(DemoTogglesRequest.safeParse({ checks: true }).success).toBe(true);
    expect(DemoTogglesRequest.safeParse({ checks: 'off' }).success).toBe(false);
  });
});

// ---- veto -> ruling, event shapes (pure) -----------------------------------------------------

describe('camera veto -> ruling (option B, pure)', () => {
  const ctxBase = {
    ruling_id: randomUUID(),
    bet_id: randomUUID(),
    attempt_no: 1,
    yes_party: 'B' as const,
    terms_hash: H('terms'),
    evidence_hash: H('clip'),
    frame_hashes: Array.from({ length: 12 }, (_, i) => H(`frame ${i}`)),
    created_at: '2026-11-18T18:07:04.512Z',
  };
  const verdict = (claim: 'MET' | 'NOT_MET' | 'UNCLEAR', confidence = 0.93): Judged => ({
    kind: 'verdict',
    model: 'anthropic/claude-sonnet-5-5',
    verdict: {
      claim_result: claim,
      confidence,
      reason: 'Lands on its base.',
      cited_frames: [9, 10, 11],
      contested: false,
    },
    // the legacy bottle checks disagreed: the camera veto replaces this
    disagreement: 'the call says it landed, but the checks miss cap tape on top',
  });

  it('MET + a need unknown -> REDO unclear; the reason is veto.why, verbatim', () => {
    const { judged, veto } = applyCameraVeto(verdict('MET'), runOf(TILTED), 'B');
    expect(veto).toEqual({ kind: 'unconfirmed', why: UNCONFIRMED_WHY });
    const r = buildRuling(ctxBase, judged);
    expect(r).toMatchObject({ outcome: 'REDO', redo_reason: 'unclear', reason: UNCONFIRMED_WHY });
  });

  it('NOT_MET with gates true stands; checks passing replace the legacy disagreement', () => {
    const notMet = applyCameraVeto(verdict('NOT_MET'), runOf(TILTED), 'B');
    expect(notMet.veto).toBeNull();
    expect(buildRuling(ctxBase, notMet.judged).outcome).toBe('A_WINS');
    const ok = applyCameraVeto(verdict('MET'), runOf(SUCCESS), 'B');
    expect(ok.veto).toBeNull();
    expect(buildRuling(ctxBase, ok.judged).outcome).toBe('B_WINS');
  });

  it('gate false -> MET is REDO (VOID past MAX_REDOS); NOT_MET stands (out of shot is a miss)', () => {
    const { judged, veto } = applyCameraVeto(verdict('MET'), runOf(FLING), 'B');
    expect(veto).toEqual({ kind: 'not_on_camera', why: NOT_ON_CAMERA_WHY });
    expect(buildRuling(ctxBase, judged)).toMatchObject({
      outcome: 'REDO',
      reason: NOT_ON_CAMERA_WHY,
    });
    expect(buildRuling({ ...ctxBase, attempt_no: 3 }, judged)).toMatchObject({
      outcome: 'VOID',
      void_reason: 'max_redos',
    });
    // a failing performer cannot duck out of shot into REDO, then VOID max_redos
    const miss = applyCameraVeto(verdict('NOT_MET'), runOf(FLING), 'B');
    expect(miss.veto).toBeNull();
    expect(miss.judged.kind === 'verdict' && miss.judged.disagreement).toBeNull();
    expect(buildRuling({ ...ctxBase, attempt_no: 3 }, miss.judged).outcome).toBe('A_WINS');
  });

  it('a verdict already REDO (low confidence) keeps its own reason; the veto is not "applied"', () => {
    const { judged, veto } = applyCameraVeto(verdict('MET', 0.6), runOf(TILTED), 'B');
    expect(veto).toBeNull();
    // not applied, so not recorded as a disagreement either (audit checks_disagree)
    expect(judged.kind === 'verdict' && judged.disagreement).toBeNull();
    expect(judged.kind === 'verdict' && judged.veto).toBeNull();
    expect(buildRuling(ctxBase, judged)).toMatchObject({
      redo_reason: 'low_confidence',
      reason: 'Lands on its base.',
    });
  });

  it('unavailable SAM: no veto (and the legacy disagreement is dropped for a spec bet)', () => {
    const times = judgeFrameTimesMs(SUCCESS.duration_ms, 12);
    const report = evaluateChecks(BOTTLE_FLIP, null, times, SUCCESS.duration_ms, {
      terms_hash: H('terms'),
      frame_hashes: times.map(() => H('f')),
      created_at: '2026-11-18T00:00:00.000Z',
    });
    const run: CheckRun = {
      spec: BOTTLE_FLIP,
      report,
      report_hash: hashJcs(report),
      sam_ms: 10_000,
      reply: null,
    };
    const { judged, veto } = applyCameraVeto(verdict('MET'), run, 'B');
    expect(veto).toBeNull();
    expect(buildRuling(ctxBase, judged).outcome).toBe('B_WINS');
    const p = ChecksReportPayload.parse(reportPayload(1, run, null));
    expect(p).toMatchObject({ status: 'unavailable', results: [], boxes: {}, frame_size: null });
  });

  it('checks.report payload: labelled rows, boxes only on cited frames, frame size; parses as an event', () => {
    const run = runOf(TILTED);
    const p = ChecksReportPayload.parse(
      reportPayload(2, run, { kind: 'unconfirmed', why: UNCONFIRMED_WHY }),
    );
    expect(p.results.map((r) => [r.role, r.value])).toEqual([
      ['gate', 'true'],
      ['need', 'true'],
      ['need', 'unknown'],
    ]);
    expect(p.results[2]!.label).toBe('the bottle stands upright');
    const cited = new Set(p.results.flatMap((r) => r.frames));
    expect(Object.keys(p.boxes).length).toBeGreaterThan(0);
    for (const [k, boxes] of Object.entries(p.boxes)) {
      expect(cited.has(Number(k))).toBe(true);
      for (const b of boxes) expect(b).toMatchObject({ key: 'bottle', prompt: 'bottle' });
    }
    expect(p.frame_size).toEqual({ w: expect.any(Number), h: expect.any(Number) });
    expect(JSON.stringify(p)).not.toContain('counts'); // no masks
    const env = {
      v: 1,
      type: 'checks.report',
      bet_id: randomUUID(),
      seq: 3,
      ts: '2026-11-18T00:00:00.000Z',
      source: 'server',
      payload: p,
    };
    expect(parseRealtimeEvent(env).ok).toBe(true);
    const compiled = {
      ...env,
      type: 'checks.compiled',
      payload: ChecksCompiledPayload.parse({
        terms_hash: H('t'),
        decision: 'checks',
        readback: describeChecks(BOTTLE_FLIP),
      }),
    };
    expect(parseRealtimeEvent(compiled).ok).toBe(true);
    expect(parseRealtimeEvent({ ...compiled, payload: { terms_hash: 'x' } }).ok).toBe(false);
  });
});

// ---- compile at terms time (DB) ----------------------------------------------------------

/** A typed-terms reply that proposed terms (narrowed for terms_hash). */
function proposed(body: unknown) {
  const r = TypedTermsResponse.parse(body);
  if (!r.ok || r.kind !== 'proposed') throw new Error(`not proposed: ${JSON.stringify(body)}`);
  return r;
}
const isCompile = (req: ChatRequest<unknown>) => req.output.name === 'compile_checks';
const compiledReply: MockReply = {
  value: {
    decision: 'checks',
    why: 'Upright at rest is a necessary consequence.',
    spec: BOTTLE_FLIP,
  },
};

describeDb('camera checks: compile at terms time (DB)', () => {
  let ctx: Ctx;
  let llm: MockLlm;
  let respond: (req: ChatRequest<unknown>) => MockReply | Promise<MockReply>;
  let sam: ReturnType<typeof fakeFetch>;

  beforeAll(async () => {
    ctx = await startTestServer({ env: { MAX_STAKE_MICRO: '20000000', CHECKS_ENABLED: 'true' } });
    llm = new MockLlm((req) => respond(req));
    ctx.deps.providers.llm = llm;
    sam = fakeFetch(async () => json(SUCCESS.reply));
    ctx.deps.sam = createSamClient({
      url: 'https://sam.test',
      token: 't',
      log: silent,
      fetch: sam.f,
    });
  });
  afterAll(async () => {
    await checksIdle(ctx.deps);
    await ctx?.server.close();
  });
  beforeEach(() => {
    clearCompileChecksCache();
    respond = (req) => (isCompile(req) ? compiledReply : { fail: 'error', message: 'unscripted' });
    llm.calls.length = 0;
    sam.calls.length = 0;
    togglesOf(ctx.deps).apply({ checks: null }, ctx.deps.env, Date.now());
    (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = true;
  });

  const post = (u: SignedUp, path: string, body: unknown) => {
    const raw = JSON.stringify(body);
    return postJson(ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
  };
  const row = async (betId: string) =>
    (await ctx.deps.db.select().from(betChecks).where(eq(betChecks.bet_id, betId)))[0] ?? null;
  const bet = async (betId: string) =>
    (await ctx.deps.db.select().from(bets).where(eq(bets.id, betId)))[0]!;
  const compiledEvents = async (betId: string) =>
    (
      await ctx.deps.db
        .select()
        .from(betEvents)
        .where(eq(betEvents.bet_id, betId))
        .orderBy(asc(betEvents.seq))
    ).filter((e) => e.type === 'checks.compiled');

  async function newBet() {
    const A = await signUp(ctx.base, 'Logan');
    const B = await signUp(ctx.base, 'Jake');
    const room = await post(A, '/v1/rooms', { name: 'Checks', kind: 'session' });
    expect((await post(B, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
    const b = await post(A, '/v1/bets', {
      room_id: room.json!.room_id,
      opponent_user_id: B.session.user.user_id,
      challenge_method: 'list',
    });
    expect(b.status).toBe(201);
    return { A, B, betId: b.json!.bet.bet_id as string };
  }
  const flip = (stakeUsd = 5, claim = bottleFlipClaim('Jake')) =>
    typedTermsRequest({ claim, stakeUsd, bName: 'Jake' });

  it('typed terms -> compiled in the background, stored by terms_hash, checks.compiled pushed', async () => {
    const { A, betId } = await newBet();
    const r = proposed((await post(A, typedTermsPath(betId), flip(5))).json);
    await checksIdle(ctx.deps);
    const stored = await row(betId);
    expect(stored).toMatchObject({
      terms_hash: r.terms_hash,
      decision: 'checks',
      status: 'ok',
      readback: describeChecks(BOTTLE_FLIP),
      model: 'anthropic/mock/claude-opus-5-5',
    });
    expect(CheckSpec.parse(stored!.spec)).toEqual(BOTTLE_FLIP);
    const ev = await compiledEvents(betId);
    expect(ev).toHaveLength(1);
    const parsed = parseRealtimeEvent(ev[0]!.envelope);
    expect(parsed.ok).toBe(true);
    expect((ev[0]!.envelope as any).payload).toEqual({
      terms_hash: r.terms_hash,
      decision: 'checks',
      readback: describeChecks(BOTTLE_FLIP),
    });
    expect(llm.calls.filter(isCompile)).toHaveLength(1);
  });

  it('new terms -> recompiled under the new terms_hash (the old row is replaced)', async () => {
    const { A, betId } = await newBet();
    const r1 = proposed((await post(A, typedTermsPath(betId), flip(5))).json);
    await checksIdle(ctx.deps);
    respond = (req) =>
      isCompile(req)
        ? { value: { decision: 'judge_only', why: 'Changed.', spec: null } }
        : { fail: 'error' };
    const r2 = proposed(
      (await post(A, typedTermsPath(betId), flip(5, 'Jake lands a bottle flip on the first try.')))
        .json,
    );
    expect(r2.terms_hash).not.toBe(r1.terms_hash);
    await checksIdle(ctx.deps);
    expect(await row(betId)).toMatchObject({
      terms_hash: r2.terms_hash,
      decision: 'judge_only',
      spec: null,
      readback: 'Judge only, no ref cam.',
    });
    expect(
      (await compiledEvents(betId)).map((e) => (e.envelope as any).payload.terms_hash),
    ).toEqual([r1.terms_hash, r2.terms_hash]);
  });

  it('never blocks the terms flow: a hanging compiler, then a stale result is not stored', async () => {
    const { A, betId } = await newBet();
    let release: ((r: MockReply) => void) | null = null;
    respond = (req) =>
      isCompile(req)
        ? new Promise<MockReply>((res) => (release = res))
        : { fail: 'error', message: 'x' };
    const t0 = Date.now();
    const r1 = await post(A, typedTermsPath(betId), flip(5));
    expect(r1.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    // The terms move on before the compile answers: the answer is for stale terms.
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20));
    const first = release as unknown as (r: MockReply) => void;
    expect(first).toBeTypeOf('function');
    respond = (req) => (isCompile(req) ? compiledReply : { fail: 'error' });
    const r2 = proposed(
      (await post(A, typedTermsPath(betId), flip(7, 'Jake flips a bottle and it stays upright.')))
        .json,
    );
    await new Promise((r) => setTimeout(r, 50));
    first(compiledReply);
    await checksIdle(ctx.deps);
    const stored = await row(betId);
    expect(stored?.terms_hash).toBe(r2.terms_hash);
    expect((await bet(betId)).terms_hash).toBe(r2.terms_hash);
    // a compiler failure is judge_only 'fallback', still never blocking
    respond = (req) => (isCompile(req) ? { fail: 'error', message: 'down' } : { fail: 'error' });
    const r3 = proposed(
      (await post(A, typedTermsPath(betId), flip(8, 'Jake lands one bottle flip upright.'))).json,
    );
    await checksIdle(ctx.deps);
    expect(await row(betId)).toMatchObject({
      terms_hash: r3.terms_hash,
      decision: 'judge_only',
      status: 'fallback',
    });
  });

  it('checks disabled (env) or toggled off: no compile call, no row', async () => {
    (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = false;
    const one = await newBet();
    expect((await post(one.A, typedTermsPath(one.betId), flip(5))).status).toBe(200);
    await checksIdle(ctx.deps);
    expect(await row(one.betId)).toBeNull();
    (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = true;
    togglesOf(ctx.deps).apply({ checks: false }, ctx.deps.env, Date.now());
    const two = await newBet();
    expect((await post(two.A, typedTermsPath(two.betId), flip(5))).status).toBe(200);
    await checksIdle(ctx.deps);
    expect(await row(two.betId)).toBeNull();
    expect(llm.calls.filter(isCompile)).toHaveLength(0);
  });

  it('confirm: the frozen terms keep their row (no second call) and SAM is warmed', async () => {
    const { A, B, betId } = await newBet();
    const r = proposed((await post(A, typedTermsPath(betId), flip(5))).json);
    await checksIdle(ctx.deps);
    expect((await post(B, `/v1/bets/${betId}/invite/accept`, {})).status).toBe(200);
    const c = await post(A, termsConfirmPath(betId), { terms_hash: r.terms_hash });
    expect(c.status).toBe(200);
    await checksIdle(ctx.deps);
    expect((await row(betId))?.terms_hash).toBe(r.terms_hash);
    expect(llm.calls.filter(isCompile)).toHaveLength(1);
    expect(sam.calls.map((x) => x.url)).toEqual(['https://sam.test/health']);
  });

  it('confirm while checks are off (env or toggle): no compile, no SAM warm', async () => {
    for (const off of ['env', 'toggle'] as const) {
      const { A, B, betId } = await newBet();
      const r = proposed((await post(A, typedTermsPath(betId), flip(5))).json);
      await checksIdle(ctx.deps);
      if (off === 'env') (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = false;
      else togglesOf(ctx.deps).apply({ checks: false }, ctx.deps.env, Date.now());
      expect((await post(B, `/v1/bets/${betId}/invite/accept`, {})).status).toBe(200);
      expect((await post(A, termsConfirmPath(betId), { terms_hash: r.terms_hash })).status).toBe(
        200,
      );
      await checksIdle(ctx.deps);
      expect(sam.calls).toHaveLength(0);
      (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = true;
      togglesOf(ctx.deps).apply({ checks: null }, ctx.deps.env, Date.now());
    }
  });

  it('a fallback (compiler down at proposal) is retried at the freeze, then SAM is warmed', async () => {
    const { A, B, betId } = await newBet();
    respond = (req) => (isCompile(req) ? { fail: 'error', message: 'down' } : { fail: 'error' });
    const r = proposed((await post(A, typedTermsPath(betId), flip(5))).json);
    await checksIdle(ctx.deps);
    expect(await row(betId)).toMatchObject({ terms_hash: r.terms_hash, status: 'fallback' });
    respond = (req) => (isCompile(req) ? compiledReply : { fail: 'error' });
    expect((await post(B, `/v1/bets/${betId}/invite/accept`, {})).status).toBe(200);
    expect((await post(A, termsConfirmPath(betId), { terms_hash: r.terms_hash })).status).toBe(200);
    await checksIdle(ctx.deps);
    expect(await row(betId)).toMatchObject({
      terms_hash: r.terms_hash,
      decision: 'checks',
      status: 'ok',
    });
    expect(sam.calls.map((x) => x.url)).toEqual(['https://sam.test/health']);
  });

  it('compile-current for newer terms never joins an older in-flight run', async () => {
    const { A, betId } = await newBet();
    togglesOf(ctx.deps).apply({ checks: false }, ctx.deps.env, Date.now());
    proposed((await post(A, typedTermsPath(betId), flip(5))).json);
    togglesOf(ctx.deps).apply({ checks: null }, ctx.deps.env, Date.now());
    let release: ((r: MockReply) => void) | null = null;
    respond = (req) =>
      isCompile(req) ? new Promise<MockReply>((res) => (release = res)) : { fail: 'error' };
    const p1 = scheduleCompileCurrent(ctx.deps, betId);
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 20));
    expect(release).toBeTypeOf('function');
    // newer terms land (as an odds recompose would) while the h1 compile hangs
    togglesOf(ctx.deps).apply({ checks: false }, ctx.deps.env, Date.now());
    const r2 = proposed(
      (await post(A, typedTermsPath(betId), flip(7, 'Jake flips a bottle and it stays upright.')))
        .json,
    );
    togglesOf(ctx.deps).apply({ checks: null }, ctx.deps.env, Date.now());
    respond = (req) => (isCompile(req) ? compiledReply : { fail: 'error' });
    const p2 = scheduleCompileCurrent(ctx.deps, betId);
    expect(p2).not.toBe(p1);
    expect((await p2)?.terms_hash).toBe(r2.terms_hash);
    (release as unknown as (r: MockReply) => void)(compiledReply);
    expect(await p1).toBeNull(); // stale, dropped
    await checksIdle(ctx.deps);
    expect((await row(betId))?.terms_hash).toBe(r2.terms_hash);
  });

  it('a market (gemini) bet gets no ref cam: no compile, no row, no checks.compiled', async () => {
    const { A, betId } = await newBet();
    togglesOf(ctx.deps).apply({ checks: false }, ctx.deps.env, Date.now());
    const r = proposed((await post(A, typedTermsPath(betId), flip(5))).json);
    togglesOf(ctx.deps).apply({ checks: null }, ctx.deps.env, Date.now());
    const latest = (await loadEnvelope(ctx.deps.db, betId))!;
    const market = { ...latest.envelope.terms, evidence_source: 'gemini' } as Terms;
    expect(await scheduleCompile(ctx.deps, betId, market, r.terms_hash)).toBeNull();
    await checksIdle(ctx.deps);
    expect(await row(betId)).toBeNull();
    expect(await compiledEvents(betId)).toHaveLength(0);
    expect(llm.calls.filter(isCompile)).toHaveLength(0);
  });

  it('confirm without a stored row (compile never ran): compiled at the freeze', async () => {
    const { A, B, betId } = await newBet();
    togglesOf(ctx.deps).apply({ checks: false }, ctx.deps.env, Date.now());
    const r = proposed((await post(A, typedTermsPath(betId), flip(5))).json);
    await checksIdle(ctx.deps);
    expect(await row(betId)).toBeNull();
    togglesOf(ctx.deps).apply({ checks: null }, ctx.deps.env, Date.now());
    expect((await post(B, `/v1/bets/${betId}/invite/accept`, {})).status).toBe(200);
    expect((await post(A, termsConfirmPath(betId), { terms_hash: r.terms_hash })).status).toBe(200);
    await checksIdle(ctx.deps);
    expect(await row(betId)).toMatchObject({ terms_hash: r.terms_hash, decision: 'checks' });
  });
});

// ---- the ruling pipeline with a fake SAM (DB) --------------------------------------------

describeDb('camera checks: ruling with a fake SAM (DB)', () => {
  let ctx: Ctx;
  const termsByBet = new Map<string, Terms>();
  const judge = createJudgeRoutes({
    loadTerms: async (db, b) => termsByBet.get(b.id) ?? loadFinalTerms(db, b),
  });
  const modules = routeModules.map((m) => (m.name === 'judge' ? judge : m));
  let llm: MockLlm;
  let verdictReply: MockReply;
  let samAnswer: (n: number, body: any, signal: AbortSignal) => Promise<Response>;
  let sam: ReturnType<typeof fakeFetch>;
  let samClient: SamClient;
  const ruled: { betId: string; ruling: Ruling }[] = [];
  let A: SignedUp;
  let B: SignedUp;
  let CAM: SignedUp;
  let roomId: string;

  const uid = (u: SignedUp) => u.session.user.user_id;
  const post = (u: SignedUp, path: string, body?: unknown) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return fetch(ctx.base + path, {
      method: 'POST',
      headers: signedHeaders(u, 'POST', path, raw),
      body: raw || undefined,
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
    });
  };

  beforeAll(async () => {
    ctx = await startTestServer({ modules, env: { CHECKS_ENABLED: 'true' } });
    llm = new MockLlm(() => verdictReply);
    ctx.deps.providers.llm = llm;
    sam = fakeFetch((n, body, signal) => samAnswer(n, body, signal));
    samClient = createSamClient({ url: 'https://sam.test', token: 't', log: silent, fetch: sam.f });
    ctx.deps.sam = samClient;
    ctx.deps.onRuling = (betId, ruling) => {
      ruled.push({ betId, ruling });
    };
    A = await signUp(ctx.base, 'Logan');
    B = await signUp(ctx.base, 'Jake');
    const r = await post(A, '/v1/rooms', { name: 'Checks room', kind: 'session' });
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
    const path = '/v1/devices/current';
    const raw = JSON.stringify({ role: 'judge_cam', room_id: roomId });
    const p = await fetch(ctx.base + path, {
      method: 'PATCH',
      headers: signedHeaders(CAM, 'PATCH', path, raw),
      body: raw,
    });
    expect(p.status).toBe(204);
  });
  afterAll(async () => {
    await judge.idle();
    await checksIdle(ctx.deps);
    await ctx?.server.close();
  });
  beforeEach(() => {
    sam.calls.length = 0;
    samAnswer = async () => json(TILTED.reply);
    (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = true;
    (ctx.deps.env as { SAM_TIMEOUT_MS: number }).SAM_TIMEOUT_MS = 10_000;
    (ctx.deps.env as { CACHED_RULING: boolean }).CACHED_RULING = false;
    togglesOf(ctx.deps).apply({ checks: null, cached_ruling: null }, ctx.deps.env, Date.now());
    ctx.deps.sam = samClient;
  });

  /** The legacy bottle checks would veto this MET (cap tape not seen). */
  const verdict = (claim: 'met' | 'not_met', capTape: boolean | null = true): MockReply => ({
    value: {
      claim_result: claim,
      confidence: 0.93,
      reason: claim === 'met' ? 'Lands on its base and stays put.' : 'Ends on its side.',
      cited_frames: [9, 10, 11],
      contested: false,
      checks: { cap_tape_visible: capTape, bottle_upright_at_rest: claim === 'met' },
    },
  });

  /** A LOCKED bottle-flip bet (B performs); `spec` = a bet_checks row for its terms_hash. */
  async function lockedBet(spec: CheckSpec | null | 'judge_only' | 'stale'): Promise<string> {
    const created = await post(A, '/v1/bets', {
      room_id: roomId,
      opponent_user_id: uid(B),
      challenge_method: 'list',
    });
    expect(created.status).toBe(201);
    const betId: string = created.json!.bet.bet_id;
    const now = new Date();
    const { terms, terms_hash } = computeTermsHash({
      schema_version: 1,
      bet_id: betId,
      escrow: { cluster: 'devnet', program_id: ESCROW_ID, mint: USDC_MINT_DEVNET },
      party_a: { pubkey: A.wallet.pubkey, display_name: 'Logan' },
      party_b: { pubkey: B.wallet.pubkey, display_name: 'Jake' },
      type: 'skill',
      claim: 'Jake lands a bottle flip upright on its base.',
      performer: 'B',
      yes_party: 'B',
      attempts: { count: 1, rule: 'single' },
      success_criteria: ['The bottle comes to rest standing upright on its base.'],
      failure_criteria: ['The bottle ends on its side, upside down, or off the table.'],
      edge_cases: [{ question: 'Does the cap count?', answer: 'No.', asked_by: 'judge' }],
      evidence_source: 'camera',
      market: null,
      stakes: { a: '5000000', b: '5000000', currency: 'USDC' },
      deadline: new Date(Math.ceil(now.getTime() / 1000) * 1000 + 3600_000).toISOString(),
      created_at: now.toISOString(),
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
    if (spec !== null)
      await ctx.deps.db.insert(betChecks).values({
        bet_id: betId,
        terms_hash: spec === 'stale' ? H('older terms') : terms_hash,
        decision: spec === 'judge_only' ? 'judge_only' : 'checks',
        spec: spec === 'judge_only' ? null : (BOTTLE_FLIP as any),
        why: 'test',
        readback: describeChecks(spec === 'judge_only' ? null : BOTTLE_FLIP),
        model: null,
        prompt_version: 'test',
        status: 'ok',
      });
    return betId;
  }

  const jpeg = (i: number) =>
    new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...randomBytes(32), i & 0xff, 0xff, 0xd9]);

  /** Start attempt 1 and upload 12 frames + a landing crop at the fixture clip's frame times. */
  async function attempt(betId: string, durationMs: number, attemptNo = 1) {
    const s = await post(A, `/v1/bets/${betId}/attempts`, {
      attempt_no: attemptNo,
      recorder: 'judge_cam',
    });
    expect(s.status).toBe(201);
    const frames = Array.from({ length: 13 }, (_, i) => jpeg(i));
    const times = judgeFrameTimesMs(durationMs, 12);
    const evidence = {
      schema_version: 1,
      kind: 'camera',
      bet_id: betId,
      attempt_no: attemptNo,
      clip_sha256: H(`clip ${betId} ${attemptNo}`),
      clip_bytes: 5_500_000,
      mime: 'video/quicktime',
      duration_ms: durationMs,
      recorded_by: 'A',
      recorded_at: new Date().toISOString(),
      frames: frames.map((f, i) => ({
        index: i,
        t_ms: i === 12 ? times[11]! : times[i]!,
        sha256: sha256Hex(f),
        ...(i === 12 ? { landing_crop: true } : {}),
      })),
    };
    const form = new FormData();
    form.append('evidence', new Blob([JSON.stringify(evidence)], { type: 'application/json' }));
    frames.forEach((f, i) =>
      form.append(
        'frame',
        new Blob([f as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }),
        `${i}.jpg`,
      ),
    );
    const req = new Request('http://x/', { method: 'POST', body: form });
    const body = new Uint8Array(await req.arrayBuffer());
    const path = `/v1/bets/${betId}/attempts/${attemptNo}/frames`;
    const ts = String(Date.now());
    const idem = randomUUID();
    const sig = CAM.device.sign(
      requestSigningString({
        method: 'POST',
        path_and_query: path,
        timestamp_ms: ts,
        idempotency_key: idem,
        session_id: CAM.session.session_id,
        body_sha256_hex: sha256Hex(body),
      }),
    );
    const res = await fetch(ctx.base + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CAM.session.token}`,
        'X-YO-Device': CAM.session.device_id,
        'X-YO-Timestamp': ts,
        'Idempotency-Key': idem,
        'X-YO-Signature': b64url(sig),
        'Content-Type': req.headers.get('content-type')!,
      },
      body,
    });
    expect(res.status).toBe(202);
    await judge.idle();
    return { frames, times };
  }

  const ruling = async (betId: string) =>
    (await ctx.deps.db.select().from(rulings).where(eq(rulings.bet_id, betId)))[0]!;
  const stored = async (betId: string) =>
    ctx.deps.db.select().from(attemptChecks).where(eq(attemptChecks.bet_id, betId));
  const events = async (betId: string) =>
    ctx.deps.db
      .select()
      .from(betEvents)
      .where(eq(betEvents.bet_id, betId))
      .orderBy(asc(betEvents.seq));
  const segmentCalls = () => sam.calls.filter((c) => c.url.endsWith('/segment'));

  it('MET + a need unknown (25 deg tilt) -> REDO with veto.why; checks.report before ruling.issued', async () => {
    verdictReply = verdict('met');
    const betId = await lockedBet(BOTTLE_FLIP);
    const { frames } = await attempt(betId, TILTED.duration_ms);
    const r = await ruling(betId);
    expect(r).toMatchObject({ outcome: 'REDO', redo_reason: 'unclear', reason: UNCONFIRMED_WHY });
    // SAM saw the 12 regular frames, never the landing crop, with the spec's prompts
    expect(segmentCalls()).toHaveLength(1);
    const body = segmentCalls()[0]!.body;
    expect(body).toMatchObject({ prompts: ['bottle'], prompt_frame: 0, masks: true });
    expect(body.frames).toEqual(frames.slice(0, 12).map((f) => Buffer.from(f).toString('base64')));
    // stored
    const [row] = await stored(betId);
    expect(row).toMatchObject({ attempt_no: 1, status: 'ok' });
    const report = CheckReport.parse(row!.report);
    expect(row!.report_hash).toBe(hashJcs(report));
    expect(report.frame_hashes).toEqual(frames.slice(0, 12).map((f) => sha256Hex(f)));
    expect(report.terms_hash).toBe(
      (await ctx.deps.db.select().from(bets).where(eq(bets.id, betId)))[0]!.terms_hash,
    );
    // events: checks.report (valid envelope) right before ruling.issued
    const evs = await events(betId);
    const i = evs.findIndex((e) => e.type === 'checks.report');
    expect(evs[i + 1]!.type).toBe('ruling.issued');
    const parsed = parseRealtimeEvent(evs[i]!.envelope);
    expect(parsed.ok).toBe(true);
    expect((evs[i]!.envelope as any).payload).toMatchObject({
      attempt_no: 1,
      status: 'ok',
      gate: 'true',
      need: 'unknown',
      veto: { kind: 'unconfirmed', why: UNCONFIRMED_WHY },
      report_hash: row!.report_hash,
    });
  });

  it('NOT_MET stands (needs never contradict a miss)', async () => {
    verdictReply = verdict('not_met');
    const betId = await lockedBet(BOTTLE_FLIP);
    await attempt(betId, TILTED.duration_ms);
    expect((await ruling(betId)).outcome).toBe('A_WINS');
    expect(segmentCalls()).toHaveLength(1);
  });

  it('gate false (the bottle left the shot): MET -> REDO, NOT_MET stands', async () => {
    samAnswer = async () => json(FLING.reply);
    verdictReply = verdict('met');
    const met = await lockedBet(BOTTLE_FLIP);
    await attempt(met, FLING.duration_ms);
    expect(await ruling(met)).toMatchObject({ outcome: 'REDO', reason: NOT_ON_CAMERA_WHY });
    verdictReply = verdict('not_met');
    const miss = await lockedBet(BOTTLE_FLIP);
    await attempt(miss, FLING.duration_ms);
    expect((await ruling(miss)).outcome).toBe('A_WINS');
    const ev = (await events(miss)).find((e) => e.type === 'checks.report')!;
    expect((ev.envelope as any).payload).toMatchObject({ gate: 'false', veto: null });
  });

  it('a SAM reply missing a frame -> unavailable, no veto (never U1 -> REDO)', async () => {
    verdictReply = verdict('met');
    const short = structuredClone(TILTED.reply) as { results: { frames: unknown[] }[] };
    short.results[0]!.frames.pop();
    samAnswer = async () => json(short);
    const betId = await lockedBet(BOTTLE_FLIP);
    await attempt(betId, TILTED.duration_ms);
    expect((await ruling(betId)).outcome).toBe('B_WINS');
    const [row] = await stored(betId);
    expect(row).toMatchObject({ status: 'unavailable' });
    const ev = (await events(betId)).find((e) => e.type === 'checks.report')!;
    expect((ev.envelope as any).payload).toMatchObject({ status: 'unavailable', veto: null });
  });

  it('checks pass -> MET stands, even where the legacy bottle checks would have vetoed', async () => {
    verdictReply = verdict('met', null); // cap tape not confirmed: legacy -> REDO
    samAnswer = async () => json(SUCCESS.reply);
    const betId = await lockedBet(BOTTLE_FLIP);
    await attempt(betId, SUCCESS.duration_ms);
    expect((await ruling(betId)).outcome).toBe('B_WINS');
    const ev = (await events(betId)).find((e) => e.type === 'checks.report')!;
    expect((ev.envelope as any).payload).toMatchObject({
      status: 'ok',
      gate: 'true',
      need: 'true',
      veto: null,
    });
  });

  it('SAM timeout -> no veto, attempt_checks unavailable, the ruling is not held past the deadline', async () => {
    verdictReply = verdict('met');
    (ctx.deps.env as { SAM_TIMEOUT_MS: number }).SAM_TIMEOUT_MS = 300;
    samAnswer = async (_n, _b, signal) => hang(signal);
    const betId = await lockedBet(BOTTLE_FLIP);
    const t0 = Date.now();
    await attempt(betId, TILTED.duration_ms);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await ruling(betId)).outcome).toBe('B_WINS');
    const [row] = await stored(betId);
    expect(row).toMatchObject({ status: 'unavailable' });
    expect(row!.sam_ms).toBeGreaterThanOrEqual(250);
    const ev = (await events(betId)).find((e) => e.type === 'checks.report')!;
    expect(parseRealtimeEvent(ev.envelope).ok).toBe(true);
    expect((ev.envelope as any).payload).toMatchObject({
      status: 'unavailable',
      veto: null,
      results: [],
      boxes: {},
      frame_size: null,
    });
  });

  it('checks disabled (env, toggle, or no SAM configured) -> no SAM call; legacy bottle checks apply', async () => {
    verdictReply = verdict('met', null);
    const legacy = /^Checks disagree: the call says it landed, but the checks miss cap tape on top/;
    const cases: (() => void)[] = [
      () => {
        (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = false;
      },
      () => {
        togglesOf(ctx.deps).apply({ checks: false }, ctx.deps.env, Date.now());
      },
      () => {
        delete (ctx.deps as { sam?: SamClient }).sam;
      },
    ];
    for (const off of cases) {
      off();
      const betId = await lockedBet(BOTTLE_FLIP);
      await attempt(betId, TILTED.duration_ms);
      const r = await ruling(betId);
      expect(r).toMatchObject({ outcome: 'REDO', redo_reason: 'unclear' });
      expect(r.reason).toMatch(legacy);
      expect(await stored(betId)).toHaveLength(0);
      expect((await events(betId)).some((e) => e.type === 'checks.report')).toBe(false);
      await checksIdle(ctx.deps); // the recording-start warm, had it been started
      // restore for the next case
      (ctx.deps.env as { CHECKS_ENABLED: boolean }).CHECKS_ENABLED = true;
      togglesOf(ctx.deps).apply({ checks: null }, ctx.deps.env, Date.now());
      ctx.deps.sam = samClient;
    }
    expect(segmentCalls()).toHaveLength(0);
    expect(sam.calls).toHaveLength(0); // no warm (GET /health) either: no billed cold start
  });

  it('a bet without a spec (none, judge_only, or compiled for other terms) -> legacy behaviour, no SAM', async () => {
    verdictReply = verdict('met', null);
    for (const spec of [null, 'judge_only', 'stale'] as const) {
      const betId = await lockedBet(spec);
      await attempt(betId, TILTED.duration_ms);
      expect((await ruling(betId)).reason).toMatch(/^Checks disagree: the call says it landed/);
      expect(await stored(betId)).toHaveLength(0);
    }
    expect(segmentCalls()).toHaveLength(0);
  });

  it('cached_ruling: the stored verdict, no SAM call (the demo fallback is untouched)', async () => {
    togglesOf(ctx.deps).apply({ cached_ruling: true }, ctx.deps.env, Date.now());
    const calls0 = llm.calls.length;
    const betId = await lockedBet(BOTTLE_FLIP);
    await attempt(betId, TILTED.duration_ms);
    const r = await ruling(betId);
    expect(r.outcome).toBe('B_WINS');
    expect(r.model).toBe('cache/demo-bottle@1');
    expect(llm.calls.length).toBe(calls0);
    expect(segmentCalls()).toHaveLength(0);
    expect(sam.calls).toHaveLength(0); // no warm either
  });

  it('recording starts -> SAM is warmed for a checks bet (GET /health), not for others', async () => {
    verdictReply = verdict('not_met');
    const withSpec = await lockedBet(BOTTLE_FLIP);
    await attempt(withSpec, TILTED.duration_ms);
    await checksIdle(ctx.deps);
    expect(sam.calls.filter((c) => c.url.endsWith('/health'))).toHaveLength(1);
    sam.calls.length = 0;
    const without = await lockedBet(null);
    await attempt(without, TILTED.duration_ms);
    await checksIdle(ctx.deps);
    expect(sam.calls).toHaveLength(0);
  });

  it('GET /v1/demo/health has a checks block (enabled, sam configured, last SAM ok / fail)', async () => {
    const { chainHealth } = await import('../src/chain/health');
    const h = await chainHealth(ctx.deps);
    expect(h.checks).toMatchObject({
      enabled: true,
      sam_configured: true,
      toggle: true,
      active: true,
      timeout_ms: 10_000,
    });
    expect(h.checks.calls).toBeGreaterThan(0);
    expect(h.checks.last_ok_at).not.toBeNull();
    expect(h.checks.last_error).toMatch(/^timeout/);
  });
});
