/**
 * §12.4 WebSocket message shapes.
 */
import { PLAY_DELAY_MS } from '@verdict/engine';

export type Topic = 'user' | `bet:${string}` | `huddle:${string}` | `world:${string}`;

const TOPIC_RE = /^(user|bet:[1-9A-HJ-NP-Za-km-z]{32,44}|huddle:[A-Za-z0-9_-]{1,64}|world:[A-Za-z0-9_.:-]{1,128})$/;

export function isTopic(t: unknown): t is Topic {
  return typeof t === 'string' && TOPIC_RE.test(t);
}

// ---- client → server ---------------------------------------------------------

export type ClientMessage =
  | { type: 'subscribe'; topics: string[] }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'scene.frame'; bet_id: string; jpeg_b64: string; t_ms: number }
  | { type: 'recording'; bet_id: string; witness_key: string }
  | { type: 'ping' };

export type ClientMessageType = ClientMessage['type'];

/** Validates the envelope of a client message (field contents are checked by handlers). */
export function parseClientMessage(raw: string): ClientMessage | null {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const m = j as Record<string, unknown>;
  switch (m['type']) {
    case 'subscribe':
    case 'unsubscribe':
      return Array.isArray(m['topics']) && m['topics'].every((t) => typeof t === 'string')
        ? { type: m['type'], topics: m['topics'] as string[] }
        : null;
    case 'scene.frame':
      return typeof m['bet_id'] === 'string' && typeof m['jpeg_b64'] === 'string' && Number.isInteger(m['t_ms'])
        ? { type: 'scene.frame', bet_id: m['bet_id'], jpeg_b64: m['jpeg_b64'], t_ms: m['t_ms'] as number }
        : null;
    case 'recording':
      return typeof m['bet_id'] === 'string' && typeof m['witness_key'] === 'string'
        ? { type: 'recording', bet_id: m['bet_id'], witness_key: m['witness_key'] }
        : null;
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

// ---- server → client ---------------------------------------------------------

export interface StartMessage {
  type: 'start';
  bet_id: string;
  beacon: { slot: number | string; hash_hex: string; symbols: number[] };
  wav_url: string;
  sfx_url: string;
  play_on_user_id: string;
  play_delay_ms: number;
}

export type ServerMessage =
  | { type: 'bet'; bet: unknown }
  | { type: 'huddle'; huddle: unknown }
  | { type: 'draft'; huddle_id: string; draft: unknown }
  | { type: 'chain'; bet_id: string; name: string; data: Record<string, unknown>; signature: string; slot: number }
  | { type: 'scene'; bet_id: string; entities: unknown[]; conditions: unknown[] }
  | StartMessage
  | { type: 'booth'; bet_id: string; booth: unknown }
  | { type: 'world.price'; event_id: string; contract_id: string; prob_bps: number; at_ms: number }
  | { type: 'notify'; title: string; bet_id: string | null }
  | { type: 'pong' }
  | { type: 'error'; error: { code: string; message: string } };

export const DEFAULT_PLAY_DELAY_MS = PLAY_DELAY_MS;
