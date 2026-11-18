// The terms card's own state (TASKS D2-M1, D2-M2, D2-M4; SCHEMAS §9.4; ARCHITECTURE §5.2).
// Pure reducer, tested in node. The screen feeds it server pushes and local results.
//
//   checking ─policy ok─▶ ready ─hold done─▶ authorizing ─signed─▶ signed ─both─▶ locking ─▶ locked
//      │policy fail            │ auth cancelled → ready ("Use passcode" stays offered)
//      ▼                       │ their signature → ready with theirsIn = true
//   refused                    └ decline / expiry / lock failed / terms changed → ended
//   checking/ready ─already signed (a restart after this phone's hold: the snapshot says so)─▶ signed
//
// Decline works until the second signature, even after this phone signed (SCHEMAS §9.4).

export type EndReason = 'declined' | 'expired' | 'lock_failed' | 'terms_changed';

export type LockPhase =
  'checking' | 'refused' | 'ready' | 'authorizing' | 'signed' | 'locking' | 'locked' | 'ended';

export interface LockState {
  phase: LockPhase;
  /** The other party has signed ("Jake is in"). */
  theirsIn: boolean;
  /** The last Face ID attempt was cancelled or failed: offer the passcode. */
  authFailed: boolean;
  /** Face ID passed but the signature did not reach the server (offline, a 5xx): try again. */
  sendFailed: boolean;
  endReason: EndReason | null;
}

/** Why an authorization did not go through: the prompt, the device policy, or the send. */
export type AuthFailure = 'auth' | 'policy' | 'send';

export type LockEvent =
  | { type: 'reset' }
  | { type: 'policy'; ok: boolean }
  | { type: 'hold_complete' }
  | { type: 'auth_result'; ok: boolean; failure?: AuthFailure }
  | { type: 'their_signature' }
  /** The bet snapshot already holds this phone's signature (the app restarted after the hold). */
  | { type: 'already_signed' }
  | { type: 'submitted' }
  | { type: 'confirmed' }
  | { type: 'end'; reason: EndReason };

export const initialLock: LockState = {
  phase: 'checking',
  theirsIn: false,
  authFailed: false,
  sendFailed: false,
  endReason: null,
};

const FINAL: ReadonlySet<LockPhase> = new Set(['refused', 'locked', 'ended']);

export function lockReducer(s: LockState, e: LockEvent): LockState {
  // A new AuthorizeRequest (first card, or "review again") starts over.
  if (e.type === 'reset') return initialLock;
  if (FINAL.has(s.phase)) return s;
  switch (e.type) {
    case 'policy':
      return s.phase === 'checking' ? { ...s, phase: e.ok ? 'ready' : 'refused' } : s;
    case 'hold_complete':
      return s.phase === 'ready'
        ? { ...s, phase: 'authorizing', authFailed: false, sendFailed: false }
        : s;
    case 'auth_result':
      if (s.phase !== 'authorizing') return s;
      if (e.ok) return { ...s, phase: 'signed' };
      // The device policy refused the message itself: never offer the hold again.
      if (e.failure === 'policy') return { ...s, phase: 'refused' };
      // Face ID was fine; the send failed. Not a Face ID problem, so don't say it is.
      if (e.failure === 'send') return { ...s, phase: 'ready', sendFailed: true };
      return { ...s, phase: 'ready', authFailed: true };
    case 'their_signature':
      return { ...s, theirsIn: true };
    case 'already_signed':
      // Not "Hold to lock" again: a second hold would re-prompt Face ID for a signature the
      // server already has (it treats the resend as idempotent, but the card would be wrong).
      return s.phase === 'checking' || s.phase === 'ready'
        ? { ...s, phase: 'signed', authFailed: false, sendFailed: false }
        : s;
    case 'submitted':
      return s.phase === 'signed' || s.phase === 'ready' ? { ...s, phase: 'locking' } : s;
    case 'confirmed':
      return { ...s, phase: 'locked' };
    case 'end':
      // No withdrawal once the pair is complete: the lock is already on its way.
      if (s.phase === 'locking') return s;
      return { ...s, phase: 'ended', endReason: e.reason };
  }
}

/** The hold is live only when the policy passed and this phone hasn't signed yet. */
export const holdEnabled = (s: LockState): boolean => s.phase === 'ready';

/** Decline is offered until the lock is sent. */
export const declineEnabled = (s: LockState): boolean =>
  s.phase === 'ready' || s.phase === 'signed' || s.phase === 'authorizing';

/** SCHEMAS §9.4 copy for each way a lock ends without moving money. */
export const END_COPY: Readonly<Record<EndReason, string>> = {
  declined: 'Declined. Nothing moved.',
  expired: 'Expired. Nothing moved.',
  lock_failed: "Couldn't lock it. Nothing moved.",
  terms_changed: 'Terms changed, review again',
};
