/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies and WS frames are loosely typed in tests */
// The projector's voice over HTTP + WS + Postgres (src/stage/voice.ts, src/stage/audio.ts):
// a ruling, a payout and three appeal votes reach the stage as stage.voice frames whose
// audio_url (GET /v1/stage/tts/:clip_id, stage bearer only, immutable) is the ElevenLabs clip of
// the stage line; the phones never get the frame. With the TTS off nothing is generated and the
// stage speaks for itself. A bet the voice judge hosts (A's phone relays its judge.line
// transcript) leaves its ruling and payout to the phone: one judge voice in the hall. The cues'
// Sound Effects clips when SFX is live. ElevenLabs is a fake.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb } from '@youre-on/db';
import { WsServerControlFrame } from '@youre-on/shared/api';
import { buildApp } from '../src/app';
import { judgeCue } from '../src/bets/cues';
import { silentLogger } from '../src/log';
import type { AudioBlob, SfxCue, SfxProvider } from '../src/providers/types';
import { emitBetEvent } from '../src/realtime/events';
import { routeModules } from '../src/routes';
import { createDeps } from '../src/server';
import { CLIP_CACHE_CONTROL } from '../src/stage/audio';
import { StageVoice } from '../src/stage/voice';
import { createElevenLabsClient, type FetchLike } from '../src/voice/elevenlabs';
import { ClipCache, DEFAULT_STAGE_VOICES, StageTts } from '../src/voice/tts';
import {
  connectWs,
  describeDb,
  postJson,
  signedHeaders,
  signUp,
  startTestServer,
  testEnv,
  type Ctx,
  type SignedUp,
  type WsClient,
} from './helpers';

const STAGE_KEY = 'stage-key-for-stage-voice';
const ORIGIN = 'http://localhost:5173';
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 9, 9, 9]);
const SFX_MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 5, 5]);
const RULING = (
  JSON.parse(
    readFileSync(
      new URL('../../../packages/shared/test/vectors/ruling-v1-001.json', import.meta.url),
      'utf8',
    ),
  ) as { input: Record<string, unknown> }
).input;

function fakeEl() {
  const calls: Array<{ url: string; body: any }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(MP3);
  };
  return { fetch, calls };
}

const fakeTts = (fetch: FetchLike) =>
  new StageTts({
    client: createElevenLabsClient({ apiKey: 'k', fetch }),
    model: 'eleven_v4_turbo',
    voices: { ...DEFAULT_STAGE_VOICES },
    cache: new ClipCache({ dir: null }),
    log: silentLogger,
  });

const vote = (betId: string, seat: number, counted: 'A_WINS' | 'B_WINS' | 'ABSTAIN') => ({
  vote: {
    schema_version: 1,
    appeal_id: '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516',
    bet_id: betId,
    seat,
    provider: (['anthropic', 'openai', 'google'] as const)[seat],
    model: 'm',
    status: 'ok',
    outcome: counted === 'ABSTAIN' ? 'REDO' : counted,
    confidence: counted === 'ABSTAIN' ? 0.5 : 0.9,
    reason: 'It rests on its cap.',
    counted_as: counted,
    latency_ms: 900,
    created_at: new Date().toISOString(),
  },
});

