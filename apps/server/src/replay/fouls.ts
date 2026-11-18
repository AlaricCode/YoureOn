// The slow-mo replay's foul hook (SCHEMAS §4.1, API-CONTRACT §2.14 GET /v1/bets/:bet_id/replay).
// A foul detector (the SAM 3.1 tracking stream: attempt_tracking) implements ReplayFoulSource and
// is put on AppDeps.replayFouls; until then it is undefined and the replay never shows a foul.
//
// Contract: return ONLY a confirmed foul (confirmFoul at confidence ≥ 0.7) for that attempt, as a
// ReplayFoulInput (moment_ms on the original clip's timeline, the label/measurement, its stills or
// its pre-slowed render with overlays burned in). Suspected, unconfirmed or still-running: null.
// A throw is logged and treated as null (the win replay is served).
import type { ReplayFoulInput } from '@youre-on/shared/replay';

export interface ReplayFoulSource {
  foulFor(bet_id: string, attempt_no: number): Promise<ReplayFoulInput | null>;
}
