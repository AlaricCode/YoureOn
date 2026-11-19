// "Call it off" on the phones (API-CONTRACT §2.9a, packages/shared/src/call-off.ts): a locked bet
// whose round can't happen (the camera fails, the judge-cam phone dies, a simulator) would pin
// both phones on the attempt / dance screens until resolve_deadline. Every post-lock, pre-ruling
// screen gets a small "Call it off" text button; the other phone gets "{Name} wants to call it
// off. Refund both?" (Agree / Keep playing). Once both agree the server issues a VOID ruling and
// both phones follow the normal VOIDED path (ruling -> payout -> Home). Pure TS: tested in node.
//
// The phone running the round (DanceOffScreen / DanceDisplayScreen / JudgeCamScreen) reports a
// CallOffGuard: while the round counts in, dances or records ('hold') the prompt never covers it
// and nothing is asked; once this phone holds the round's result or clip that the server has
// not judged yet ('scored': a local dance score, a clip still to send) it shows nothing at all,
// so a player who sees the local result can't ask, or agree, to get out of it. Entering a round
// withdraws this phone's own open request (callOffWithdrawDue): a request made before the round
// never carries past it.
import { callOffOpen, type CallOffPayload } from '@youre-on/shared/call-off';
import type { DisplayPhase } from '../dance/model/schedule';
import type { RoundPhase } from '../dance/model/round';
import type { Party } from '@youre-on/shared/primitives';

import type { BetModel } from '../bets/store';
import { danceLabels } from '../dance/copy';
import type { Route } from './machine';

/** The screens the button shows on: every post-lock, pre-ruling one (waiting screens included). */
export const CALL_OFF_ROUTES: ReadonlySet<Route> = new Set<Route>([
  'live',
  'judgeCam',
  'redo',
  'dance',
  'danceDisplay',
  'danceWatch',
]);

/**
 * May this bet be called off now? The server's rule (judge/call-off.ts): LOCKED, ATTEMPT (still
 * recording), or JUDGING right after a REDO. JUDGING with no ruling yet is a ruling in flight, and
 * any other ruling (decisive, or the VOID itself) is out: never.
 */
export function callOffAllowed(b: Pick<BetModel, 'state' | 'ruling'>): boolean {
  if (b.state === 'LOCKED') return true;
  if (b.state === 'ATTEMPT') return true;
  return b.state === 'JUDGING' && b.ruling?.ruling.outcome === 'REDO';
}

/**
 * Where the round on this phone stands, for a call-off: 'open' (nothing running here), 'hold'
 * (counting in, dancing, recording: no prompt over it, no ask), 'scored' (this phone has the
 * round's local result or clip and the server has not judged it yet: nothing at all).
 */
export type CallOffGuard = 'open' | 'hold' | 'scored';

/**
 * The recording phone's Dance Off round (DanceOffScreen). `hasResult`: the local score is out
 * (the result card), from scoring until "Dance again" gives it back; only a camera or start
 * failure with no score lets it be called off again.
 */
export function danceRoundGuard(phase: RoundPhase, hasResult: boolean): CallOffGuard {
  if (hasResult) return 'scored';
  return phase === 'countIn' || phase === 'dancing' || phase === 'scoring' ? 'hold' : 'open';
}

/** The display phone (DanceDisplayScreen): the routine both dancers follow is on screen. */
export const danceDisplayGuard = (phase: DisplayPhase): CallOffGuard =>
  phase === 'countIn' || phase === 'playing' ? 'hold' : 'open';

/**
 * The filming phone (JudgeCamScreen): the countdown and the recording hold it; from Stop on it
 * has a clip for the judge ('sending', 'sent', or a failed send with the clip kept for "Try
 * again"). A failure with no clip (the camera gave nothing) is open again.
 */
export function judgeCamGuard(
  phase: 'standby' | 'countdown' | 'recording' | 'sending' | 'sent',
  o: { failed: boolean; hasClip: boolean },
): CallOffGuard {
  if (phase === 'countdown' || phase === 'recording') return 'hold';
  if (phase === 'sending') return 'scored';
  if (phase === 'sent') return o.failed && !o.hasClip ? 'open' : 'scored';
  return 'open';
}

export type CallOffView =
  /** Nothing to show (not callable, not a party, the judge-cam device). */
  | { kind: 'none' }
  /** The quiet "Call it off" button. */
  | { kind: 'ask' }
  /** This phone asked; waiting for the other party (until expires_at). */
  | { kind: 'waiting'; expiresAtMs: number }
  /** The other party asked: the prompt, Agree / Keep playing. */
  | { kind: 'prompt'; by: Party; expiresAtMs: number };

/**
 * What this phone shows for a bet. `nowMs` is on the server's clock (Date.now() + offset), as the
 * request's `expires_at` is; `judgeCam` devices (the projector-side camera) never show it: A's own
 * phone does.
 */
