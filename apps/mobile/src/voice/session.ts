// The judge session on A's phone as a pure controller over an injected conversation, so the
// failure handling is tested in node with a mocked one (./JudgeVoice.tsx binds it to the
// @elevenlabs/react-native 1.2.38 hooks). One session per bet (D6; never restarted: iOS #991).
//
//   start()        the mic permission first (its iOS prompt is not on the connect clock) ->
//                  POST /v1/voice/tokens (one retry after MINT_RETRY_MS for a retryable error:
//                  a 504 / network blip, never not_configured) -> startSession({conversationToken,
//                  dynamicVariables, clientTools}); connected within CONNECT_TIMEOUT_MS or it failed
//   initialUtterance  what A said after "Jarvis" (../wake): sent once with sendUserMessage the
//                  moment the session connects, before any queued cue (plain text, no [EVENT]),
//                  and captioned as A's line
//   onCue()        judge.cue -> sendUserMessage (speak) / sendContextualUpdate, verbatim (§4.5);
//                  queued while connecting, never thrown into the bet hub's listener loop
//   setMuted()     "mute, don't end" from the terms card on, with
//                  sendUserActivity every 10 s meanwhile so the turn timeout never fires (§4.1)
//   onMessage()    captions (same id as the server's line, so its echo replaces ours) + the
//                  transcript relay (POST /voice/lines); our own [EVENT] text is never captioned
//   failure        a denied mic, a refused token, a start error, no connection in time or a
//                  disconnect we did not ask for -> end the session and onFailed once (the app
//                  types instead).
//                  An onError while connected (e.g. a client tool threw) is logged, not fatal.
//
// Why guarded: the SDK's controls throw "No active conversation" before connect / after end.
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { BetState } from '@youre-on/shared/bet-state';
import type { JudgeCueName } from '@youre-on/shared/api';

import { sha256 } from '../wallet/noble';
import { ATTEMPT_CUES, createLineBatcher, cueAction, type VoiceLine } from './judgeTools';

export const CONNECT_TIMEOUT_MS = 15_000;
/** One retry of a retryable token failure (UPSTREAM_TIMEOUT, a 502 blip, NETWORK) after this. */
export const MINT_RETRY_MS = 1_000;
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
/**
 * Muted in every state but LIVE_MIC_STATES, with one exception (../gg): in RULED the room may ask
 * the judge to check a decisive camera ruling again (request_review), so the mic opens there once
 * the ruling has been spoken (`rulingSpoken`, ./rulingGate: the room can't talk over it). Two
 * mute tones only (LiveKit #344): on after the ruling line, off again when the bet moves on.
 */
export const micMutedFor = (
  state: BetState | null,
  o?: { reviewable: boolean; rulingSpoken: boolean },
): boolean => {
  if (state === 'RULED' && o?.reviewable && o.rulingSpoken) return false;
  return state !== null && MUTED_STATES.has(state);
};

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

export type FailReason = 'mic' | 'token' | 'session' | 'timeout' | 'disconnected';
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
  /**
   * Asks for the microphone before the token is minted, so the iOS permission prompt on a fresh
   * install never runs down CONNECT_TIMEOUT_MS. false = denied (type instead); a throw = unknown
   * (logged; LiveKit asks itself at connect). Omitted: no up-front request.
   */
  micPermission?(): Promise<boolean>;
  /** Rejections carry the server's `code` and `retryable` (net ApiClientError). */
  mintToken(): Promise<{ conversation_token: string; conversation_id: string }>;
  dynamicVariables: Record<string, string | number | boolean>;
  /**
   * The challenge A said after "Jarvis" (../wake), delivered as the first user message once the
   * session connects. Blank or omitted: nothing is sent (the judge opens as usual).
   */
  initialUtterance?: string;
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
  /** The wake utterance, until it is sent; then kept once to drop an SDK echo of it. */
  let opening: string | null = d.initialUtterance?.trim() || null;
  let openingEcho: string | null = null;
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

  /** One finished line: a caption (same id as the server's echo) and the transcript relay. */
  const record = (judge: boolean, text: string, key: string) => {
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
  };

  /** The wake utterance goes first; false = not sent yet (kept for the next status change). */
  const sendOpening = (): boolean => {
    if (opening === null) return true;
    const text = opening;
    if (!safely('opening', (c) => c.sendUserMessage(text))) return false;
    opening = null;
    openingEcho = text;
    record(false, text, `w:${text}`);
    return true;
  };

  const flush = () => {
    // The wake utterance goes first; a cue never overtakes it (sendOpening).
    if (!live() || !sendOpening()) return;
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

  /**
   * mintToken, retried once after MINT_RETRY_MS when the server says the failure is retryable
   * (UPSTREAM_TIMEOUT, an upstream 502, NETWORK). not_configured / spend_disabled are not: no
   * key on the server means typed terms right away.
   */
  const mintOnceMore = async () => {
    try {
      return await d.mintToken();
    } catch (e) {
      if ((e as { retryable?: unknown } | null)?.retryable !== true || over()) throw e;
      const code = (e as { code?: unknown } | null)?.code;
      log('voice.token_retry', { code: typeof code === 'string' ? code : String(e) });
      await new Promise<void>((r) => timers.setTimeout(r, MINT_RETRY_MS));
      if (over()) throw e;
      return d.mintToken();
    }
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
      void (async () => {
        if (d.micPermission) {
          let granted = true;
          try {
            granted = await d.micPermission();
          } catch (e) {
            log('voice.mic_permission_unknown', {
              err: e instanceof Error ? e.message : String(e),
            });
          }
          if (over()) return;
          if (!granted) return fail('mic');
        }
        let tok: { conversation_token: string; conversation_id: string };
        try {
          tok = await mintOnceMore();
        } catch (e) {
          if (over()) return;
          const code = (e as { code?: unknown } | null)?.code;
          return fail('token', typeof code === 'string' ? code : String(e));
        }
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
      })();
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
      // The wake utterance is already captioned (sendOpening): an echo of it is not a new line.
      if (!judge && openingEcho !== null && text === openingEcho) {
        openingEcho = null;
        return;
      }
      const key = utteranceKey({
        event_id: m.event_id,
        response_id: judge ? m.response_id : undefined,
        text,
        at: now(),
      });
      record(judge, text, key);
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
