// "Jarvis" (../wake) in the real app, as pure rules DemoApp reads (tested in
// ./__tests__/wakeGate.test.ts):
//   - wakeListening   when this phone listens for "Jarvis": Home (in a room) and A's negotiate
//                     screen while the judge waits for it; never while a judge session is mounted
//                     (or just released: LiveKit and the recognizer share one AVAudioSession), on a
//                     judge cam, or on any other screen (a dance round owns the camera and mic)
//   - judgeWaitsForWake  the judge does not start by itself: it starts on the wake utterance or
//                     on "Tap to talk". Off when the flag is off or the module is missing from this
//                     binary: then the judge starts exactly as before (on the negotiate screen)
//   - judgeAutoStarts the judge also starts without a wake once the bet has moved past the
//                     negotiation (typed terms, Bet on Bitcoin, Dance off), so it still hosts the
//                     lock, the attempt and the ruling as before; never for a bet that is over
//   - homeWakeAction  "Jarvis, …" on Home starts a challenge the way Home's buttons do: the person
//                     it names, else the face scan, else the one person online, else "pick one"
//   - heldUtterance   what was said on Home waits (HOLD_MS) for that challenge's negotiate screen
//   - loopReducer     the RainbowLoop: listening from the wake through the sentence, thinking
//                     while the judge connects, off once the judge talks (or it failed / was cancelled)
import type { WakeStatus } from '../wake/controller';
import { normalizeTranscript } from '../wake/phrase';
import type { SessionPhase } from '../voice/session';

/** What Home said waits this long for the challenge it started. */
export const HOLD_MS = 120_000;
/** After the judge session unmounts, the audio session settles this long before listening again. */
export const JUDGE_RELEASE_MS = 1_500;
/** Home listens again this long after a sentence that did not leave Home ("pick one"). */
export const HEARD_REARM_MS = 3_000;
/** The thinking loop never outlives this (a judge that connects but never talks). */
export const THINKING_MAX_MS = 20_000;
/** Once connected, the judge has this long to start talking before the loop goes. */
export const CONNECTED_GRACE_MS = 5_000;

export interface WakeListenInput {
  /** EXPO_PUBLIC_WAKE (and a voice judge at all). */
  flag: boolean;
  signedIn: boolean;
  judgeCam: boolean;
  /** DemoApp's route (./machine selectRoute). */
  route: string;
  inRoom: boolean;
  /** A's negotiate screen, its judge waiting for "Jarvis" or a tap. */
  judgePending: boolean;
  /** A judge session is mounted, or was released less than JUDGE_RELEASE_MS ago. */
  judgeBusy: boolean;
}

export function wakeListening(i: WakeListenInput): boolean {
  if (!i.flag || !i.signedIn || i.judgeCam || i.judgeBusy) return false;
  if (i.route === 'home') return i.inRoom;
  if (i.route === 'negotiate') return i.judgePending;
  return false;
}

/**
 * The judge waits for "Jarvis" or a tap. Only a binary known to lack the module (status
 * 'unavailable') keeps the old auto-start; while the module is still loading it waits (a tap
 * always works). Denied / error wait too: "Tap to talk" is the way in.
 */
export function judgeWaitsForWake(i: {
  flag: boolean;
  available: boolean;
  status: WakeStatus;
}): boolean {
  if (!i.flag) return false;
  return i.available || i.status !== 'unavailable';
}

const NEGOTIATION: ReadonlySet<string> = new Set(['DRAFTING', 'TERMS_PROPOSED']);

/** The judge starts without a wake: no wake gate, or the bet left the negotiation (not over). */
export function judgeAutoStarts(i: {
  waits: boolean;
  state: string | null;
  over: boolean;
}): boolean {
  if (!i.waits) return true;
  // No state yet: the bet is still being drafted, so the judge waits for the wake word too.
  if (i.state === null) return false;
  return !NEGOTIATION.has(i.state) && !i.over;
}

export interface WakeOpponent {
  readonly user_id: string;
  readonly display_name: string;
  readonly online: boolean;
}

export type HomeWake =
  | { readonly kind: 'challenge'; readonly userId: string }
  | { readonly kind: 'scan' }
  | { readonly kind: 'pick' }
  | { readonly kind: 'none' };

/** The words of a display name that can stand for the person ("Jake", "Jake Mo" -> jake, mo). */
const nameWords = (name: string) =>
  normalizeTranscript(name)
    .split(' ')
    .filter((w) => w.length >= 2);

/** The one online opponent whose name the sentence says, if exactly one. */
export function namedOpponent(
  text: string,
  opponents: readonly WakeOpponent[],
): WakeOpponent | null {
  const said = new Set(normalizeTranscript(text).split(' '));
  const hits = opponents.filter(
    (o) => o.online && nameWords(o.display_name).some((w) => said.has(w)),
  );
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** What "Jarvis, …" does on Home. */
export function homeWakeAction(i: {
  text: string;
  inRoom: boolean;
  canScan: boolean;
  opponents: readonly WakeOpponent[];
}): HomeWake {
  if (!i.inRoom) return { kind: 'none' };
  const named = namedOpponent(i.text, i.opponents);
  if (named) return { kind: 'challenge', userId: named.user_id };
  if (i.canScan) return { kind: 'scan' };
  const online = i.opponents.filter((o) => o.online);
  if (online.length === 1 && online[0]) return { kind: 'challenge', userId: online[0].user_id };
  return { kind: 'pick' };
}

export interface HeldUtterance {
  readonly text: string;
  readonly atMs: number;
}

/** The held sentence while it is fresh, else null. */
export function heldUtterance(h: HeldUtterance | null, nowMs: number): string | null {
  if (!h) return null;
  return nowMs - h.atMs >= 0 && nowMs - h.atMs <= HOLD_MS ? h.text : null;
}

export type LoopState = 'off' | 'listening' | 'thinking';

export type LoopEvent =
  /** "Jarvis" heard. */
  | { readonly type: 'wake' }
  /** The capture ended without a sentence. */
  | { readonly type: 'cancel' }
  /** The sentence is in: to the judge now (negotiate) or not yet (Home -> scan / pick). */
  | { readonly type: 'utterance'; readonly toJudge: boolean }
  /** "Tap to talk": the judge connects. */
  | { readonly type: 'tap' }
  /** The judge session's phase and whether it is talking. */
  | { readonly type: 'judge'; readonly phase: SessionPhase; readonly speaking: boolean }
  /** Off: the screen changed, or a deadline passed. */
  | { readonly type: 'reset' };

export function loopReducer(s: LoopState, e: LoopEvent): LoopState {
  switch (e.type) {
    case 'wake':
      return 'listening';
    case 'cancel':
      return s === 'listening' ? 'off' : s;
    case 'utterance':
      return e.toJudge ? 'thinking' : 'off';
    case 'tap':
      return 'thinking';
    case 'judge':
      if (s !== 'thinking') return s;
      return e.speaking || e.phase === 'failed' || e.phase === 'stopped' ? 'off' : s;
    case 'reset':
      return 'off';
  }
}
