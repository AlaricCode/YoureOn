// The judge disc and its line on the negotiate screen. The voice judge is one session on A's phone
// (on speaker, ARCHITECTURE §3.2): B's phone has no mic session, so it never says "Listening";
// it says where the judge is ("Judge on Sim's phone"). On A's phone "Listening" means the
// session is live and the mic is open; before that it is connecting, or waiting for "Jarvis"
// (./wakeGate). Pure TS: tested in node.
import type { BetModel } from '../bets/store';
import { callOffLabels } from './callOff';

export type JudgeHeadLine =
  /** No voice judge at all (EXPO_PUBLIC_VOICE off): the screen's waiting labels. */
  | 'off'
  | 'speaking'
  /** A's phone, the wake gate waiting for "Jarvis" or "Tap to talk": the wake hint. */
  | 'wake'
  | 'listening'
  /** A's phone, the session not live yet (minting a token, connecting). */
  | 'connecting'
  /** A's phone, live but the mic is muted for this state. */
  | 'muted'
  /** B's phone: the judge runs on A's phone. */
  | 'elsewhere';

export interface JudgeHead {
  line: JudgeHeadLine;
  /** The disc's green ring (both phones: B follows the judge's captions). */
  speaking: boolean;
  /** The disc's breathing ring: only while this phone's judge session really listens. */
  listening: boolean;
}

export function judgeHead(o: {
  /** A voice judge runs for this bet (EXPO_PUBLIC_VOICE). */
  voice: boolean;
  /** This phone hosts the judge session (A's phone, not the judge cam). */
  hostsJudge: boolean;
  /** The session is connected (A's phone). */
  live: boolean;
  micMuted: boolean;
  /** The judge is talking: the session's own signal on A, its captions on B. */
  speaking: boolean;
  /** The wake gate holds the judge until "Jarvis" (A's phone). */
  wakeWaiting: boolean;
}): JudgeHead {
  const idle = (line: JudgeHeadLine): JudgeHead => ({ line, speaking: false, listening: false });
  if (!o.voice) return { line: 'off', speaking: o.speaking, listening: false };
  if (o.speaking) return { line: 'speaking', speaking: true, listening: false };
  if (!o.hostsJudge) return idle('elsewhere');
  if (o.wakeWaiting) return idle('wake');
  if (!o.live) return idle('connecting');
  if (o.micMuted) return idle('muted');
  return { line: 'listening', speaking: false, listening: true };
}

/**
 * A's on-screen name for "Judge on {name}'s phone": the call-off / Dance Off naming (./callOff
 * callOffLabels: the first name, or first name + initial when both share one). '' when this phone
 * knows no name for A yet (the copy then says "their phone").
 */
export function judgeHostLabel(
  b: Pick<BetModel, 'party_a' | 'party_b' | 'envelope' | 'challenger'>,
): string {
  const a = b.party_a?.display_name ?? b.envelope?.terms.party_a.display_name ?? null;
  if (a !== null && a.trim()) return callOffLabels(b).A;
  return b.challenger?.display_name.trim().split(/\s+/)[0] ?? '';
}
