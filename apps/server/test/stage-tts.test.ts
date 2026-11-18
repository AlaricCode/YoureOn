// The stage TTS service (src/voice/tts.ts) without a database: the gate (no key / no spend /
// STAGE_TTS=off means no client and no network), the ElevenLabs request it sends, the clip cache
// (memory LRU + disk) and in-flight dedupe, the three panel voices, and SFX_PROVIDER=auto.
// ElevenLabs is never called: every client here runs on a fake fetch.
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvError } from '../src/env';
import { silentLogger } from '../src/log';
import { createProviders, providerModes } from '../src/providers/registry';
import {
  createElevenLabsClient,
  EL_TTS_OUTPUT_FORMAT,
  type FetchLike,
} from '../src/voice/elevenlabs';
import {
  ClipCache,
  clipIdOf,
  createStageTts,
  DEFAULT_STAGE_VOICES,
  stageAudioGate,
  stageVoiceIds,
  StageTts,
} from '../src/voice/tts';
import { testEnv } from './helpers';

const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 1, 2, 3]);
const KEYED = { ELEVENLABS_API_KEY: 'el-test-key', ALLOW_SPEND: 'true' };

/** A fake ElevenLabs: records each request, answers MP3 bytes (or what `answer` says). */
function fakeEl(answer: (n: number) => Response | Promise<Response> = () => new Response(MP3)) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return answer(calls.length);
  };
  return { fetch, calls };
}

const neverFetch = async (): Promise<Response> => {
  throw new Error('network must not be called');
};

