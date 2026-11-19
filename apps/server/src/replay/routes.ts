// GET /v1/bets/:bet_id/replay -> 200 ReplayResponse (API-CONTRACT §2.14, SCHEMAS §4.1): the
// slow-mo replay after a bet, for the stage and the phones' payout screens.
//
//   readers   = the snapshot and frame routes' (stage/routes.ts canRead): a party's app session,
//               or a stage session of the bet's room. Missing and not-yours are both 404.
//   frames    the moment lists server-relative frame paths: the existing
//               GET /v1/bets/:bet_id/attempts/:n/frames/:idx serves them to the same readers.
//   no-store  a confirmed foul (deps.replayFouls) can arrive after the ruling.
//
// why: not_ruled (no ruling yet, or a REDO) · no_winner (VOID, or an appeal upheld a VOID) ·
// no_frames (a Gemini settlement, a Dance Off, or nothing showable) · purged (the attempt's
// frames are gone).
import { and, desc, eq } from 'drizzle-orm';
import { attempts, bets } from '@youre-on/db';
import type { BetSnapshot } from '@youre-on/shared/api';
import { isTerminalBetState } from '@youre-on/shared/bet-state';
import { CameraEvidence } from '@youre-on/shared/evidence';
import { BetId } from '@youre-on/shared/primitives';
import {
  buildFoulReplay,
  buildWinReplay,
  ReplayResponse,
  type ReplayWhy,
} from '@youre-on/shared/replay';
import { DANCE_OFF_MODEL, GEMINI_SETTLEMENT_MODEL } from '@youre-on/shared/ruling';
import type { AppDeps, RouteModule } from '../context';
import { requireSession } from '../auth/middleware';
import { HttpError, validationError } from '../errors';
import { canRead, loadBetSnapshot } from '../stage/routes';
import { stageCors } from '../stage/cors';

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type AttemptRow = Pick<
  typeof attempts.$inferSelect,
  'attempt_no' | 'evidence_canonical' | 'frame_hashes' | 'purged_at'
>;

/** The replay for a bet snapshot (pure over the DB reads it makes). */
export async function computeReplay(
  deps: Pick<AppDeps, 'db' | 'log' | 'replayFouls'>,
  snap: BetSnapshot,
): Promise<ReplayResponse> {
  const final = isTerminalBetState(snap.state);
  const none = (why: Exclude<ReplayWhy, 'ready'>): ReplayResponse => ({ replay: null, why, final });
  const lr = snap.latest_ruling;
  if (!lr || lr.ruling.outcome === 'REDO') return none('not_ruled');
  const { ruling, ruling_hash } = lr;
  // an appeal of this ruling decides the winner (a flipped one is held on the last frame)
  const appeal = snap.appeal?.original_ruling_hash === ruling_hash ? snap.appeal : null;
  const finalOutcome = appeal?.final_outcome ?? ruling.outcome;
  if (finalOutcome !== 'A_WINS' && finalOutcome !== 'B_WINS') return none('no_winner');
  // A Dance Off's key frames are stills of a 15 s round, not a landing: no slow-mo replay (its
  // evidence_canonical is a DanceEvidence, which the landing-window builder can't read).
  if (
    ruling.model === GEMINI_SETTLEMENT_MODEL ||
    ruling.model === DANCE_OFF_MODEL ||
    ruling.frame_hashes.length === 0
  )
    return none('no_frames');

  const cols = {
    attempt_no: attempts.attempt_no,
    evidence_canonical: attempts.evidence_canonical,
    frame_hashes: attempts.frame_hashes,
    purged_at: attempts.purged_at,
  };
  let att: AttemptRow | undefined;
  if (ruling.stage === 'attempt') {
    [att] = await deps.db
      .select(cols)
      .from(attempts)
      .where(and(eq(attempts.bet_id, snap.bet_id), eq(attempts.attempt_no, ruling.attempt_no)))
      .limit(1);
  } else {
    // a hearing: the latest attempt the ruling's frames came from (else the latest; then
    // nothing is marked cited, buildWinReplay)
    const rows = await deps.db
      .select(cols)
      .from(attempts)
      .where(eq(attempts.bet_id, snap.bet_id))
      .orderBy(desc(attempts.attempt_no));
    att = rows.find((r) => sameList(r.frame_hashes, ruling.frame_hashes)) ?? rows[0];
  }
  if (!att || att.purged_at !== null || !att.evidence_canonical) return none('purged');
  let evidence: CameraEvidence;
  try {
    const parsed = CameraEvidence.safeParse(JSON.parse(att.evidence_canonical));
    if (!parsed.success) return none('no_frames');
    evidence = parsed.data;
  } catch {
    return none('no_frames');
  }

  const win = buildWinReplay({
    bet_id: snap.bet_id,
    evidence,
    ruling,
    ruling_hash,
    final_outcome: finalOutcome,
    attempt_frame_hashes: att.frame_hashes,
  });
  let foul = null;
  if (deps.replayFouls) {
    try {
      const input = await deps.replayFouls.foulFor(snap.bet_id, att.attempt_no);
      if (input)
        foul = buildFoulReplay(
          {
            bet_id: snap.bet_id,
            attempt_no: att.attempt_no,
            winner: finalOutcome === 'A_WINS' ? 'A' : 'B',
            ruling_hash,
            model: ruling.model,
          },
          input,
          evidence,
        );
    } catch (err) {
      deps.log.warn('replay.foul_source_failed', { bet_id: snap.bet_id, err });
    }
  }
  // a confirmed foul beats a win
  const replay = foul ?? win;
  return replay ? { replay, why: 'ready', final } : none('no_frames');
}

export const replayRoutes: RouteModule = {
  name: 'replay',
  register(app, deps) {
    app.use('/v1/bets/:bet_id/replay', stageCors(deps.env));
    app.get('/v1/bets/:bet_id/replay', requireSession, async (c) => {
      const id = BetId.safeParse(c.req.param('bet_id'));
      if (!id.success) throw validationError(id.error);
      const [row] = await deps.db.select().from(bets).where(eq(bets.id, id.data)).limit(1);
      const auth = c.get('auth');
      // 404 for both "missing" and "not yours", so bet ids can't be probed.
      if (!row || !canRead(auth, row)) throw new HttpError('NOT_FOUND', 'No such bet.');
      const snap = await loadBetSnapshot(deps, row, auth.user_id);
      const out = ReplayResponse.parse(await computeReplay(deps, snap));
      c.header('Cache-Control', 'private, no-store');
      return c.json(out, 200);
    });
  },
};
