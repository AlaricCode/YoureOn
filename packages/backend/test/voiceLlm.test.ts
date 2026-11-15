import { describe, expect, it } from 'vitest';
import { parseYaml } from '@verdict/engine';
import { generateKeypair } from '../src/crypto/keys.js';
import {
  ElevenLabsAgent,
  ElevenLabsClient,
  ElevenLabsSfx,
  ElevenLabsStt,
  ElevenLabsTts,
  scribeToTranscript,
} from '../src/providers/real/elevenlabs.js';
import { extractJson, LlmCompiler, toCompileResult } from '../src/providers/real/compilerLlm.js';
import { llmEndpoint } from '../src/providers/real/llm.js';
import { acceptPhraseHeard, normalizeTranscript, pickSpeaker, sliceWav } from '../src/voice/transcript.js';
import { decodeWav, encodeWav } from '../src/util/wav.js';
import { testConfig } from './helpers.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response): { f: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

describe('spend guard', () => {
  it('refuses paid ElevenLabs and LLM modes without ALLOW_SPEND', () => {
    const cfg = testConfig();
    expect(() => new ElevenLabsStt(cfg)).toThrow(/SPEND_DISABLED/);
    expect(() => new ElevenLabsTts(cfg)).toThrow(/SPEND_DISABLED/);
    expect(() => new ElevenLabsAgent(cfg)).toThrow(/SPEND_DISABLED/);
    expect(() => llmEndpoint(cfg, 'anthropic', 'COMPILER_PROVIDER')).toThrow(/SPEND_DISABLED/);
  });
});

describe('ElevenLabs adapters (fake fetch)', () => {
  it('Scribe: diarized words → speaker segments + audio events', async () => {
    const { f, calls } = fakeFetch(() =>
      json({
        text: 'come on (laughter) I accept river tiger',
        words: [
          { text: 'come', start: 0.0, end: 0.2, type: 'word', speaker_id: 'speaker_0' },
          { text: ' ', start: 0.2, end: 0.25, type: 'spacing', speaker_id: 'speaker_0' },
          { text: 'on', start: 0.25, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
          { text: '(laughter)', start: 0.45, end: 0.6, type: 'audio_event', speaker_id: 'speaker_0' },
          { text: 'I', start: 0.7, end: 0.8, type: 'word', speaker_id: 'speaker_1' },
          { text: ' ', start: 0.8, end: 0.82, type: 'spacing', speaker_id: 'speaker_1' },
          { text: 'accept', start: 0.82, end: 1.1, type: 'word', speaker_id: 'speaker_1' },
          { text: 'river', start: 1.2, end: 1.4, type: 'word', speaker_id: 'speaker_1' },
          { text: 'tiger', start: 1.45, end: 1.7, type: 'word', speaker_id: 'speaker_1' },
        ],
      }),
    );
    const stt = new ElevenLabsStt(new ElevenLabsClient({ apiKey: 'k', fetch: f }));
    const t = await stt.transcribe(new Uint8Array([1, 2, 3]));
    expect(calls[0]!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((calls[0]!.init.headers as Record<string, string>)['xi-api-key']).toBe('k');
    const form = calls[0]!.init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('diarize')).toBe('true');
    expect(form.get('tag_audio_events')).toBe('true');
    expect(t.segments).toEqual([
      { start_ms: 0, end_ms: 400, speaker: 'speaker_0', text: 'come on' },
      { start_ms: 700, end_ms: 1700, speaker: 'speaker_1', text: 'I accept river tiger' },
    ]);
    expect(t.audio_events).toEqual([{ t_ms: 450, label: 'laughter' }]);
    const pick = pickSpeaker(t, (x) => acceptPhraseHeard(x, ['river', 'tiger']));
    expect(pick?.speaker).toBe('speaker_1');
  });

  it('TTS, SFX (cached) and Agent signed URL', async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
    const { f, calls } = fakeFetch((url) =>
      url.includes('get-signed-url') ? json({ signed_url: 'wss://api.elevenlabs.io/v1/convai/x?token=1' }) : new Response(mp3, { status: 200 }),
    );
    const client = new ElevenLabsClient({ apiKey: 'k', fetch: f, agentId: 'agent_1' });
    const a = await new ElevenLabsTts(client).synthesize('Bob wins $5.00');
    expect(a).toEqual({ mime: 'audio/mpeg', bytes: mp3 });
    expect(calls[0]!.url).toMatch(/\/v1\/text-to-speech\/[^/]+\?output_format=mp3_44100_128$/);
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ text: 'Bob wins $5.00' });
    const sfx = new ElevenLabsSfx(client);
    await sfx.startSound();
    await sfx.startSound();
    expect(calls.filter((c) => c.url.endsWith('/v1/sound-generation'))).toHaveLength(1);
    expect(JSON.parse(calls[1]!.init.body as string).duration_seconds).toBeLessThanOrEqual(1.5);
    const s = await new ElevenLabsAgent(client).createSession();
    expect(s).toEqual({ mode: 'elevenlabs', signed_url: 'wss://api.elevenlabs.io/v1/convai/x?token=1' });
    expect(calls.at(-1)!.url).toContain('agent_id=agent_1');
  });

  it('surfaces HTTP errors', async () => {
    const { f } = fakeFetch(() => new Response('quota', { status: 429 }));
    await expect(new ElevenLabsTts(new ElevenLabsClient({ apiKey: 'k', fetch: f })).synthesize('hi')).rejects.toThrow(/HTTP 429/);
  });
});

