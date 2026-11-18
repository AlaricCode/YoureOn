// The judge session on A's phone as a pure controller over an injected conversation, so the
// failure handling is tested in node with a mocked one (./JudgeVoice.tsx binds it to the
// @elevenlabs/react-native 1.2.38 hooks). One session per bet (D6; never restarted: iOS #991).
//
//   start()        POST /v1/voice/tokens -> startSession({conversationToken, dynamicVariables,
//                  clientTools}); connected within CONNECT_TIMEOUT_MS or it failed
//   onCue()        judge.cue -> sendUserMessage (speak) / sendContextualUpdate, verbatim (§4.5);
//                  queued while connecting, never thrown into the bet hub's listener loop
//   setMuted()     "mute, don't end" from the terms card on (FINDINGS §4), with
//                  sendUserActivity every 10 s meanwhile so the turn timeout never fires (§4.1)
//   onMessage()    captions (same id as the server's line, so its echo replaces ours) + the
//                  transcript relay (POST /voice/lines); our own [EVENT] text is never captioned
//   failure        a refused token, a start error, no connection in time or a disconnect we did
//                  not ask for -> end the session and onFailed once (the app types instead).
//                  An onError while connected (e.g. a client tool threw) is logged, not fatal.
//
// Why guarded: the SDK's controls throw "No active conversation" before connect / after end.
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { BetState } from '@youre-on/shared/bet-state';
import type { JudgeCueName } from '@youre-on/shared/api';

import { sha256 } from '../wallet/noble';
import { ATTEMPT_CUES, createLineBatcher, cueAction, type VoiceLine } from './judgeTools';

export const CONNECT_TIMEOUT_MS = 15_000;
export const ACTIVITY_EVERY_MS = 10_000;
/** Cues that arrive before the session connects (the latest kept). */
export const MAX_QUEUED_CUES = 8;

/**
 * The only bet states in which the judge must hear the room: the negotiation (DRAFTING,
 * TERMS_PROPOSED) and a hearing (the parties argue out loud). Every other state mutes A's mic:
 * the terms card (hold + Face ID), the lock, the attempt (the room cheers at the camera; the
 * judge must not answer that), the 5-minute market wait (Beat 6: the judge is on speaker during
 * the pitch), the ruling and its appeal / GG window (no spoken tool there: file_appeal is not
 * registered; they tap), and the terminal states (the session only lingers to speak the closing
 * [EVENT] line). Muting by default keeps it one continuous span from the card to the end, since
 * every mute toggle plays an iOS tone (LiveKit #344), and a state added later starts muted.
 */
export const LIVE_MIC_STATES: ReadonlySet<BetState> = new Set([
  'DRAFTING',
  'TERMS_PROPOSED',
  'HEARING',
]);
export const MUTED_STATES: ReadonlySet<BetState> = new Set(
  BetState.options.filter((s) => !LIVE_MIC_STATES.has(s)),
);
export const micMutedFor = (state: BetState | null): boolean =>
  state !== null && MUTED_STATES.has(state);

/** What the controller needs from the SDK conversation (useConversation's return value). */
export interface ConversationPort {
  startSession(o: {
    conversationToken: string;
    dynamicVariables: Record<string, string | number | boolean>;
  }): void;
  endSession(): void;
  sendUserMessage(text: string): void;
  sendContextualUpdate(text: string): void;
  sendUserActivity(): void;
  setMuted(muted: boolean): void;
}

export type FailReason = 'token' | 'session' | 'timeout' | 'disconnected';
export type SessionPhase = 'idle' | 'minting' | 'connecting' | 'connected' | 'failed' | 'stopped';

export interface Caption {
  id: string;
  who: 'judge' | 'a';
  text: string;
}

