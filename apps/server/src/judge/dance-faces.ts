// Which dance offs had BOTH players identified by face (docs/planning/DANCE-OFF.md §3, §5).
//
// The upload's starting sides come from the series the recording phone sends, so the server
// cannot tell, from the series alone, a face-identified A standing on the right from a recorder
// that labels B's skeleton as A (or players who crossed before the series window). So the right
// to start A on the right is the server's own record: POST …/dance/identify notes the bet when
// its answer assigned both parties (and drops the note when a later answer did not), and the
// upload's DanceEvidence uses the series' starting sides (checks.a_start_side) only when the
// note is there. Without it the left / right rule applies: A is expected on the left, and a
// sustained A-right-of-B counts as a side swap (the validator calls that round invalid: both
// refunded, never a wrong winner).
//
// What it keeps: per bet, the instant of the last both-identified answer. No faces, scores or
// vectors. In memory (the server is one always-on machine, like the rate limits and the WS
// fan-out): a restart forgets it, which is the left / right rule, the fail-safe side. A note
// lives NOTE_TTL_MS, more than a round's framing + attempt + upload.
import type { AppDeps } from '../context';

export const DANCE_FACES_NOTE_TTL_MS = 30 * 60_000;

const notes = new WeakMap<object, Map<string, number>>();

const store = (deps: Pick<AppDeps, 'now'>): Map<string, number> => {
  let m = notes.get(deps);
  if (!m) {
    m = new Map();
    notes.set(deps, m);
  }
  return m;
};

/** Records the identify answer for the bet: both parties assigned, or not (drops the note). */
export function noteDanceFaces(
  deps: Pick<AppDeps, 'now'>,
  betId: string,
  bothIdentified: boolean,
): void {
  const m = store(deps);
  const now = deps.now();
  for (const [id, at] of m) if (now - at > DANCE_FACES_NOTE_TTL_MS) m.delete(id);
  if (bothIdentified) m.set(betId, now);
  else m.delete(betId);
}

/** The bet's players were both identified by face, recently enough. */
export function danceFacesIdentified(deps: Pick<AppDeps, 'now'>, betId: string): boolean {
  const at = store(deps).get(betId);
  return at !== undefined && deps.now() - at <= DANCE_FACES_NOTE_TTL_MS;
}

/** Whether an identify answer assigned both parties (one face each). */
export const bothPartiesAssigned = (assignments: readonly { party: string }[]): boolean =>
  assignments.some((a) => a.party === 'A') && assignments.some((a) => a.party === 'B');
