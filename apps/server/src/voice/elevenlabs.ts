// Minimal ElevenLabs REST client for the server (FINDINGS §3.10: "Server: plain fetch or
// @elevenlabs/elevenlabs-js"). Only what the running server needs: the conversation token.
// `fetch` is injectable so tests mock the HTTP call (no key exists yet: PENDING-KEY).
import { ElTokenResponse } from '@youre-on/shared/judge/voice';

export const ELEVENLABS_API = 'https://api.elevenlabs.io';
/** API-CONTRACT §1.8: server-side outbound deadline for the ElevenLabs token. */
export const EL_TOKEN_TIMEOUT_MS = 3_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  constructor(
    readonly kind: 'timeout' | 'error' | 'not_configured',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface ConversationToken {
  token: string;
  conversation_id: string;
}

export interface ElevenLabsClient {
  /** `GET /v1/convai/conversation/token?agent_id=…` with `xi-api-key` (API-CONTRACT §2.6). */
  conversationToken(agentId: string): Promise<ConversationToken>;
}

export function createElevenLabsClient(o: {
  apiKey: string | undefined;
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
}): ElevenLabsClient {
  const doFetch: FetchLike = o.fetch ?? ((u, i) => fetch(u, i));
  const base = (o.baseUrl ?? ELEVENLABS_API).replace(/\/+$/, '');
  const timeoutMs = o.timeoutMs ?? EL_TOKEN_TIMEOUT_MS;
  return {
    async conversationToken(agentId) {
      if (!o.apiKey) throw new UpstreamError('not_configured', 'ELEVENLABS_API_KEY is not set');
      const url = `${base}/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'GET',
          headers: { 'xi-api-key': o.apiKey, accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const name = (e as { name?: string } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError')
          throw new UpstreamError('timeout', `ElevenLabs token timed out after ${timeoutMs} ms`);
        throw new UpstreamError('error', `ElevenLabs token request failed: ${String(e)}`);
      }
      if (!res.ok) {
        // Never echo the body: it may quote the request.
        throw new UpstreamError('error', `ElevenLabs token HTTP ${res.status}`, res.status);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new UpstreamError('error', 'ElevenLabs token: response is not JSON', res.status);
      }
      const parsed = ElTokenResponse.safeParse(body);
      if (!parsed.success)
        throw new UpstreamError('error', 'ElevenLabs token: unexpected response shape', res.status);
      return parsed.data;
    },
  };
}