interface Timers {
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(f: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}
const realTimers: Timers = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface JudgeSessionDeps {
  betId: string;
  /** The current conversation (a getter: the hook's object changes every render). */
  conv(): ConversationPort;
  mintToken(): Promise<{ conversation_token: string; conversation_id: string }>;
  dynamicVariables: Record<string, string | number | boolean>;
  postLines(lines: VoiceLine[]): Promise<void>;
  onCaption(c: Caption): void;
  onFailed(reason: FailReason): void;
  onPhase?(p: SessionPhase): void;
  log?(msg: string, extra?: unknown): void;
  now?(): number;
  timers?: Timers;
  connectTimeoutMs?: number;
  activityEveryMs?: number;
}

/**
 * What identifies one line within the conversation. The SDK's event_id is the turn counter: a
 * turn with a tool call (pre-tool speech "Bold. Writing that down.", then the read-back) has two
 * agent responses with one event_id, so it is not enough. An agent response's response_id is
 * stable across streamed parts and resends; without one, the text tells two lines of one turn
 * apart while a resend stays the same line.
 */
export function utteranceKey(m: {
  event_id?: number;
  response_id?: string;
  text: string;
  at: number;
}): string {
  if (m.response_id) return `r:${m.response_id}`;
  return `e:${m.event_id ?? m.at}:${m.text}`;
}

/**
 * A UUIDv4-shaped utterance id from the bet, the speaker and utteranceKey(). Deterministic, so a
 * re-sent line is the same line (voice/lines idempotency) and the server's judge.line echo
 * replaces the local caption; the variant nibble (8 judge / 9 party) keeps an agent response and
 * a user transcript apart. The tail is 48 bits of sha256(key).
 */
export function utteranceId(betId: string, role: 'judge' | 'party', key: string): string {
  const h = bytesToHex(sha256(utf8ToBytes(key))).slice(0, 12);
  const b = betId.toLowerCase();
  return `${b.slice(0, 8)}-${b.slice(9, 13)}-4${b.slice(15, 18)}-${role === 'judge' ? '8' : '9'}${b.slice(20, 23)}-${h}`;
}

/** Our own [EVENT] text (sendUserMessage) is a system announcement, never a party's words. */
export const isEventLine = (text: string): boolean => /^\s*\[EVENT\]/i.test(text);

export function createJudgeSession(d: JudgeSessionDeps) {
  const timers = d.timers ?? realTimers;
  const now = d.now ?? Date.now;
  const log = d.log ?? (() => undefined);
  let phase: SessionPhase = 'idle';
  let expectedConversationId: string | null = null;
  let connectTimer: unknown = null;
  let activityTimer: unknown = null;
  let muted = false;
  let attemptAllowed = false;
  let queue: Array<{ send: 'user' | 'context'; text: string }> = [];
  const batcher = createLineBatcher(async (lines) => {
    await d.postLines(lines);
  });

  const setPhase = (p: SessionPhase) => {
    phase = p;
    d.onPhase?.(p);
  };
  const live = () => phase === 'connected';
  const over = () => phase === 'failed' || phase === 'stopped';

  /** Runs an SDK control, swallowing "No active conversation" (and anything else) with a log. */
  const safely = (what: string, f: (c: ConversationPort) => void): boolean => {
    try {
      f(d.conv());
      return true;
    } catch (e) {
      log(`voice.${what}_failed`, { err: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const clearTimers = () => {
    if (connectTimer !== null) timers.clearTimeout(connectTimer);
    connectTimer = null;
    if (activityTimer !== null) timers.clearInterval(activityTimer);
    activityTimer = null;
  };

  const syncActivity = () => {
    const want = live() && muted;
    if (want && activityTimer === null)
      activityTimer = timers.setInterval(
        () => void safely('activity', (c) => c.sendUserActivity()),
        d.activityEveryMs ?? ACTIVITY_EVERY_MS,
      );
    if (!want && activityTimer !== null) {
      timers.clearInterval(activityTimer);
      activityTimer = null;
    }
  };

  const flush = () => {
    while (live() && queue.length) {
      const a = queue[0]!;
      const ok = safely('cue', (c) =>
        a.send === 'user' ? c.sendUserMessage(a.text) : c.sendContextualUpdate(a.text),
      );
      if (!ok) return; // keep it for the next status change
      queue.shift();
    }
  };

  const fail = (reason: FailReason, extra?: unknown) => {
    if (over()) return;
    log('voice.failed', { reason, extra });
    clearTimers();
    queue = [];
    setPhase('failed');
    batcher.flush();
    safely('end', (c) => c.endSession());
    d.onFailed(reason);
  };

  const onConnected = () => {
    if (connectTimer !== null) timers.clearTimeout(connectTimer);
    connectTimer = null;
    if (phase !== 'connected') setPhase('connected');
    if (muted) safely('mute', (c) => c.setMuted(true));
    flush();
    syncActivity();
  };

  return {
    phase: () => phase,
    /** request_attempt is legal only after [EVENT] LOCKED or [EVENT] REDO (§4.4). */
    canAttempt: () => attemptAllowed,

    start() {
      if (phase !== 'idle') return;
      setPhase('minting');
      d.mintToken().then(
        (tok) => {
          if (over()) return;
          expectedConversationId = tok.conversation_id;
          setPhase('connecting');
          connectTimer = timers.setTimeout(
            () => fail('timeout'),
            d.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
          );
          try {
            d.conv().startSession({
              conversationToken: tok.conversation_token,
              dynamicVariables: d.dynamicVariables,
            });
          } catch (e) {
            fail('session', e instanceof Error ? e.message : String(e));
          }
        },
        (e: unknown) => {
          if (over()) return;
          const code = (e as { code?: unknown } | null)?.code;
          fail('token', typeof code === 'string' ? code : String(e));
        },
      );
    },

    /** Our unmount: end quietly (no fallback). */
    stop() {
      if (over()) return;
      clearTimers();
      queue = [];
      setPhase('stopped');
      batcher.flush();
      safely('end', (c) => c.endSession());
    },

    // ---- SDK callbacks ----------------------------------------------------------------
    onStatus(status: string) {
      if (over()) return;
      if (status === 'connected') onConnected();
      else if (status === 'disconnected' && phase === 'connected') fail('disconnected');
    },
    onConnect(p: { conversationId?: string }) {
      if (over()) return;
      if (expectedConversationId && p.conversationId && p.conversationId !== expectedConversationId)
        // The webhook tools bind conversation_id -> bet (voice_sessions): every call would be
        // WRONG_BET. Not fatal here (the judge still talks), but it must be seen on the device.
        log('voice.conversation_id_mismatch', {
          minted: expectedConversationId,
          connected: p.conversationId,
        });
      onConnected();
    },
    onDisconnect(details: { reason?: string }) {
      if (over()) return;
      fail('disconnected', details.reason);
    },
    onError(message: string) {
      if (over()) return;
      if (phase === 'connected') {
        log('voice.error', { message }); // e.g. a client tool threw: the session goes on
        return;
      }
      fail('session', message);
    },
    onMessage(m: {
      role?: string;
      source?: string;
      message: string;
      event_id?: number;
      response_id?: string;
    }) {
      if (over()) return;
      const judge = m.role === 'agent' || m.source === 'ai';
      const text = m.message.trim();
      if (!text || (!judge && isEventLine(text))) return;
      const key = utteranceKey({
        event_id: m.event_id,
        response_id: judge ? m.response_id : undefined,
        text,
        at: now(),
      });
      const id = utteranceId(d.betId, judge ? 'judge' : 'party', key);
      d.onCaption({ id, who: judge ? 'judge' : 'a', text });
      batcher.add({
        utterance_id: id,
        role: judge ? 'judge' : 'party',
        ...(judge ? {} : { party: 'A' as const }),
        text: text.slice(0, 600),
        final: true,
        at: new Date(now()).toISOString(),
      });
    },

    // ---- the server's side ------------------------------------------------------------
    onCue(c: { cue: JudgeCueName; text: string; speak: boolean }) {
      if (ATTEMPT_CUES.has(c.cue)) attemptAllowed = true;
      if (c.cue === 'ATTEMPT_ARMED') attemptAllowed = false;
      if (over()) return;
      queue.push(cueAction(c));
      if (queue.length > MAX_QUEUED_CUES) queue = queue.slice(-MAX_QUEUED_CUES);
      flush();
    },
    setMuted(m: boolean) {
      if (m === muted) return;
      muted = m;
      if (live()) safely('mute', (c) => c.setMuted(m));
      syncActivity();
    },
  };
}
export type JudgeSession = ReturnType<typeof createJudgeSession>;
