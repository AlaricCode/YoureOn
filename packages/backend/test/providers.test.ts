import { describe, expect, it } from 'vitest';
import {
  closedSetMatch,
  crossCheck,
  cosineBps,
  encodeEvent,
  evaluateSession,
  FACE_DIM,
  parseYaml,
  quantizeEmbedding,
  VOICE_DIM,
  type CompileContext,
} from '@verdict/engine';
import { parseProgramLogs } from '../src/chain/devnet.js';
import { loadConfig } from '../src/config/load.js';
import { Keeper } from '../src/keeper/keeper.js';
import { MockAdvocate, mockJudgeVote } from '../src/providers/mock/booth.js';
import { classify, MockCompiler, parseAmountUnits } from '../src/providers/mock/compiler.js';
import { MockDetector, mockLayoutBox } from '../src/providers/mock/detector.js';
import { MockGemini, mockWalkPrice } from '../src/providers/mock/gemini.js';
import { MockIdentity } from '../src/providers/mock/identity.js';
import { MockPerception } from '../src/providers/mock/perception.js';
import { MockStt, MockTts } from '../src/providers/mock/voice.js';
import { HttpPerception } from '../src/providers/real/perception.js';
import { HttpEmbedder } from '../src/providers/real/sidecars.js';
import { probBpsFromPrices } from '../src/providers/real/world.js';
import { createProviders } from '../src/providers/registry.js';
import type { BoothCase, CompileRequest } from '../src/providers/types.js';
import { generateKeypair } from '../src/crypto/keys.js';
import { ManualClock } from '../src/util/clock.js';
import { decodeWav } from '../src/util/wav.js';
import { testEnv } from './helpers.js';


const creator = generateKeypair().publicKey;
const friend = generateKeypair().publicKey;
const members: CompileRequest['members'] = [
  { user_id: 'u-creator', display_name: 'Alex', wallet: creator },
  { user_id: 'u-friend', display_name: 'Sam', wallet: friend },
];
const cctx: CompileContext = {
  creator,
  huddle: [
    { wallet: creator, display_name: 'Alex', enrolled: true },
    { wallet: friend, display_name: 'Sam', enrolled: true },
  ],
};

describe('registry', () => {
  it('builds all-mock providers by default', () => {
    const p = createProviders(loadConfig(testEnv()));
    for (const k of ['compiler', 'advocate', 'agent', 'stt', 'tts', 'sfx', 'perception', 'detector', 'identity', 'gemini', 'hedge', 'prover'] as const) {
      expect(p[k].name, k).toBe('mock');
    }
    expect(p.judges.map((j) => j.name)).toEqual(['mock', 'mock', 'mock']);
    expect(p.sp1.enabled).toBe(false);
    expect(p.mockScenario).toBe('pass');
  });
});