function tts(o: { fetch: FetchLike; cache?: ClipCache; model?: string }) {
  return new StageTts({
    client: createElevenLabsClient({ apiKey: 'k', fetch: o.fetch }),
    model: o.model ?? 'eleven_v4_turbo',
    voices: { ...DEFAULT_STAGE_VOICES },
    cache: o.cache ?? new ClipCache({ dir: null }),
    log: silentLogger,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('gate: no key, no spend, or STAGE_TTS=off -> no clip and no network', () => {
  it('stageAudioGate', () => {
    expect(stageAudioGate(testEnv())).toEqual({ on: false, reason: 'no_key' });
    expect(stageAudioGate(testEnv({ ELEVENLABS_API_KEY: 'k' }))).toEqual({
      on: false,
      reason: 'spend_disabled',
    });
    expect(stageAudioGate(testEnv({ ...KEYED, STAGE_TTS: 'off' }))).toEqual({
      on: false,
      reason: 'off',
    });
    expect(stageAudioGate(testEnv(KEYED))).toEqual({ on: true });
    expect(stageAudioGate(testEnv({ ...KEYED, STAGE_TTS: 'on' }))).toEqual({ on: true });
    expect(() => testEnv({ STAGE_TTS: 'loud' })).toThrow(EnvError);
  });

  it('createStageTts builds nothing when the gate is closed', () => {
    expect(createStageTts(testEnv(), { log: silentLogger, fetch: neverFetch })).toBeNull();
    expect(
      createStageTts(testEnv({ ...KEYED, STAGE_TTS: 'off' }), {
        log: silentLogger,
        fetch: neverFetch,
      }),
    ).toBeNull();
    const on = createStageTts(testEnv(KEYED), { log: silentLogger, fetch: neverFetch });
    expect(on?.model).toBe('eleven_v4_turbo'); // API-CONTRACT §4.1 TTS model
    expect(
      createStageTts(testEnv({ ...KEYED, STAGE_TTS_MODEL: 'eleven_flash_v2' }), {
        log: silentLogger,
      })?.model,
    ).toBe('eleven_flash_v2');
  });
});

describe('the ElevenLabs request', () => {
  it('POST /v1/text-to-speech/{voice_id}, mp3 output, xi-api-key, {text, model_id}', async () => {
    const el = fakeEl();
    const s = tts({ fetch: el.fetch });
    const clip = s.clip('judge', 'Jake wins. Two full rotations.');
    expect(clip.clip_id).toBe(
      clipIdOf(DEFAULT_STAGE_VOICES.judge, 'eleven_v4_turbo', 'Jake wins. Two full rotations.'),
    );
    expect(clip.audio_url).toBe(`/v1/stage/tts/${clip.clip_id}`);
    expect(await s.bytes(clip.clip_id)).toEqual(MP3);
    expect(el.calls).toHaveLength(1);
    const { url, init } = el.calls[0]!;
    expect(url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_STAGE_VOICES.judge}?output_format=${EL_TTS_OUTPUT_FORMAT}`,
    );
    expect(EL_TTS_OUTPUT_FORMAT).toMatch(/^mp3_/);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    expect((init.headers as Record<string, string>).accept).toBe('audio/mpeg');
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Jake wins. Two full rotations.',
      model_id: 'eleven_v4_turbo',
    });
  });

  it('an HTTP error or an empty body is an UpstreamError, never echoing the body', async () => {
    const el = fakeEl((n) =>
      n === 1 ? new Response('quota for key el-test-key', { status: 429 }) : new Response(''),
    );
    const s = tts({ fetch: el.fetch });
    const { clip_id } = s.clip('judge', 'Paid. Jake takes $2.00.');
    await expect(s.bytes(clip_id)).rejects.toThrow(/^ElevenLabs TTS (HTTP 429|returned no audio)$/);
    await expect(s.bytes(clip_id)).rejects.toThrow('ElevenLabs TTS returned no audio');
  });
});

describe('cache', () => {
  it('a line is generated once: clip() prefetches, GETs and repeats hit the cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const el = fakeEl(async () => {
      await gate;
      return new Response(MP3);
    });
    const s = tts({ fetch: el.fetch });
    const a = s.clip('judge', 'Run it back. The bottle left the frame.');
    // two GETs while the generation runs wait for the same request
    const both = Promise.all([s.bytes(a.clip_id), s.bytes(a.clip_id)]);
    await new Promise((r) => setTimeout(r, 10));
    expect(el.calls).toHaveLength(1);
    release();
    expect(await both).toEqual([MP3, MP3]);
    // the same line again (a second REDO): no new request
    const again = s.clip('judge', 'Run it back. The bottle left the frame.');
    expect(again.clip_id).toBe(a.clip_id);
    expect(await s.bytes(again.clip_id)).toEqual(MP3);
    expect(el.calls).toHaveLength(1);
    expect(s.requests).toBe(1);
    // another voice saying the same words is another clip
    const seat = s.clip('seat_1', 'Run it back. The bottle left the frame.');
    expect(seat.clip_id).not.toBe(a.clip_id);
    await s.bytes(seat.clip_id);
    expect(el.calls).toHaveLength(2);
  });

  it('a failed generation is not cached: the next GET asks again', async () => {
    const el = fakeEl((n) => (n === 1 ? new Response('', { status: 500 }) : new Response(MP3)));
    const s = tts({ fetch: el.fetch });
    const { clip_id } = s.clip('judge', 'Paid. Logan takes $4.00.');
    await new Promise((r) => setTimeout(r, 10)); // the prefetch fails
    expect(await s.bytes(clip_id)).toEqual(MP3);
    expect(el.calls).toHaveLength(2);
  });

  it('unknown or malformed ids: null, no request', async () => {
    const el = fakeEl();
    const s = tts({ fetch: el.fetch });
    expect(await s.bytes('f'.repeat(64))).toBeNull();
    expect(await s.bytes('../../etc/passwd')).toBeNull();
    expect(el.calls).toHaveLength(0);
  });

  it('disk: a new process serves a clip it never generated, without a request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'yo-tts-'));
    const first = fakeEl();
    const a = tts({ fetch: first.fetch, cache: new ClipCache({ dir }) });
    const { clip_id } = a.clip('seat_2', 'Judge 2, GPT, votes Logan.');
    expect(await a.bytes(clip_id)).toEqual(MP3);
    expect(readdirSync(dir)).toEqual([`${clip_id}.mp3`]);
    const b = tts({ fetch: neverFetch, cache: new ClipCache({ dir }) });
    expect(await b.bytes(clip_id)).toEqual(MP3);
  });

  it('ClipCache: memory is capped in bytes, least recently used out first', async () => {
    const c = new ClipCache({ dir: null, maxBytes: 10 });
    const id = (n: number) => String(n).repeat(64).slice(0, 64);
    await c.put(id(1), new Uint8Array(4));
    await c.put(id(2), new Uint8Array(4));
    await c.get(id(1)); // 1 is now the most recent
    await c.put(id(3), new Uint8Array(4));
    expect(await c.get(id(2))).toBeNull();
    expect(await c.get(id(1))).not.toBeNull();
    expect(await c.get(id(3))).not.toBeNull();
    expect(c.size.bytes).toBeLessThanOrEqual(10);
    await c.put(id(4), new Uint8Array(11)); // larger than the cap: not kept
    expect(await c.get(id(4))).toBeNull();
  });
});

describe('three appeal voices (API-CONTRACT §4.5)', () => {
  it('the judge and three seats are four distinct voices; the env overrides them', async () => {
    const d = stageVoiceIds(testEnv());
    expect(new Set(Object.values(d)).size).toBe(4);
    const o = stageVoiceIds(
      testEnv({ ELEVENLABS_JUDGE_VOICE_ID: 'vJudge', ELEVENLABS_PANEL_VOICE_IDS: 'v1, v2 ,v3' }),
    );
    expect(o).toEqual({ judge: 'vJudge', seat_1: 'v1', seat_2: 'v2', seat_3: 'v3' });
    expect(() => testEnv({ ELEVENLABS_PANEL_VOICE_IDS: 'v1,v2' })).toThrow(EnvError);
    expect(() => testEnv({ ELEVENLABS_PANEL_VOICE_IDS: 'v1,v1,v2' })).toThrow(EnvError);

    const el = fakeEl();
    const s = tts({ fetch: el.fetch });
    for (const seat of ['seat_1', 'seat_2', 'seat_3'] as const)
      await s.bytes(s.clip(seat, 'Judge votes Logan.').clip_id);
    const voices = el.calls.map((c) => new URL(c.url).pathname.split('/').pop());
    expect(voices).toEqual([
      DEFAULT_STAGE_VOICES.seat_1,
      DEFAULT_STAGE_VOICES.seat_2,
      DEFAULT_STAGE_VOICES.seat_3,
    ]);
  });
});

describe('SFX_PROVIDER=auto (the default): live only behind the key', () => {
  it('mock without the key or the spend switch, or with STAGE_TTS=off; live with both', () => {
    expect(testEnv().SFX_PROVIDER).toBe('auto');
    const sfx = (env: Record<string, string>) =>
      providerModes(createProviders(testEnv(env), { fetch: neverFetch })).sfx;
    expect(sfx({})).toBe('mock');
    expect(sfx({ ELEVENLABS_API_KEY: 'k' })).toBe('mock');
    expect(sfx({ ...KEYED, STAGE_TTS: 'off' })).toBe('mock');
    expect(sfx(KEYED)).toBe('live');
    expect(sfx({ ...KEYED, SFX_PROVIDER: 'mock' })).toBe('mock');
    // an explicit live without the key still fails at boot, as before
    expect(() => sfx({ ALLOW_SPEND: 'true', SFX_PROVIDER: 'live' })).toThrow(/ELEVENLABS_API_KEY/);
  });
});