/** A server, a room with A and B, a stage on the room's socket and B's phone on the bet. */
function harness(opts: Parameters<typeof startTestServer>[0]) {
  const h = {
    ctx: null as unknown as Ctx,
    sockets: [] as WsClient[],
    post(u: SignedUp, path: string, body: unknown) {
      const raw = JSON.stringify(body);
      return postJson(h.ctx.base, path, raw, signedHeaders(u, 'POST', path, raw));
    },
    async ws() {
      const w = await connectWs(h.ctx.wsUrl);
      h.sockets.push(w);
      return w;
    },
    async get(path: string, token: string | null, headers: Record<string, string> = {}) {
      const res = await fetch(h.ctx.base + path, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      });
      return res;
    },
    async setup(o: { stage?: boolean } = {}) {
      const A = await signUp(h.ctx.base, 'Logan');
      const B = await signUp(h.ctx.base, 'Jake');
      const room = await h.post(A, '/v1/rooms', { name: 'Voice', kind: 'session' });
      expect((await h.post(B, '/v1/rooms/join', { code: room.json!.code })).status).toBe(200);
      const roomId = room.json!.room_id as string;
      const st = await postJson(h.ctx.base, '/v1/stage/session', {
        stage_key: STAGE_KEY,
        room_id: roomId,
      });
      expect(st.status).toBe(201);
      const stageToken = st.json!.token as string;
      let stage: WsClient | null = null;
      if (o.stage !== false) {
        stage = await h.ws();
        stage.send({ op: 'hello', token: stageToken, subs: [] });
        await stage.next((f) => f.op === 'welcome');
        stage.send({ op: 'subscribe_room', room_id: roomId });
      }
      const bet = await h.post(A, '/v1/bets', {
        room_id: roomId,
        opponent_user_id: B.session.user.user_id,
        challenge_method: 'list',
      });
      expect(bet.status).toBe(201);
      const betId = bet.json!.bet.bet_id as string;
      const wsB = await h.ws();
      wsB.send({ op: 'hello', token: B.session.token, device_id: B.session.device_id, subs: [] });
      await wsB.next((f) => f.op === 'welcome');
      wsB.send({ op: 'subscribe', bet_id: betId, after_seq: 0 });
      await wsB.next((f) => f.op === 'subscribed' && f.bet_id === betId);
      await new Promise((r) => setTimeout(r, 50)); // subscribe_room is handled async
      return { A, B, betId, roomId, stage, stageToken, wsB };
    },
    emit(betId: string, type: string, payload: unknown) {
      return emitBetEvent(h.ctx.deps, {
        bet_id: betId,
        type: type as any,
        payload: payload as any,
      });
    },
    start: async () => {
      h.ctx = await startTestServer({ env: { STAGE_KEY }, ...opts });
    },
    stop: async () => {
      for (const s of h.sockets) s.close();
      await h.ctx?.server.close();
    },
  };
  return h;
}