describe('mock compiler (§13 templates)', () => {
  const compiler = new MockCompiler();
  const compile = (transcript: string, answers?: CompileRequest['answers']) =>
    compiler.compile({ transcript, creator_user_id: 'u-creator', members, ...(answers ? { answers } : {}) });

  it('classifies keyword templates', () => {
    expect(classify('paper ball into the trash can')).toBe('paper');
    expect(classify('the cup tower survives the fan')).toBe('cup');
    expect(classify('I can do 20 push-ups')).toBe('pushup');
    expect(classify('Sam finishes the wing')).toBe('ai');
    expect(parseAmountUnits('for $5')).toBe(5_000_000);
    expect(parseAmountUnits('$2.5 each')).toBe(2_500_000);
    expect(parseAmountUnits('ten bucks')).toBe(10_000_000);
  });

  it('asks Stake each? and attempts, then yields YAML the engine accepts', async () => {
    const r1 = await compile("I bet Sam can't get a paper ball in the trash can from behind that line");
    expect(r1.title).toBe('Paper ball shot');
    expect(r1.yaml).toBeNull();
    expect(r1.questions.map((q) => q.id)).toEqual(['stake', 'attempts', 'line']);
    expect(r1.questions.find((q) => q.id === 'line')).toMatchObject({ kind: 'region', entity: 'line', text: 'Where is the throw line?' });
    for (const q of r1.questions) expect(q.text.split(' ').length).toBeLessThanOrEqual(6);

    const r2 = await compile("I bet Sam can't get a paper ball in the trash can. Three tries, $5", []);
    expect(r2.questions.map((q) => q.id)).toEqual(['line']); // region never blocks
    expect(r2.yaml).not.toBeNull();
    const parsed = parseYaml(r2.yaml!, cctx);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (parsed.ok) {
      expect(parsed.program.stake_each).toBe(5_000_000);
      expect(parsed.program.legs).toHaveLength(1);
    }
    expect(r2.labels['shooter']).toBe('Sam');
  });

  it('cup tower, push-ups and ai_judged all parse', async () => {
    for (const text of [
      'the cup tower survives the fan for 10 seconds, $2',
      'I can do 20 push-ups in 60 seconds for $10',
      'Sam finishes the hot sauce wing without drinking anything, $3',
    ]) {
      const r = await compile(text);
      expect(r.yaml, text).not.toBeNull();
      const parsed = parseYaml(r.yaml!, cctx);
      expect(parsed.ok, `${text}\n${r.yaml}\n${JSON.stringify(parsed)}`).toBe(true);
    }
    const ai = await compile('Sam finishes the hot sauce wing without drinking anything, $3');
    expect(ai.kind).toBe('ai_judged');
    expect(ai.title).toBe('Sam finishes the hot sauce');
  });

  it("asks Who's in? with more than two members", async () => {
    const third = generateKeypair().publicKey;
    const r = await compiler.compile({
      transcript: 'the cup tower survives the fan, $1',
      creator_user_id: 'u-creator',
      members: [...members, { user_id: 'u-3', display_name: 'Kim', wallet: third }],
    });
    expect(r.questions[0]).toMatchObject({ id: 'who', kind: 'multi', chips: ['Sam', 'Kim'] });
    const r2 = await compiler.compile({
      transcript: 'the cup tower survives the fan, $1',
      creator_user_id: 'u-creator',
      members: [...members, { user_id: 'u-3', display_name: 'Kim', wallet: third }],
      answers: [{ question_id: 'who', answer: 'Kim' }],
    });
    const parsed = parseYaml(r2.yaml!, { creator, huddle: [...cctx.huddle, { wallet: third, display_name: 'Kim', enrolled: true }] });
    expect(parsed.ok, `${r2.yaml}\n${JSON.stringify(parsed)}`).toBe(true);
    if (parsed.ok) expect(parsed.program.participants).toEqual([creator, third]);
  });
});