export function callOffView(
  b: Pick<BetModel, 'state' | 'ruling' | 'callOff' | 'my_party'>,
  o: { nowMs: number; judgeCam: boolean; guard?: CallOffGuard },
): CallOffView {
  if (o.judgeCam || b.my_party === null || !callOffAllowed(b)) return { kind: 'none' };
  const guard = o.guard ?? 'open';
  if (guard === 'scored') return { kind: 'none' };
  const p = b.callOff;
  if (p && callOffOpen(p, o.nowMs) && (p.by === 'A' || p.by === 'B')) {
    const expiresAtMs = Date.parse(p.expires_at ?? '');
    if (p.by === b.my_party) return { kind: 'waiting', expiresAtMs };
    // Their request waits under a running round (it shows once the round ends, if still open).
    return guard === 'hold' ? { kind: 'none' } : { kind: 'prompt', by: p.by, expiresAtMs };
  }
  return guard === 'hold' ? { kind: 'none' } : { kind: 'ask' };
}

/**
 * Should this phone withdraw its own open request now? Yes once its round is running or done
 * ('hold' / 'scored'): a request made before the round must not be agreed to after it. Never on
 * the judge-cam device (it takes no call-off steps).
 */
export function callOffWithdrawDue(
  b: Pick<BetModel, 'callOff' | 'my_party'>,
  o: { nowMs: number; judgeCam: boolean; guard: CallOffGuard },
): boolean {
  if (o.judgeCam || o.guard === 'open' || b.my_party === null) return false;
  const p = b.callOff;
  return !!p && p.by === b.my_party && callOffOpen(p, o.nowMs);
}

/** The "Call it off?" confirm sheet's open flag: it closes whenever the view leaves 'ask'. */
export type CallOffConfirmEvent =
  { type: 'open' } | { type: 'close' } | { type: 'view'; kind: CallOffView['kind'] };

export function callOffConfirm(open: boolean, e: CallOffConfirmEvent): boolean {
  if (e.type === 'open') return true;
  if (e.type === 'close') return false;
  return e.kind === 'ask' ? open : false;
}

/** Does the route show the call-off control at all (the button or the prompt)? */
export const callOffOnRoute = (route: Route): boolean => CALL_OFF_ROUTES.has(route);

/**
 * The display name to put in the prompt ("Jake wants to call it off"): the asking party's, from
 * the bet's parties or its terms.
 */
export function callOffName(
  b: Pick<BetModel, 'party_a' | 'party_b' | 'envelope'>,
  p: Party,
): string {
  const ref = p === 'A' ? b.party_a : b.party_b;
  const terms = b.envelope?.terms;
  const fromTerms = p === 'A' ? terms?.party_a.display_name : terms?.party_b.display_name;
  return ref?.display_name ?? fromTerms ?? 'They';
}

/**
 * Both parties as the call-off copy names them: the Dance Off labels (../dance/copy danceLabels),
 * first names unless both share one ("Sim A" / "Sim B"), so "Sim wants to call it off" never
 * leaves the player guessing which Sim.
 */
export function callOffLabels(
  b: Pick<BetModel, 'party_a' | 'party_b' | 'envelope'>,
): Readonly<Record<Party, string>> {
  const l = danceLabels({ a: callOffName(b, 'A'), b: callOffName(b, 'B') });
  return { A: l.a, B: l.b };
}

/**
 * Did the other party just turn this phone's request down ("Keep playing")? This phone's open
 * request (`prev`), then a `cleared` step by the other party (`next`). A withdrawal of its own,
 * a lapse (no event) or the agree are not.
 */
export function keptPlayingBy(
  prev: Pick<CallOffPayload, 'status' | 'by'> | null,
  next: Pick<CallOffPayload, 'status' | 'by'> | null,
  me: Party,
): Party | null {
  if (!prev || !next || prev.status !== 'requested' || prev.by !== me) return null;
  if (next.status !== 'cleared' || next.by === me || next.by === 'operator') return null;
  return next.by;
}

/** How long the "{Name} wants to keep playing" note stays up. */
export const KEPT_PLAYING_NOTE_MS = 4_000;

/**
 * The corner's widest box (pt): its right edge stops TITLE_HALF_PT left of the screen's centre,
 * so its text (12 pt in from that edge) ends about 7 pt before the top bar's centred title (the
 * widest on these screens, "Judge cam" / "Dance off" at 17 pt, is about 90 pt). The label's tail
 * is cut beyond it. `left` is the corner's own inset from the screen edge.
 */
const TITLE_HALF_PT = 40;
export const callOffCornerWidth = (screenWidth: number, left: number): number =>
  Math.max(0, Math.floor(screenWidth / 2 - TITLE_HALF_PT - left));
