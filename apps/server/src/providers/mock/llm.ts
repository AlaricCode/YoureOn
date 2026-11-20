// Deterministic offline LLM (LLM_PROVIDER=mock, the default). Never touches the network.
//
// Schema-generic: by default it answers with a value sampled from the request's JSON schema
// (first enum value, 0.9 for 0..1 numbers, "mock <field>" strings, [] arrays, false booleans).
// Tests and the demo pass `respond` to script answers per request. The reply goes through the same
// parse + zod path as the live vendors, so a scripted bad answer yields the same `invalid_output`.
import { CHAT_TIMEOUT_MS, DEFAULT_CHAT_MODELS, resultFromText } from '../structured';
import type { ChatRequest, ChatResult, LlmProvider } from '../types';

/** A scripted reply: a value (JSON-encoded for parsing), raw model text, or a simulated failure. */
export type MockReply =
  | { value: unknown }
  | { text: string }
  | { fail: 'timeout' | 'error' | 'refusal'; message?: string };

export type MockResponder = (req: ChatRequest<unknown>) => MockReply | Promise<MockReply>;

type JsonSchema = {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxLength?: number;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
};

/** A deterministic value that satisfies simple hand-written JSON schemas. */
export function sampleFromJsonSchema(s: JsonSchema, key = 'value'): unknown {
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  const alt = s.anyOf?.[0] ?? s.oneOf?.[0];
  if (alt) return sampleFromJsonSchema(alt, key);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.properties ?? {})) out[k] = sampleFromJsonSchema(v, k);
      return out;
    }
    case 'array': {
      const n = s.minItems ?? 0;
      return Array.from({ length: n }, () => sampleFromJsonSchema(s.items ?? {}, key));
    }
    case 'number': {
      const lo = s.minimum ?? 0;
      const hi = s.maximum ?? 1;
      return Math.min(hi, Math.max(lo, 0.9));
    }
    case 'integer':
      return s.minimum ?? 0;
    case 'boolean':
      return false;
    case 'string': {
      const text = `mock ${key}`;
      return s.maxLength !== undefined ? text.slice(0, s.maxLength) : text;
    }
    default:
      return null;
  }
}

export const defaultMockResponder: MockResponder = (req) => ({
  value: sampleFromJsonSchema(req.output.jsonSchema as JsonSchema),
});

export class MockLlm implements LlmProvider {
  readonly name = 'mock' as const;
  /** Every request seen, for assertions. */
  readonly calls: ChatRequest<unknown>[] = [];

  constructor(private readonly respond: MockResponder = defaultMockResponder) {}

  async chat<T>(req: ChatRequest<T>): Promise<ChatResult<T>> {
    this.calls.push(req as ChatRequest<unknown>);
    const base = {
      vendor: req.vendor,
      model: `mock/${req.model ?? DEFAULT_CHAT_MODELS[req.vendor]}`,
      latency_ms: 0,
    };
    let reply: MockReply;
    try {
      reply = await this.respond(req as ChatRequest<unknown>);
    } catch (e) {
      return { ...base, ok: false, status: 'error', message: (e as Error).message };
    }
    if ('fail' in reply) {
      const message =
        reply.message ??
        (reply.fail === 'timeout'
          ? `deadline of ${req.timeoutMs ?? CHAT_TIMEOUT_MS} ms exceeded`
          : `mock ${reply.fail}`);
      return { ...base, ok: false, status: reply.fail, message };
    }
    const text = 'text' in reply ? reply.text : JSON.stringify(reply.value);
    return resultFromText(base, text, req.output);
  }
}
