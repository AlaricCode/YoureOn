// Relays from A's phone, the voice host:
//   POST /v1/bets/:bet_id/voice/lines  the judge session's transcript -> judge.line / party.line
//        bet events: the stage's live transcript and B's captions.
//   POST /v1/bets/:bet_id/cues         the `cue` client tool -> a `stage.cue` frame to the bet's
//        room; the stage laptop plays the clip (audio on A's phone would stop mic capture).
// Spec: docs/planning/API-CONTRACT.md §2.6.
//
// Lines are accepted in any state, terminal included (the judge's "[EVENT] PAID" congratulation
// is spoken after the bet is PAID), bounded by a per-bet cap and the rate limit instead.
import type { Context } from 'hono';
import { and, count, eq, inArray } from 'drizzle-orm';
import { betEvents } from '@youre-on/db';
import {
  JUDGE_LINE_MAX,
  StageCueRequest,
  VoiceLinesRequest,
  type StageCueResponse,
  type VoiceLine,
  type VoiceLinesResponse,
} from '@youre-on/shared/judge/voice';
import { stageSfxPath } from '@youre-on/shared/stage-voice';
import type { AppDeps, AppEnv } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import type { BucketSpec } from '../http/rate-limit';
import { appAuth } from '../auth/middleware';
import type { BetRow } from '../bets/snapshot';
import { readBet } from '../lock/common';
import { betIdParam } from '../lock/routes';
import { appendBetEvent, type BetEventEnvelope } from '../realtime/events';

/** 4 batches/s for a minute: the phone flushes at most every 250 ms. */
export const VOICE_LINES_BUCKET: BucketSpec = { limit: 240, windowMs: 60_000 };
/** The judge cues a gavel / drumroll / buzzer / cheer a few times a bet. */
export const CUES_BUCKET: BucketSpec = { limit: 30, windowMs: 60_000 };
/** Lines kept per bet (one 20-minute session at a brisk pace is well under this). */
export const MAX_LINES_PER_BET = 600;

const LINE_TYPES = ['judge.line', 'party.line'] as const;

/** "  so   it's\na deal " -> "so it's a deal". */
export const normalizeLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The judge.line / party.line payload for a line, or null when it is dropped. Only final lines
 * are persisted: bet events are sequenced and kept, and the ElevenLabs SDK hands the phone finals
 * only. A party line starting with "[EVENT]" is the server's own judge.cue text (sent into the
 * conversation with sendUserMessage), never something a party said.
 */
export function linePayload(l: VoiceLine):
  | { type: 'judge.line'; payload: { utterance_id: string; text: string; final: boolean } }
  | {
      type: 'party.line';
      payload: { party: 'A' | 'B'; utterance_id: string; text: string; final: boolean };
    }
  | null {
  if (!l.final) return null;
  const text = normalizeLine(l.text);
  if (!text) return null;
  if (l.role === 'judge') {
    const cut = text.length > JUDGE_LINE_MAX ? `${text.slice(0, JUDGE_LINE_MAX - 1)}…` : text;
    return {
      type: 'judge.line',
      payload: { utterance_id: l.utterance_id, text: cut, final: true },
    };
  }
  if (/^\[EVENT\]/i.test(text)) return null;
  return {
    type: 'party.line',
    payload: { party: l.party!, utterance_id: l.utterance_id, text, final: true },
  };
}

/**
 * In-process (bet, utterance, final) dedupe, LRU-bounded (one Fly machine): a repeat is counted,
 * not re-emitted. A resent batch is covered by the signed request's Idempotency-Key.
 */
export class LineDedupe {
  private seen = new Map<string, true>();
  constructor(private readonly maxEntries = 20_000) {}
  /** true the first time a key is offered. */
  first(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }
    this.seen.set(key, true);
    return true;
  }
  forget(key: string): void {
    this.seen.delete(key);
  }
}

