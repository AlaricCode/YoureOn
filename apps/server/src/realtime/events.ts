// Appending to the per-bet realtime log (SCHEMAS §10.1, DATA-MODEL §5.19) and fanning out.
//
//   const env = await appendBetEvent(tx, { bet_id, type: 'bet.state', payload });  // inside YOUR tx
//   ...commit...
//   deps.hub.publishBetEvent(env, bet.room_id);                                      // after commit
//
// or, when the event is the only write: `await emitBetEvent(deps, {...})` (own tx + publish).
//
// seq is assigned by `UPDATE bets SET last_seq = last_seq + 1 ... RETURNING last_seq` in the
// same transaction as the insert, so it is gapless per bet. Note: that UPDATE fires the
// bets_guard trigger, which bumps bets.version — do your own versioned bets UPDATE first,
// then append the event(s).
import { eq, sql } from 'drizzle-orm';
import { betEvents, bets, type Db } from '@youre-on/db';
import {
  REALTIME_ENVELOPE_VERSION,
  type RealtimeEventType,
  type RealtimePayload,
} from '@youre-on/shared/realtime';
import type { AppDeps } from '../context';
import type { BetEnvelope } from './hub';

type Executor = Pick<Db, 'insert' | 'update'>;

export interface BetEventEnvelope extends BetEnvelope {
  v: typeof REALTIME_ENVELOPE_VERSION;
  type: string;
  bet_id: string;
  seq: number;
  ts: string;
  source: 'server' | 'chain';
  payload: unknown;
}

/** A SCHEMAS RealtimeEvent type (API-CONTRACT §3.4 extensions included) with its typed payload. */
export type KnownEventInput<T extends RealtimeEventType = RealtimeEventType> = {
  bet_id: string;
  type: T;
  payload: RealtimePayload<T>;
  chain_event_id?: bigint;
  now?: number;
};

/**
 * Appends one event inside the caller's transaction. After commit, publish it with
 * `deps.hub.publishBetEvent(env, bet.room_id)` (the room id lets stage sessions of the room
 * receive it, §3.2).
 */
export async function appendBetEvent<T extends RealtimeEventType>(
  db: Executor,
  input: KnownEventInput<T>,
): Promise<BetEventEnvelope> {
  return (await appendBetEventRow(db, input)).envelope;
}

async function appendBetEventRow<T extends RealtimeEventType>(
  db: Executor,
  input: KnownEventInput<T>,
): Promise<{ envelope: BetEventEnvelope; room_id: string | null }> {
  const [row] = await db
    .update(bets)
    .set({ last_seq: sql`${bets.last_seq} + 1` })
    .where(eq(bets.id, input.bet_id))
    .returning({ seq: bets.last_seq, room_id: bets.room_id });
  if (!row) throw new Error(`appendBetEvent: unknown bet ${input.bet_id}`);
  const at = new Date(input.now ?? Date.now());
  const source = input.type.startsWith('chain.') ? 'chain' : 'server';
  const envelope: BetEventEnvelope = {
    v: REALTIME_ENVELOPE_VERSION,
    type: input.type,
    bet_id: input.bet_id,
    seq: row.seq,
    ts: at.toISOString(),
    source,
    payload: input.payload,
  };
  await db.insert(betEvents).values({
    bet_id: input.bet_id,
    seq: row.seq,
    type: input.type,
    source,
    envelope,
    chain_event_id: input.chain_event_id ?? null,
    created_at: at,
  });
  return { envelope, room_id: row.room_id };
}

/** appendBetEvent in its own transaction, then publish to bet:<bet_id>. */
export async function emitBetEvent<T extends RealtimeEventType>(
  deps: Pick<AppDeps, 'db' | 'hub' | 'now'>,
  input: KnownEventInput<T>,
): Promise<BetEventEnvelope> {
  const { envelope, room_id } = await deps.db.transaction((tx) =>
    appendBetEventRow(tx, { now: deps.now(), ...input }),
  );
  deps.hub.publishBetEvent(envelope, room_id);
  return envelope;
}
