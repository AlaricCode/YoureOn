// The slow-mo replay's foul hook (GET /v1/bets/:bet_id/replay). A foul detector implements
// ReplayFoulSource on AppDeps.replayFouls; none is wired in this server, so the replay never shows
// a foul. Contract: return ONLY a confirmed foul for that attempt, as a ReplayFoulInput; anything
// suspected, unconfirmed or still running is null. A throw is logged and treated as null (the win
// replay is served).
// Spec: docs/planning/SCHEMAS.md §4.1.
import type { ReplayFoulInput } from '@youre-on/shared/replay';

export interface ReplayFoulSource {
  foulFor(bet_id: string, attempt_no: number): Promise<ReplayFoulInput | null>;
}