describeDb('stage voice: ElevenLabs clips on the projector (fake ElevenLabs)', () => {
  const el = fakeEl();
  const h = harness({ stageTts: fakeTts(el.fetch) });
  beforeAll(h.start);
  afterAll(h.stop);

  it('ruling.issued -> the event, then stage.voice with the clip URL; B never gets the frame', async () => {
    const s = await h.setup();
    const env = await h.emit(s.betId, 'ruling.issued', {
      ruling: { ...RULING, bet_id: s.betId },
      ruling_hash: 'a'.repeat(64),
    });
    expect(await s.stage!.next((f) => f.type === 'ruling.issued')).toMatchObject({
      seq: env.seq,
    });
    const frame = await s.stage!.next((f) => f.op === 'stage.voice');
    expect(WsServerControlFrame.parse(frame)).toEqual(frame);
    expect(frame).toMatchObject({
      op: 'stage.voice',
      bet_id: s.betId,
      seq: env.seq,
      type: 'ruling.issued',
      voice: 'judge',
      text: 'Jake wins. Two full rotations, lands upright on its base in frame 7 and stays there. Jake never touches it.',
      audio_url: `/v1/stage/tts/${frame.clip_id}`,
    });
    // the clip, with the stage bearer: immutable, ETag'd, 304 on a repeat
    const res = await h.get(frame.audio_url, s.stageToken, { Origin: ORIGIN });
    expect(res.status).toBe(200);
    // generated once, as the frame went out, in the judge's voice
    expect(el.calls.filter((c) => c.body.text === frame.text)).toEqual([
      {
        url: expect.stringContaining(`/v1/text-to-speech/${DEFAULT_STAGE_VOICES.judge}?`),
        body: { text: frame.text, model_id: 'eleven_v4_turbo' },
      },
    ]);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(res.headers.get('cache-control')).toBe(CLIP_CACHE_CONTROL);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('etag')).toBe(`"${frame.clip_id}"`);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP3);
    const again = await h.get(frame.audio_url, s.stageToken, {
      'If-None-Match': `"${frame.clip_id}"`,
    });
    expect(again.status).toBe(304);

    // B's phone got the ruling, never the stage's frame
    await s.wsB.next((f) => f.type === 'ruling.issued');
    expect(s.wsB.frames.some((f) => f.op === 'stage.voice')).toBe(false);
  });

  it('GET /v1/stage/tts/:clip_id is for stage sessions only', async () => {
    const s = await h.setup();
    await h.emit(s.betId, 'ruling.issued', {
      ruling: { ...RULING, bet_id: s.betId, outcome: 'A_WINS' },
      ruling_hash: 'b'.repeat(64),
    });
    const frame = await s.stage!.next((f) => f.op === 'stage.voice');
    expect(frame.text).toMatch(/^Logan wins\. /);
    expect((await h.get(frame.audio_url, null)).status).toBe(401);
    expect((await h.get(frame.audio_url, 'yo_s_not-a-real-token')).status).toBe(401);
    // a phone session (scope 'app') is refused as if the clip did not exist
    expect((await h.get(frame.audio_url, s.B.session.token)).status).toBe(404);
    expect((await h.get(`/v1/stage/tts/${'f'.repeat(64)}`, s.stageToken)).status).toBe(404);
    expect((await h.get('/v1/stage/tts/not-a-clip', s.stageToken)).status).toBe(404);
    expect((await h.get(frame.audio_url, s.stageToken)).status).toBe(200);
    // the status route says what is voiced
    const st = await h.get('/v1/stage/audio', s.stageToken);
    expect(await st.json()).toEqual({
      tts: true,
      tts_off: null,
      model: 'eleven_v4_turbo',
      sfx: null,
    });
    expect((await h.get('/v1/stage/audio', s.B.session.token)).status).toBe(404);
  });

  it('three appeal votes: three stage.voice frames in three distinct voices', async () => {
    const s = await h.setup();
    const before = el.calls.length;
    await h.emit(s.betId, 'appeal.vote', vote(s.betId, 0, 'A_WINS'));
    await h.emit(s.betId, 'appeal.vote', vote(s.betId, 1, 'B_WINS'));
    await h.emit(s.betId, 'appeal.vote', vote(s.betId, 2, 'ABSTAIN'));
    const frames = [
      await s.stage!.next((f) => f.op === 'stage.voice'),
      await s.stage!.next((f) => f.op === 'stage.voice'),
      await s.stage!.next((f) => f.op === 'stage.voice'),
    ].sort((a, b) => a.seq - b.seq);
    expect(frames.map((f) => [f.type, f.voice, f.text])).toEqual([
      ['appeal.vote', 'seat_1', 'Judge 1, Claude, votes Logan. It rests on its cap.'],
      ['appeal.vote', 'seat_2', 'Judge 2, GPT, votes Jake. It rests on its cap.'],
      ['appeal.vote', 'seat_3', 'Judge 3, Gemini, abstains. It rests on its cap.'],
    ]);
    await h.ctx.deps.stageVoice!.idle();
    for (const f of frames) expect((await h.get(f.audio_url, s.stageToken)).status).toBe(200);
    const voices = el.calls.slice(before).map((c) => new URL(c.url).pathname.split('/').pop());
    expect(new Set(voices)).toEqual(
      new Set([
        DEFAULT_STAGE_VOICES.seat_1,
        DEFAULT_STAGE_VOICES.seat_2,
        DEFAULT_STAGE_VOICES.seat_3,
      ]),
    );
  });

  it("the payout's PAID is voiced; the ruling-time VOIDED cue and other events are not", async () => {
    const s = await h.setup();
    const voidCue = await h.emit(
      s.betId,
      'judge.cue',
      judgeCue('VOIDED', { reason: 'max_redos', attempts: 3 }, 'Say there is no clean call.'),
    );
    const stateEv = await h.emit(s.betId, 'bet.state', {
      state: 'PAID',
      prev: 'FINALIZED',
      onchain_status: null,
      chain_ack: 'rpc',
      pending_tx: null,
      reason: null,
    });
    const paid = await h.emit(
      s.betId,
      'judge.cue',
      judgeCue(
        'PAID',
        { winner: 'Jake', amount: '$10.00', to_a: '$0.00', to_b: '$10.00' },
        'Congratulate Jake in one line.',
      ),
    );
    const frame = await s.stage!.next((f) => f.op === 'stage.voice');
    expect(frame).toMatchObject({
      seq: paid.seq,
      voice: 'judge',
      text: 'Paid. Jake takes $10.00.',
    });
    await h.ctx.deps.stageVoice!.idle();
    const seqs = s.stage!.frames.filter((f) => f.op === 'stage.voice').map((f) => f.seq);
    expect(seqs).not.toContain(voidCue.seq);
    expect(seqs).not.toContain(stateEv.seq);
  });

  it("a bet the voice judge hosts: its ruling and payout are the phone's to say (no frame, no TTS); appeal votes stay on the stage", async () => {
    const s = await h.setup();
    // A's phone relays its agent's transcript (the voice judge spoke in Beat 2)
    const relayed = await h.post(s.A, `/v1/bets/${s.betId}/voice/lines`, {
      lines: [
        {
          utterance_id: randomUUID(),
          role: 'judge',
          text: 'Logan, does a flip that lands on its cap count?',
          final: true,
          at: new Date().toISOString(),
        },
      ],
    });
    expect(relayed.status).toBe(202);
    expect(relayed.json).toMatchObject({ accepted: 1 });
    await s.stage!.next((f) => f.type === 'judge.line');
    const before = el.calls.length;
    const reason = 'The phone judge says this one.';
    const ruling = await h.emit(s.betId, 'ruling.issued', {
      ruling: { ...RULING, bet_id: s.betId, reason },
      ruling_hash: '1'.repeat(64),
    });
    const paid = await h.emit(
      s.betId,
      'judge.cue',
      judgeCue(
        'PAID',
        { winner: 'Jake', amount: '$7.00', to_a: '$0.00', to_b: '$7.00' },
        'Congratulate Jake in one line.',
      ),
    );
    const v = await h.emit(s.betId, 'appeal.vote', vote(s.betId, 1, 'B_WINS'));
    const frame = await s.stage!.next((f) => f.op === 'stage.voice');
    expect(frame).toMatchObject({ seq: v.seq, type: 'appeal.vote', voice: 'seat_2' });
    await h.ctx.deps.stageVoice!.idle();
    await new Promise((r) => setTimeout(r, 50));
    const seqs = s.stage!.frames.filter((f) => f.op === 'stage.voice').map((f) => f.seq);
    expect(seqs).toEqual([v.seq]);
    expect(seqs).not.toContain(ruling.seq);
    expect(seqs).not.toContain(paid.seq);
    // nothing billed for the lines the phone says (the vote's clip may be cached already)
    expect(el.calls.slice(before).filter((c) => c.body.text !== frame.text)).toEqual([]);

    // a restarted server (nothing in memory) reads the judge.line from bet_events
    const fresh = new StageVoice(h.ctx.deps, fakeTts(el.fetch));
    const againRuling = await h.emit(s.betId, 'ruling.issued', {
      ruling: { ...RULING, bet_id: s.betId, reason: 'After a restart, still the phone.' },
      ruling_hash: '2'.repeat(64),
    });
    await h.ctx.deps.stageVoice!.idle();
    const calls = el.calls.length;
    fresh.onBetEvent(againRuling, s.roomId);
    await fresh.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(el.calls.length).toBe(calls);
    expect(s.stage!.frames.filter((f) => f.op === 'stage.voice').map((f) => f.seq)).toEqual([
      v.seq,
    ]);

    // the same restarted server still voices a bet no phone judge hosts
    const other = await h.setup();
    const plain = await h.emit(other.betId, 'ruling.issued', {
      ruling: { ...RULING, bet_id: other.betId, reason: 'No phone judge in this one.' },
      ruling_hash: '3'.repeat(64),
    });
    // (the running server's frame first, then the restarted one's)
    await other.stage!.next((f) => f.op === 'stage.voice' && f.seq === plain.seq);
    fresh.onBetEvent(plain, other.roomId);
    await fresh.idle();
    expect(
      await other.stage!.next((f) => f.op === 'stage.voice' && f.seq === plain.seq),
    ).toMatchObject({ text: 'Jake wins. No phone judge in this one.' });
  });

  it('no stage on the room: nothing is generated (no clip nobody hears)', async () => {
    const s = await h.setup({ stage: false });
    const before = el.calls.length;
    await h.emit(s.betId, 'ruling.issued', {
      // a line never said before, so only the missing stage can explain no request
      ruling: { ...RULING, bet_id: s.betId, reason: 'Nobody is watching this one.' },
      ruling_hash: 'c'.repeat(64),
    });
    await s.wsB.next((f) => f.type === 'ruling.issued');
    await h.ctx.deps.stageVoice!.idle();
    expect(el.calls.length).toBe(before);
  });
});

