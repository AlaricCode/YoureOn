// Pure state of the stage ticker: every frame the server sends on /v1/ws goes through
// applyFrame(). Control frames carry `op`; event frames are bare RealtimeEvent envelopes that are
// parsed with the shared schema and dropped (with a note) when they fail (API-CONTRACT §3.1,
// SCHEMAS §10.1). Events are deduplicated by (bet_id, seq), as the client rule in §3.3 says.
import { WsServerControlFrame } from '@youre-on/shared/api';
import { parseRealtimeEvent, type RealtimeEvent } from '@youre-on/shared/realtime';

export const MAX_EVENTS = 200;

export type ConnStatus = 'idle' | 'authorizing' | 'connecting' | 'open' | 'closed';

export interface TickerEvent {
  bet_id: string;
  seq: number;
  type: string;
  ts: string;
  source: string;
  /** Devnet Explorer link when the payload names a transaction signature. */
  explorer: string | null;
  payload: unknown;
}

export interface TickerState {
  status: ConnStatus;
  /** server_time - local time, from `welcome` (for countdowns). */
  clockOffsetMs: number | null;
  closeCode: number | null;
  events: TickerEvent[];
  lastSeq: Record<string, number>;
  presence: { room_id: string; online: number; members: number } | null;
  lastCue: { bet_id: string; kind: string } | null;
  marketTicks: number;
  dropped: number;
  errors: string[];
}

export const initialTicker: TickerState = {
  status: 'idle',
  clockOffsetMs: null,
  closeCode: null,
  events: [],
  lastSeq: {},
  presence: null,
  lastCue: null,
  marketTicks: 0,
  dropped: 0,
  errors: [],
};

export const explorerTx = (signature: string, cluster: 'devnet' | 'localnet' = 'devnet') =>
  cluster === 'devnet'
    ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    : `https://explorer.solana.com/tx/${signature}?cluster=custom`;

/** A `signature` field on the payload or one level down (chain events, tx.submitted). */
export function findSignature(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.signature === 'string') return p.signature;
  for (const v of Object.values(p))
    if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).signature === 'string')
      return (v as Record<string, string>).signature!;
  return null;
}

function toTicker(e: RealtimeEvent): TickerEvent {
  const sig = findSignature(e.payload);
  return {
    bet_id: e.bet_id,
    seq: e.seq,
    type: e.type,
    ts: e.ts,
    source: e.source,
    explorer: sig ? explorerTx(sig) : null,
    payload: e.payload,
  };
}

const noteError = (s: TickerState, msg: string): TickerState => ({
  ...s,
  errors: [...s.errors.slice(-9), msg],
});

export type TickerAction =
  | { kind: 'status'; status: ConnStatus; closeCode?: number | null }
  | { kind: 'frame'; raw: unknown; receivedAt: number }
  | { kind: 'error'; message: string };

export function applyFrame(s: TickerState, a: TickerAction): TickerState {
  if (a.kind === 'status')
    return {
      ...s,
      status: a.status,
      closeCode: a.closeCode ?? (a.status === 'closed' ? s.closeCode : null),
    };
  if (a.kind === 'error') return noteError(s, a.message);

  const raw = a.raw;
  if (raw && typeof raw === 'object' && 'op' in raw) {
    const f = WsServerControlFrame.safeParse(raw);
    if (!f.success) return { ...s, dropped: s.dropped + 1 };
    const frame = f.data;
    switch (frame.op) {
      case 'welcome':
        return {
          ...s,
          status: 'open',
          clockOffsetMs: Date.parse(frame.server_time) - a.receivedAt,
        };
      case 'error':
        return noteError(s, `${frame.code}: ${frame.message}`);
      case 'room.presence':
        return {
          ...s,
          presence: {
            room_id: frame.room_id,
            members: frame.members.length,
            online: frame.members.filter((m) => m.online).length,
          },
        };
      case 'stage.cue':
        return { ...s, lastCue: { bet_id: frame.bet_id, kind: frame.kind } };
      case 'stage.market':
        return { ...s, marketTicks: s.marketTicks + 1 };
      case 'subscribed':
        return {
          ...s,
          lastSeq: {
            ...s.lastSeq,
            [frame.bet_id]: Math.max(s.lastSeq[frame.bet_id] ?? 0, frame.last_seq),
          },
        };
      case 'ping':
        return s;
    }
  }

  const parsed = parseRealtimeEvent(raw);
  if (!parsed.ok) return { ...s, dropped: s.dropped + 1 };
  const e = parsed.event;
  if (s.events.some((x) => x.bet_id === e.bet_id && x.seq === e.seq)) return s;
  const events = [...s.events, toTicker(e)]
    .sort((x, y) => (x.ts === y.ts ? x.seq - y.seq : x.ts < y.ts ? -1 : 1))
    .slice(-MAX_EVENTS);
  return {
    ...s,
    events,
    lastSeq: { ...s.lastSeq, [e.bet_id]: Math.max(s.lastSeq[e.bet_id] ?? 0, e.seq) },
  };
}
