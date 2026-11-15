/**
 * Real replay-booth providers (§10.2 advocates, §10.3 judges) for
 * anthropic | openai | gemini | xai. Paid: constructed only through
 * `llmEndpoint` (spend guard + API key). Plain HTTPS (`fetch`, injectable).
 *
 * Multimodal input from the exhibits (§10.3):
 *   - J0 (video-native, Gemini): MP4 clips inline as video, WAV inline as audio;
 *   - J1/J2 and advocates: MJPEG clips sampled at JUDGE_FRAME_SAMPLE_FPS (2 fps)
 *     as JPEG images (MP4 clips cannot be sampled without a transcoder and are
 *     described by their catalogue entry only), JSON exhibits as text.
 * Outputs are JSON, validated by the booth service (booth/protocol.ts).
 */
import { JUDGE_FRAME_SAMPLE_FPS } from '@verdict/engine';
import { parseMjpeg } from '../../booth/media.js';
import type { AdvocateBrief, AdvocateProvider, BoothCase, JudgeProvider, JudgeVote } from '../types.js';
import type { LlmEndpoint } from './llm.js';

export type FetchFn = typeof fetch;

export const DEFAULT_BOOTH_MODELS: Record<LlmEndpoint['provider'], string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4.1',
  gemini: 'gemini-2.5-pro',
  xai: 'grok-4',
};

const ANTHROPIC_VERSION = '2023-06-01';
/** Upper bounds on media sent per request. */
export const MAX_IMAGES = 24;
export const MAX_INLINE_BYTES = 15 * 1024 * 1024;

export type Part = { kind: 'text'; text: string } | { kind: 'image'; mime: 'image/jpeg'; data: Uint8Array } | { kind: 'media'; mime: string; data: Uint8Array };

export const ADVOCATE_SYSTEM = `You are an advocate in a replay booth for a friendly bet between two sides (A = side 0, B = side 1).
Argue for YOUR side only, using the exhibits. Reply with ONE JSON object:
{"side": <your side 0|1>, "claim": "<= 600 chars", "citations": ["cam1@12.4s", "mic2@12.6s"], "exhibits": ["E1", "E4"]}
Citations use the form <witness>@<seconds>s with at most one decimal (e.g. cam1@12.4s). Cite at most the exhibit slots you are given.`;

export const JUDGE_SYSTEM = `You are one of three independent judges in a replay booth for a friendly bet.
Read the program (the agreed terms), the read-back, both advocates' briefs and the exhibits, then rule.
Reply with ONE JSON object: {"outcome": 0|1|2, "confidence_bps": 0..10000, "rationale": "<= 1000 chars"}.
outcome: 0 = no contest (cannot tell / evidence insufficient), 1 = side A (side 0) wins, 2 = side B (side 1) wins.
For AI-judged bets answer the question: "yes" means the if_true side wins, "no" the else side (outcome = side + 1).
Be calibrated: confidence below 6000 does not count as a vote.`;

/** JPEG frames of an MJPEG exhibit sampled at `fps`. */
export function sampleMjpeg(bytes: Uint8Array, fps = JUDGE_FRAME_SAMPLE_FPS): Uint8Array[] {
  let frames;
  try {
    frames = parseMjpeg(bytes);
  } catch {
    return [];
  }
  const step = 1000 / fps;
  const out: Uint8Array[] = [];
  let next = -Infinity;
  for (const f of frames) {
    if (f.t_ms >= next) {
      out.push(f.jpeg);
      next = f.t_ms + step;
    }
  }
  return out;
}

const isMjpeg = (b: Uint8Array) => b.length > 10 && b[8] === 0xff && b[9] === 0xd8;
const isMp4 = (b: Uint8Array) => b.length > 12 && String.fromCharCode(...b.subarray(4, 8)) === 'ftyp';
const isWav = (b: Uint8Array) => b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF';

/** Builds the multimodal parts for a case (exhibits limited to `ids`). */
export function caseParts(c: BoothCase, ids: string[] | null, videoNative: boolean): Part[] {
  const parts: Part[] = [];
  let images = 0;
  let inline = 0;
  const wanted = ids ? c.exhibits.filter((e) => ids.includes(e.id)) : c.exhibits;
  for (const e of wanted) {
    const bytes = c.exhibitBytes?.(e.id) ?? null;
    const label = `Exhibit ${e.id} (${e.kind}${e.witness ? `, ${e.witness}` : ''}, ${(e.t_start_ms / 1000).toFixed(1)}s–${(e.t_end_ms / 1000).toFixed(1)}s)`;
    if (!bytes) {
      parts.push({ kind: 'text', text: `${label}: not available` });
      continue;
    }
    if (e.kind === 'clip' || e.kind === 'audio') {
      if (videoNative && (isMp4(bytes) || isWav(bytes)) && inline + bytes.length <= MAX_INLINE_BYTES) {
        parts.push({ kind: 'text', text: label });
        parts.push({ kind: 'media', mime: isMp4(bytes) ? 'video/mp4' : 'audio/wav', data: bytes });
        inline += bytes.length;
      } else if (isMjpeg(bytes)) {
        const frames = sampleMjpeg(bytes).slice(0, Math.max(0, MAX_IMAGES - images));
        parts.push({ kind: 'text', text: `${label}: ${frames.length} frames at ${JUDGE_FRAME_SAMPLE_FPS} fps follow` });
        for (const f of frames) parts.push({ kind: 'image', mime: 'image/jpeg', data: f });
        images += frames.length;
      } else {
        parts.push({ kind: 'text', text: `${label}: media not viewable by this judge` });
      }
      continue;
    }
    parts.push({ kind: 'text', text: `${label}:\n${new TextDecoder().decode(bytes).slice(0, 20_000)}` });
  }
  return parts;
}

