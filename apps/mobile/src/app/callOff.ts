// "Call it off" on the phones (API-CONTRACT §2.9a, packages/shared/src/call-off.ts): a locked bet
// whose round can't happen (the camera fails, the judge-cam phone dies, a simulator) would pin
// both phones on the attempt / dance screens until resolve_deadline. Every post-lock, pre-ruling
// screen gets a small "Call it off" text button; the other phone gets "{Name} wants to call it
// off. Refund both?" (Agree / Keep playing). Once both agree the server issues a VOID ruling and
// both phones follow the normal VOIDED path (ruling -> payout -> Home). Pure TS: tested in node.
import { callOffOpen } from '@youre-on/shared/call-off';
import type { Party } from '@youre-on/shared/primitives';

import type { BetModel } from '../bets/store';
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
  o: { nowMs: number; judgeCam: boolean },
): CallOffView {
  if (o.judgeCam || b.my_party === null || !callOffAllowed(b)) return { kind: 'none' };
  const p = b.callOff;
  if (p && callOffOpen(p, o.nowMs) && (p.by === 'A' || p.by === 'B')) {
    const expiresAtMs = Date.parse(p.expires_at ?? '');
    return p.by === b.my_party
      ? { kind: 'waiting', expiresAtMs }
      : { kind: 'prompt', by: p.by, expiresAtMs };
  }
  return { kind: 'ask' };
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
