// Dance Off face assignment (docs/planning/DANCE-OFF.md §3):
//   POST /v1/bets/:bet_id/dance/identify   (S, the bet's recorder device) -> DanceIdentifyResponse
//
// The recording phone takes one still when the framing check passes, embeds the faces it found on
// the two players with the face-match model, and asks which face is which party. The answer seeds
// its identity tracker (A may stand on the right); an empty answer, or any failure, leaves the
// left / right rule. It never affects the score or the ruling.
//
// Who may call: only the device that films this dance off, while it is LOCKED (no attempt yet:
// A's judge cam bound to the room if there is one, else one of A's own phones, the devices POST
// …/attempts can name) or in ATTEMPT (the attempt's recorder device, and for a judge cam only
// while it is still bound to the room). B's devices never film a dance off, so they are refused.
//
// Privacy, as face-match (API-CONTRACT §2.4) and stricter: the probes are compared ONLY with the
// two parties' active enrollments (the caller's own included, since both dance), with the
// face-match threshold and margin (shared decideDanceAssignments); nothing is stored, not even
// last_used_at; the answer carries face indices and parties, never a score or a vector; bodies are
// never logged (nothing in this server logs bodies; the face service strips DB error messages).
//
// Rate limits, as face-match (§1.7): one call in flight per user, then 30/min per user in its own
// bucket `face-match/dance` (so it never uses up the scan or Challenge path). The body is read
// inside the in-flight guard and before the token: a concurrent call and an invalid body spend
// none.
import { desc, eq } from 'drizzle-orm';
import { attempts, bets } from '@youre-on/db';
import { DanceIdentifyRequest } from '@youre-on/shared/api';
import { FACE_MATCH_BUCKETS } from '@youre-on/shared/face';
import { Uuid } from '@youre-on/shared/primitives';
import type { AppDeps, RouteModule } from '../context';
import { HttpError } from '../errors';
import { readBody } from '../http/body';
import { appAuth, requireSignedRequest } from '../auth/middleware';
import { partyOf, type BetRow } from '../bets/snapshot';
import { faceMatchGate } from '../face/routes';
import { identifyDanceParties } from '../face/service';
import { isDanceOffBet } from './dance-bet';
import { assertRecorder, findDanceJudgeCam } from './routes';

export const DANCE_IDENTIFY_BUCKET = FACE_MATCH_BUCKETS.tap;
export const DANCE_IDENTIFY_BUCKET_NAME = 'face-match/dance';
/** The bet states a round is framed (LOCKED) or danced (ATTEMPT) in. */
const IDENTIFY_STATES: readonly string[] = ['LOCKED', 'ATTEMPT'];

const notRecorder = () =>
  new HttpError('NOT_A_PARTY', 'Only the phone filming this dance off can do that.', {
    reason: 'not_recorder',
  });

/**
 * The caller's device films this dance off (see the header). Throws NOT_FOUND, NOT_A_PARTY or
 * INVALID_STATE; returns the bet.
 */
export async function assertDanceFilmingDevice(
  deps: AppDeps,
  betId: string,
  me: { user_id: string; device_id: string },
): Promise<BetRow> {
  if (!Uuid.safeParse(betId).success) throw new HttpError('NOT_FOUND', 'No such bet.');
  const [bet] = await deps.db.select().from(bets).where(eq(bets.id, betId)).limit(1);
  if (!bet) throw new HttpError('NOT_FOUND', 'No such bet.');
  if (!partyOf(bet, me.user_id)) throw new HttpError('NOT_A_PARTY', "You're not in this bet.");
  if (!IDENTIFY_STATES.includes(bet.state)) {
    throw new HttpError('INVALID_STATE', undefined, { state: bet.state });
  }
  if (!(await isDanceOffBet(deps.db, bet.id))) {
    throw new HttpError('INVALID_STATE', 'This bet is not a dance off.', {
      state: bet.state,
      reason: 'not_dance',
    });
  }
  if (bet.state === 'ATTEMPT') {
    const [att] = await deps.db
      .select()
      .from(attempts)
      .where(eq(attempts.bet_id, bet.id))
      .orderBy(desc(attempts.attempt_no))
      .limit(1);
    if (!att) throw notRecorder();
    await assertRecorder(deps, att, bet, me.device_id);
    return bet;
  }
  // LOCKED: who POST …/attempts can name. A's judge cam in the room, else any of A's phones.
  const cam = await findDanceJudgeCam(deps.db, bet);
  if (cam ? cam.id !== me.device_id : me.user_id !== bet.party_a_id) throw notRecorder();
  return bet;
}

export function createDanceIdentifyRoutes(): RouteModule {
  return {
    name: 'dance-identify',
    register(app, deps) {
      const gate = faceMatchGate((userId) =>
        deps.rateLimit?.take(DANCE_IDENTIFY_BUCKET_NAME, userId, DANCE_IDENTIFY_BUCKET),
      );
      app.post('/v1/bets/:bet_id/dance/identify', requireSignedRequest, async (c) => {
        const me = appAuth(c);
        return gate<Response, DanceIdentifyRequest & { mode?: undefined }>(
          me.user_id,
          async (body) => {
            const bet = await assertDanceFilmingDevice(deps, c.req.param('bet_id') ?? '', me);
            const out = await identifyDanceParties(
              deps,
              { A: bet.party_a_id, B: bet.party_b_id },
              body,
            );
            return c.json(out, 200);
          },
          () => readBody(c, DanceIdentifyRequest),
        );
      });
    },
  };
}

export const danceIdentifyRoutes: RouteModule = createDanceIdentifyRoutes();