describe('mock identity / detector / voice', () => {
  it('embeddings match the same person and not others (closed set, §8.3)', async () => {
    const id = new MockIdentity();
    const a1 = await id.embedFace(new Uint8Array([1, 2, 3]), { subject_user_id: 'alice' });
    const a2 = await id.embedFace(new Uint8Array([9, 9]), { subject_user_id: 'alice' });
    const b = await id.embedFace(new Uint8Array([1, 2, 3]), { subject_user_id: 'bob' });
    expect(a1).toHaveLength(FACE_DIM);
    expect((await id.embedVoice(new Uint8Array([1]), { subject_user_id: 'alice' })).length).toBe(VOICE_DIM);
    const q = (v: number[]) => quantizeEmbedding(Float32Array.from(v));
    expect(cosineBps(q(a1), q(a2))).toBeGreaterThan(9000);
    expect(cosineBps(q(a1), q(b))).toBeLessThan(3000);
    const m = closedSetMatch(q(a2), [{ candidate: 0, template: q(b) }, { candidate: 1, template: q(a1) }], 'face');
    expect(m.matched).toBe(true);
    expect(m.best).toBe(1);
    // deterministic
    expect(await id.embedFace(new Uint8Array([1, 2, 3]), { subject_user_id: 'alice' })).toEqual(a1);
  });

  it('detector returns calibration refs, else a deterministic layout, conf 90', async () => {
    const d = new MockDetector();
    const ents = [{ entity: 'ball', phrase: 'ball' }, { entity: 'can', phrase: 'can' }];
    const r1 = await d.detect(new Uint8Array(), { bet: 'B', entities: ents, calibration: null });
    expect(r1[0]).toEqual({ entity: 'ball', bbox: mockLayoutBox('B', 'ball'), conf: 90 });
    const cal = {
      version: 1 as const,
      scene: { camera: { width_px: 1920, height_px: 1080, orientation: 'landscape' as const }, entity_refs: [{ entity: 'can', label: 'Can', bbox: [1, 2, 3, 4] as [number, number, number, number] }] },
      regions: [],
    };
    const r2 = await d.detect(new Uint8Array(), { bet: 'B', entities: ents, calibration: cal });
    expect(r2[1]!.bbox).toEqual([1, 2, 3, 4]);
    for (const x of r1) for (const v of x.bbox) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('STT fallbacks and TTS WAV', async () => {
    const stt = new MockStt();
    expect((await stt.transcribe(new Uint8Array(), { mock_transcript: 'hello', draft_transcript: 'x' })).text).toBe('hello');
    expect((await stt.transcribe(new Uint8Array(), { draft_transcript: 'draft' })).text).toBe('draft');
    expect((await stt.transcribe(new Uint8Array(), { challenge_phrase: 'I accept red fox' })).text).toBe('I accept red fox');
    const wav = await new MockTts().synthesize('one two three four');
    const d = decodeWav(wav.bytes);
    expect(d.sampleRate).toBe(16000);
    expect(d.samples.length).toBe(16000);
  });
});

describe('mock booth', () => {
  const base: BoothCase = {
    bet: 'B',
    program: { outcome: { if_true: 0, else: 1, condition: { op: 'yes' } } } as never,
    readback: ['Sam makes the shot'],
    preruling: 1,
    preruling_side: 1,
    reason: 0,
    ai_judged: false,
    question: null,
    transcript: '',
    exhibits: [{ id: 'E1', kind: 'clip', witness: 'cam1', t_start_ms: 12_400, t_end_ms: 16_400 }],
  };

  it('judges vote the pre-ruling at 8000; ai_judged yes/no at 7000', () => {
    expect(mockJudgeVote(base)).toMatchObject({ outcome: 2, confidence_bps: 8000 });
    expect(mockJudgeVote({ ...base, preruling: 3, preruling_side: null })).toMatchObject({ outcome: 0 });
    expect(mockJudgeVote({ ...base, ai_judged: true, transcript: 'yes he did' })).toMatchObject({ outcome: 1, confidence_bps: 7000 });
    expect(mockJudgeVote({ ...base, ai_judged: true, transcript: 'no he did not' })).toMatchObject({ outcome: 2, confidence_bps: 7000 });
  });

  it('advocates cite valid exhibits only', async () => {
    const b = await new MockAdvocate().brief(base, 0, 3);
    expect(b.exhibits).toEqual(['E1']);
    expect(b.citations).toEqual(['cam1@12.4s']);
    expect(b.claim.length).toBeLessThanOrEqual(600);
  });
});

describe('mock perception', () => {
  it('runs engine.simulate for both hosts', async () => {
    const r = await new MockCompiler().compile({
      transcript: 'the cup tower survives the fan for 10 seconds, $2',
      creator_user_id: 'u-creator',
      members,
    });
    const parsed = parseYaml(r.yaml!, cctx);
    if (!parsed.ok) throw new Error('parse');
    const pair = await new MockPerception('pass').runPair({
      bet: generateKeypair().publicKey,
      program: parsed.program,
      calibration: { version: 1, scene: { camera: { width_px: 1280, height_px: 720, orientation: 'landscape' }, entity_refs: [] }, regions: [] },
      offset_ms: 0,
      video_urls: [],
      prompts: [],
      need_pose: false,
      need_reid: false,
      seed: 1,
    });
    expect(pair.a.session).not.toBeNull();
    expect(pair.b.session).not.toBeNull();
    expect(pair.a.network).toBe('mock');
    const cal = { version: 1 as const, scene: { camera: { width_px: 1280, height_px: 720, orientation: 'landscape' as const }, entity_refs: [] }, regions: [] };
    // pass scenario: the two hosts agree (the pipeline then seals the cross-check flag)
    expect(crossCheck(pair.a.session!, pair.b.session!, parsed.program, cal).ok).toBe(true);
    const res = evaluateSession(parsed.program, cal, pair.a.session!, []);
    expect(res.reason).toBe(12); // CROSS_CHECK_FAILED until the flag is sealed by the pipeline
  });
});

describe('mock gemini', () => {
  it('serves fixtures, search and a deterministic price walk', async () => {
    const g = new MockGemini(new ManualClock());
    const all = await g.listEvents(null, 100);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect((await g.listEvents('crypto', 10)).every((e) => e.category === 'Crypto')).toBe(true);
    expect(await g.getEvent('nope')).toBeNull();
    expect(mockWalkPrice('E', 'C', 5000, 10)).toBe(mockWalkPrice('E', 'C', 5000, 10));
    expect(probBpsFromPrices(0.61, 0.63, null)).toBe(6200);
    expect(probBpsFromPrices(null, 0.3, 0.25)).toBe(2500);
  });
});

describe('real providers (fake fetch, no network)', () => {
  it('HttpPerception runs two §6.0 jobs; host A = first done', async () => {
    const posted: unknown[] = [];
    let polls = 0;
    const fake = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/jobs') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ job_id: `j${posted.length}` }));
      }
      if (url.includes('/jobs/')) {
        const id = url.split('/').pop()!;
        polls++;
        const done = id === 'j2' || polls > 3;
        return new Response(
          JSON.stringify({
            status: done ? 'done' : 'running',
            model_hash: 'ab'.repeat(32),
            flags: 0,
            detections_url: `http://x/det/${id}`,
            host: { provider: 'io.net', job_id: id, url: null, market: null },
          }),
        );
      }
      return new Response('{"t_ms":0,"entity":"ball","track_id":1,"bbox_px":[0,0,1,1],"mask_area_px":1,"confidence":0.9}\n');
    }) as typeof fetch;
    const cfg = loadConfig(testEnv({ ALLOW_SPEND: '1' }));
    const p = new HttpPerception(cfg, { baseUrl: 'http://perc', fetch: fake, pollIntervalMs: 1 });
    const r = await p.runPair({
      bet: 'B',
      program: {} as never,
      calibration: null,
      offset_ms: 5,
      video_urls: [],
      prompts: [{ entity: 'ball', phrase: 'ball' }],
      need_pose: false,
      need_reid: false,
      seed: 0,
    });
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({ bet: 'B', fps: 10, offset_ms: 5 });
    expect(r.a.host.job_id).toBe('j2');
    expect(r.a.raw).toHaveLength(1);
    expect(() => new HttpPerception(loadConfig(testEnv()), { baseUrl: 'http://perc' })).toThrow(/ALLOW_SPEND|SPEND/);
  });

  it('HttpEmbedder validates dimensions and normalizes', async () => {
    const fake = (async (url: string) =>
      new Response(
        JSON.stringify(url.endsWith('/face') ? { embeddings: [Array(FACE_DIM).fill(2)] } : { embedding: Array(5).fill(1) }),
      )) as typeof fetch;
    const e = new HttpEmbedder('http://emb', fake);
    const v = await e.embedFace(new Uint8Array([1]));
    expect(Math.abs(v.reduce((a, x) => a + x * x, 0) - 1)).toBeLessThan(1e-9);
    await expect(e.embedVoice(new Uint8Array([1]))).rejects.toThrow(/192/);
  });
});

