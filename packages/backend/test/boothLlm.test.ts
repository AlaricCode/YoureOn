import { describe, expect, it } from 'vitest';
import { generateKeypair } from '../src/crypto/keys.js';
import { LlmAdvocate, LlmJudge, caseParts, firstJson, sampleMjpeg } from '../src/providers/real/boothLlm.js';
import type { BoothCase } from '../src/providers/types.js';
import { silentWav } from '../src/util/wav.js';
import { fakeMjpeg } from './bweHelpers.js';

const mp4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0, 1, 2, 3, 4]);

function bcase(): BoothCase {
  const bytes: Record<string, Uint8Array> = {
    E1: fakeMjpeg(0, 4000),
    E2: silentWav(1000),
    E3: mp4,
    E4: new TextEncoder().encode('{"yaml":"version: 2"}'),
  };
  return {
    bet: generateKeypair().publicKey,
    program: { version: 2, kind: 'ai_judged', participants: [], sides: [0, 1], entities: [], legs: [], outcome: { if_true: 1, condition: { op: 'yes' }, else: 0 } } as never,
    readback: ['Question: ok?'],
    preruling: 3,
    preruling_side: null,
    reason: 11,
    ai_judged: true,
    question: 'ok?',
    transcript: '',
    exhibits: [
      { id: 'E1', kind: 'clip', witness: 'cam1', t_start_ms: 0, t_end_ms: 4000 },
      { id: 'E2', kind: 'audio', witness: 'mic1', t_start_ms: 0, t_end_ms: 1000 },
      { id: 'E3', kind: 'clip', witness: 'cam2', t_start_ms: 0, t_end_ms: 4000 },
      { id: 'E4', kind: 'program', witness: null, t_start_ms: 0, t_end_ms: 4000 },
      { id: 'E5', kind: 'flags', witness: null, t_start_ms: 0, t_end_ms: 4000 },
    ],
    exhibitBytes: (id) => bytes[id] ?? null,
  };
}

function fakeFetch(reply: unknown, seen: { url: string; body: any; headers: Record<string, string> }[]) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(reply));
  }) as unknown as typeof fetch;
}

describe('booth LLM providers (fake fetch, no network)', () => {
  it('samples MJPEG at 2 fps and builds multimodal parts (video only for the video-native judge)', () => {
    expect(sampleMjpeg(fakeMjpeg(0, 4000))).toHaveLength(8);
    const c = bcase();
    const frames = caseParts(c, null, false);
    expect(frames.filter((p) => p.kind === 'image')).toHaveLength(8);
    expect(frames.some((p) => p.kind === 'media')).toBe(false);
    expect(frames.some((p) => p.kind === 'text' && p.text.includes('E3') && p.text.includes('not viewable'))).toBe(true);
    expect(frames.some((p) => p.kind === 'text' && p.text.includes('E5') && p.text.includes('not available'))).toBe(true);
    const video = caseParts(c, ['E2', 'E3'], true);
    expect(video.filter((p) => p.kind === 'media').map((p) => (p as { mime: string }).mime)).toEqual(['audio/wav', 'video/mp4']);
    expect(firstJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => firstJson('nothing')).toThrow();
  });

  it('anthropic advocate, gemini J0 and openai judge send the right shapes', async () => {
    const seen: { url: string; body: any; headers: Record<string, string> }[] = [];
    const adv = new LlmAdvocate(
      { provider: 'anthropic', apiKey: 'k', baseUrl: 'https://api.anthropic.com' },
      { fetch: fakeFetch({ content: [{ type: 'text', text: '{"side":0,"claim":"c","citations":["cam1@1.0s"],"exhibits":["E1"]}' }] }, seen) },
    );
    expect(await adv.brief(bcase(), 1, 3)).toEqual({ side: 1, claim: 'c', citations: ['cam1@1.0s'], exhibits: ['E1'] });
    expect(seen[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen[0]!.headers['x-api-key']).toBe('k');
    expect(seen[0]!.body.messages[0].content.filter((x: { type: string }) => x.type === 'image')).toHaveLength(8);

    const j0 = new LlmJudge(
      { provider: 'gemini', apiKey: 'g', baseUrl: 'https://generativelanguage.googleapis.com' },
      { fetch: fakeFetch({ candidates: [{ content: { parts: [{ text: '{"outcome":2,"confidence_bps":8100,"rationale":"r"}' }] } }] }, seen) },
    );
    expect(j0.videoNative).toBe(true);
    expect(await j0.judge(bcase(), [], 0)).toEqual({ outcome: 2, confidence_bps: 8100, rationale: 'r' });
    expect(seen[1]!.url).toMatch(/:generateContent$/);
    expect(seen[1]!.body.contents[0].parts.some((p: { inlineData?: { mimeType: string } }) => p.inlineData?.mimeType === 'video/mp4')).toBe(true);

    const j1 = new LlmJudge(
      { provider: 'openai', apiKey: 'o', baseUrl: 'https://api.openai.com' },
      { fetch: fakeFetch({ choices: [{ message: { content: '{"outcome":0,"confidence_bps":5000,"rationale":"unsure"}' } }] }, seen) },
    );
    expect(j1.videoNative).toBe(false);
    expect((await j1.judge(bcase(), [], 1)).outcome).toBe(0);
    expect(seen[2]!.body.messages[1].content.filter((x: { type: string }) => x.type === 'image_url')).toHaveLength(8);
  });
});