/** The bet, if the caller is its party A (only A's phone hosts the judge). */
async function hostedBet(c: Context<AppEnv>, scope: string, bucket: BucketSpec): Promise<BetRow> {
  const deps = c.get('deps');
  const me = appAuth(c);
  const betId = betIdParam(c.req.param('bet_id') ?? '');
  deps.rateLimit?.take(scope, `${betId}:${me.user_id}`, bucket);
  const bet = await readBet(deps.db, betId);
  if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
  if (bet.party_a_id !== me.user_id)
    throw new HttpError(
      'NOT_A_PARTY',
      bet.party_b_id === me.user_id
        ? "Only the challenger's phone hosts the judge."
        : "You're not in this bet.",
      { bet_id: betId },
    );
  return bet;
}

async function linesSoFar(deps: AppDeps, betId: string): Promise<number> {
  const [r] = await deps.db
    .select({ n: count() })
    .from(betEvents)
    .where(and(eq(betEvents.bet_id, betId), inArray(betEvents.type, [...LINE_TYPES])));
  return r?.n ?? 0;
}

export function voiceLinesHandler(dedupe: LineDedupe) {
  return async (c: Context<AppEnv>) => {
    const deps = c.get('deps');
    const bet = await hostedBet(c, 'voice/lines', VOICE_LINES_BUCKET);
    const body = await readBody(c, VoiceLinesRequest);

    let duplicates = 0;
    let dropped = 0;
    const fresh: Array<{ key: string; line: NonNullable<ReturnType<typeof linePayload>> }> = [];
    for (const l of body.lines) {
      const line = linePayload(l);
      if (!line) {
        dropped += 1;
        continue;
      }
      const key = `${bet.id}\n${l.utterance_id}\n${l.final}`;
      if (!dedupe.first(key)) {
        duplicates += 1;
        continue;
      }
      fresh.push({ key, line });
    }

    let envs: BetEventEnvelope[] = [];
    if (fresh.length) {
      const room = Math.max(0, MAX_LINES_PER_BET - (await linesSoFar(deps, bet.id)));
      const kept = fresh.slice(0, room);
      for (const f of fresh.slice(room)) dedupe.forget(f.key);
      dropped += fresh.length - kept.length;
      const now = deps.now();
      try {
        envs = kept.length
          ? await deps.db.transaction(async (tx) => {
              const out: BetEventEnvelope[] = [];
              for (const { line } of kept)
                out.push(
                  line.type === 'judge.line'
                    ? await appendBetEvent(tx, { bet_id: bet.id, ...line, now })
                    : await appendBetEvent(tx, { bet_id: bet.id, ...line, now }),
                );
              return out;
            })
          : [];
      } catch (e) {
        // Not persisted: let a resend of the same lines through.
        for (const f of kept) dedupe.forget(f.key);
        throw e;
      }
      for (const env of envs) deps.hub.publishBetEvent(env, bet.room_id);
    }
    const res: VoiceLinesResponse = { accepted: envs.length, duplicates, dropped };
    return c.json(res, 202);
  };
}

export function cuesHandler() {
  return async (c: Context<AppEnv>) => {
    const deps = c.get('deps');
    const bet = await hostedBet(c, 'cues', CUES_BUCKET);
    const { kind } = await readBody(c, StageCueRequest);
    // The ElevenLabs Sound Effects clip when it is live (src/stage/audio.ts); else the stage
    // synthesizes the cue itself.
    const live = deps.providers.sfx.name === 'live';
    if (bet.room_id)
      deps.hub.publishToRoom(bet.room_id, {
        op: 'stage.cue',
        bet_id: bet.id,
        kind,
        ...(live ? { audio_url: stageSfxPath(kind) } : {}),
      });
    deps.log.info('voice.cue', { bet_id: bet.id, kind, relayed: bet.room_id !== null });
    const res: StageCueResponse = { relayed: bet.room_id !== null };
    return c.json(res, 202);
  };
}