describeDb('stage voice off (no ELEVENLABS_API_KEY): the stage speaks for itself', () => {
  const h = harness({});
  beforeAll(h.start);
  afterAll(h.stop);

  it('events reach the stage, no stage.voice frame, no clip route, the status says why', async () => {
    expect(h.ctx.deps.stageVoice?.tts).toBeNull();
    const s = await h.setup();
    await h.emit(s.betId, 'ruling.issued', {
      ruling: { ...RULING, bet_id: s.betId },
      ruling_hash: 'd'.repeat(64),
    });
    await s.stage!.next((f) => f.type === 'ruling.issued');
    await h.ctx.deps.stageVoice!.idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.stage!.frames.some((f) => f.op === 'stage.voice')).toBe(false);
    expect((await h.get(`/v1/stage/tts/${'a'.repeat(64)}`, s.stageToken)).status).toBe(404);
    expect((await h.get('/v1/stage/sfx/gavel', s.stageToken)).status).toBe(404);
    expect(await (await h.get('/v1/stage/audio', s.stageToken)).json()).toEqual({
      tts: false,
      tts_off: 'no_key',
      model: null,
      sfx: null,
    });
  });
});

describeDb('stage cues: ElevenLabs Sound Effects when SFX is live', () => {
  const made: SfxCue[] = [];
  const liveSfx: SfxProvider = {
    name: 'live',
    async cue(kind): Promise<AudioBlob> {
      made.push(kind);
      return { mime: 'audio/mpeg', bytes: SFX_MP3 };
    },
  };
  const h = harness({ providers: { sfx: liveSfx } });
  beforeAll(h.start);
  afterAll(h.stop);

  it('the four cues are generated at boot; GET /v1/stage/sfx/:kind serves them; stage.cue says where', async () => {
    await new Promise((r) => setTimeout(r, 50));
    expect([...made].sort()).toEqual(['buzzer', 'cheer', 'drumroll', 'gavel']);
    const s = await h.setup();
    const st = (await (await h.get('/v1/stage/audio', s.stageToken)).json()) as any;
    expect(st.sfx).toEqual({
      gavel: '/v1/stage/sfx/gavel',
      drumroll: '/v1/stage/sfx/drumroll',
      buzzer: '/v1/stage/sfx/buzzer',
      cheer: '/v1/stage/sfx/cheer',
    });
    const res = await h.get(st.sfx.gavel, s.stageToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(SFX_MP3);
    expect(made.filter((k) => k === 'gavel')).toHaveLength(1); // cached since boot
    expect((await h.get('/v1/stage/sfx/airhorn', s.stageToken)).status).toBe(404);
    expect((await h.get(st.sfx.gavel, s.B.session.token)).status).toBe(404);

    const r = await h.post(s.A, `/v1/bets/${s.betId}/cues`, { kind: 'gavel' });
    expect(r.status).toBe(202);
    expect(await s.stage!.next((f) => f.op === 'stage.cue')).toEqual({
      op: 'stage.cue',
      bet_id: s.betId,
      kind: 'gavel',
      audio_url: '/v1/stage/sfx/gavel',
    });
  });
});

describe('stage audio without a DB round trip', () => {
  it('createDeps without a key: the stage voice is off, and nothing touches the network', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { deps } = createDeps({
      env: testEnv(),
      dbHandle: createDb({ url: 'postgres://unused@127.0.0.1:1/none' }),
      rateLimit: false,
    });
    expect(deps.stageVoice?.tts).toBeNull();
    expect(deps.stageVoice?.status()).toEqual({
      tts: false,
      tts_off: 'no_key',
      model: null,
      sfx: null,
    });
    // an event for a room with no stage, and with the TTS off, is a no-op either way
    deps.hub.publishBetEvent(
      {
        v: 1,
        type: 'ruling.issued',
        bet_id: '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f',
        seq: 1,
        ts: new Date().toISOString(),
        payload: {},
      },
      '1e2d3c4b-5a69-4788-9a0b-c1d2e3f40516',
    );
    await deps.stageVoice!.idle();
    deps.stageVoice!.prewarm(); // mock SFX: nothing to generate
    expect(spy).not.toHaveBeenCalled();
  });
  it('the stage origin may fetch clips (the stage/* CORS covers /v1/stage/tts)', async () => {
    const app = buildApp(
      createDeps({
        env: testEnv({}),
        dbHandle: createDb({ url: 'postgres://unused@127.0.0.1:1/none' }),
        rateLimit: false,
      }).deps,
      routeModules,
    );
    const pre = await app.request(`/v1/stage/tts/${'a'.repeat(64)}`, {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});