describe('transcript helpers', () => {
  it('normalizes and matches the accept phrase as whole words', () => {
    expect(normalizeTranscript("I ACCEPT, River-Tiger!")).toBe('i accept river tiger');
    expect(acceptPhraseHeard('Okay... I accept river tiger.', ['river', 'tiger'])).toBe(true);
    expect(acceptPhraseHeard('I accept rivers tiger', ['river', 'tiger'])).toBe(false);
    expect(acceptPhraseHeard('river tiger', ['river', 'tiger'])).toBe(false);
  });

  it('slices a WAV down to the speaker segments', () => {
    const wav = encodeWav(new Int16Array(16000), 16000); // 1 s
    const out = decodeWav(sliceWav(wav, [{ start_ms: 200, end_ms: 400, speaker: 's', text: 'x' }], 0));
    expect(out.samples.length).toBe(3200);
  });
});

describe('LLM compiler (fake fetch)', () => {
  const members = [
    { user_id: 'u0', display_name: 'Alice', wallet: generateKeypair().publicKey },
    { user_id: 'u1', display_name: 'Maya', wallet: generateKeypair().publicKey },
  ];
  const yaml = [
    'version: 2',
    'entities:',
    '  me: person(p0)',
    'legs:',
    '  - id: 1',
    '    actor_bound: true',
    '    success: rep_count(me) >= 20',
    '    rule: success before 60s',
    'outcome: side(me) wins iff leg 1 true; else side(other)',
    'stake_each: 10_000_000',
    'time_limit_s: 90',
  ].join('\n');
  const answer = { kind: 'rules', title: 'Twenty push-ups in a minute flat', yaml, questions: [], labels: { me: 'Alice' } };

  it.each(['anthropic', 'openai', 'gemini', 'xai'] as const)('%s adapter returns parseable YAML', async (provider) => {
    const text = '```json\n' + JSON.stringify(answer) + '\n```';
    const { f, calls } = fakeFetch(() => {
      switch (provider) {
        case 'anthropic':
          return json({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
        case 'gemini':
          return json({ candidates: [{ content: { parts: [{ text }] } }] });
        default:
          return json({ choices: [{ message: { content: text } }] });
      }
    });
    const c = new LlmCompiler({ provider, apiKey: 'k', baseUrl: 'https://llm.test' }, { fetch: f });
    const r = await c.compile({ transcript: 'I bet I can do 20 push-ups in a minute, ten bucks', creator_user_id: 'u0', members });
    expect(r.title).toBe('Twenty push-ups in a minute');
    expect(r.source).toMatch(new RegExp(`^${provider}:`));
    const parsed = parseYaml(r.yaml!, { creator: members[0]!.wallet, huddle: members.map((m) => ({ ...m, enrolled: true })) });
    expect(parsed.ok).toBe(true);
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(JSON.stringify(body)).toContain('push-ups');
    if (provider === 'anthropic') {
      expect(calls[0]!.url).toBe('https://llm.test/v1/messages');
      expect(body.model).toBe('claude-opus-5-5');
      expect((calls[0]!.init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    }
  });

  it('feeds engine errors back on recompile', async () => {
    const { f, calls } = fakeFetch(() => json({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    const c = new LlmCompiler({ provider: 'openai', apiKey: 'k', baseUrl: 'https://llm.test' }, { fetch: f });
    await c.compile({ transcript: 'x', creator_user_id: 'u0', members, errors: [{ path: 'legs[0].rule', code: 'BAD_RULE', message: 'm' }], rejected_yaml: 'bad' });
    const user = JSON.parse(JSON.parse(calls[0]!.init.body as string).messages[1].content);
    expect(user.validation_errors[0].code).toBe('BAD_RULE');
    expect(user.rejected_yaml).toBe('bad');
    expect(user.members).toEqual([{ ref: 'p0', name: 'Alice', creator: true }, { ref: 'p1', name: 'Maya', creator: false }]);
  });

  it('sanitizes model output', () => {
    expect(() => extractJson('no json here')).toThrow();
    const r = toCompileResult(
      { kind: 'weird', title: '', yaml: '', questions: [{ id: 'stake', text: 'How much should each person stake today?', kind: 'choice', chips: ['$1', 2] }, { id: 'x', kind: 'nope', text: 't' }], labels: { ball: 'Small Red Paper Ball' } },
      'test',
    );
    expect(r).toEqual({
      kind: 'rules',
      title: null,
      yaml: null,
      questions: [{ id: 'stake', text: 'How much should each person stake', kind: 'choice', chips: ['$1'], audio_url: null }],
      labels: { ball: 'Small Red Paper' },
      source: 'test',
    });
  });
});