describe('devnet log parsing', () => {
  it('extracts Verdict events only from the Verdict program frame', () => {
    const pid = generateKeypair().publicKey;
    const bet = generateKeypair().publicKey;
    const data = Buffer.from(encodeEvent('BetCancelled', { bet })).toString('base64');
    const logs = [
      `Program ComputeBudget111111111111111111111111111111 invoke [1]`,
      `Program ComputeBudget111111111111111111111111111111 success`,
      `Program ${pid} invoke [1]`,
      `Program log: Instruction: Cancel`,
      `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]`,
      `Program data: ${data}`,
      `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success`,
      `Program data: ${data}`,
      `Program ${pid} success`,
    ];
    const evs = parseProgramLogs(logs, pid);
    expect(evs).toEqual([{ name: 'BetCancelled', data: { bet } }]);
  });
});

describe('keeper (§12.6 scheduler)', () => {
  it('runs tasks on every mock-clock tick, coalesces overlaps, isolates failures', async () => {
    const clock = new ManualClock();
    const errors: unknown[] = [];
    const k = new Keeper({ clock, log: { error: (o) => errors.push(o) } });
    const runs: number[] = [];
    k.register({ name: 'boom', run: () => { throw new Error('x'); } });
    k.register({ name: 'record', run: (now) => { runs.push(now); } });
    k.start();
    clock.advance(1000);
    clock.advance(1000);
    await k.tick();
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(errors.length).toBe(runs.length);
    k.stop();
    const n = runs.length;
    clock.advance(1000);
    await new Promise((r) => setImmediate(r));
    expect(runs.length).toBe(n);
    expect(k.taskNames).toEqual(['boom', 'record']);
  });
});