function caseText(c: BoothCase): string {
  return JSON.stringify({
    bet: c.bet,
    kind: c.ai_judged ? 'ai_judged' : c.program.kind,
    question: c.question,
    program: c.program,
    readback: c.readback,
    preruling: { code: c.preruling, winning_side: c.preruling_side, dispute_reason: c.reason },
    transcript: c.transcript,
    exhibit_catalogue: c.exhibits,
  });
}

/** Extracts the first JSON object from model text (tolerates code fences). */
export function firstJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('booth llm: no JSON object in model output');
  return JSON.parse(body.slice(s, e + 1));
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

/** One system + multimodal user turn → model text, per vendor. */
export async function chat(endpoint: LlmEndpoint, model: string, system: string, parts: Part[], f: FetchFn = fetch, timeoutMs = 120_000): Promise<string> {
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const r = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`booth ${endpoint.provider}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r.json() as Promise<unknown>;
  };
  const { provider, apiKey, baseUrl } = endpoint;
  switch (provider) {
    case 'anthropic': {
      const content = parts.flatMap((p): Record<string, unknown>[] =>
        p.kind === 'text'
          ? [{ type: 'text', text: p.text }]
          : p.kind === 'image'
            ? [{ type: 'image', source: { type: 'base64', media_type: p.mime, data: b64(p.data) } }]
            : [],
      );
      const j = (await post(
        `${baseUrl}/v1/messages`,
        { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        { model, max_tokens: 4000, system, messages: [{ role: 'user', content }] },
      )) as { stop_reason?: string; content?: { type: string; text?: string }[] };
      if (j.stop_reason === 'refusal') throw new Error('booth anthropic: request declined');
      return (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    }
    case 'openai':
    case 'xai': {
      const content = parts.flatMap((p): Record<string, unknown>[] =>
        p.kind === 'text'
          ? [{ type: 'text', text: p.text }]
          : p.kind === 'image'
            ? [{ type: 'image_url', image_url: { url: `data:${p.mime};base64,${b64(p.data)}` } }]
            : [],
      );
      const j = (await post(
        `${baseUrl}/v1/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content },
          ],
          response_format: { type: 'json_object' },
        },
      )) as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? '';
    }
    case 'gemini': {
      const gparts = parts.map((p) => (p.kind === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mime, data: b64(p.data) } }));
      const j = (await post(
        `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: gparts }],
          generationConfig: { responseMimeType: 'application/json' },
        },
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    }
  }
}

export interface BoothLlmOptions {
  model?: string;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export class LlmAdvocate implements AdvocateProvider {
  readonly name: string;
  readonly model: string;
  constructor(
    readonly endpoint: LlmEndpoint,
    private readonly opts: BoothLlmOptions = {},
  ) {
    this.name = endpoint.provider;
    this.model = opts.model ?? DEFAULT_BOOTH_MODELS[endpoint.provider];
  }

  async brief(c: BoothCase, side: 0 | 1, exhibitSlots: number): Promise<AdvocateBrief> {
    const parts: Part[] = [
      { kind: 'text', text: `${caseText(c)}\n\nYou argue for side ${side} (${side === 0 ? 'A' : 'B'}). Exhibit slots: ${exhibitSlots}.` },
      ...caseParts(c, null, false),
    ];
    const raw = firstJson(await chat(this.endpoint, this.model, ADVOCATE_SYSTEM, parts, this.opts.fetch, this.opts.timeoutMs)) as AdvocateBrief;
    return { ...raw, side };
  }
}

export class LlmJudge implements JudgeProvider {
  readonly name: string;
  readonly model: string;
  /** J0 must be video-native (§10.3): Gemini takes clips as video. */
  readonly videoNative: boolean;
  constructor(
    readonly endpoint: LlmEndpoint,
    private readonly opts: BoothLlmOptions = {},
  ) {
    this.name = endpoint.provider;
    this.model = opts.model ?? DEFAULT_BOOTH_MODELS[endpoint.provider];
    this.videoNative = endpoint.provider === 'gemini';
  }

  async judge(c: BoothCase, briefs: AdvocateBrief[], judgeIndex: number): Promise<JudgeVote> {
    const parts: Part[] = [
      { kind: 'text', text: `${caseText(c)}\n\nBriefs: ${JSON.stringify(briefs)}\nYou are judge J${judgeIndex}.` },
      ...caseParts(c, null, this.videoNative),
    ];
    return firstJson(await chat(this.endpoint, this.model, JUDGE_SYSTEM, parts, this.opts.fetch, this.opts.timeoutMs)) as JudgeVote;
  }
}
