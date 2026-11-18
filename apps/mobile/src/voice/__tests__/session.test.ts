import { Uuid } from '@youre-on/shared/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceLine } from '../judgeTools';
import {
  ACTIVITY_EVERY_MS,
  CONNECT_TIMEOUT_MS,
  createJudgeSession,
  isEventLine,
  micMutedFor,
  utteranceId,
  type Caption,
  type ConversationPort,
  type FailReason,
} from '../session';

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const VARS = { bet_id: BET, party_a_name: 'Logan', party_b_name: 'Jake', max_stake_usd: '20' };

/**
 * A mocked @elevenlabs/react-native conversation with the SDK's real quirk: every control throws
 * "No active conversation" until the session is connected (ConversationControls.getConversation).
 */
function mockConversation() {
  const calls: Array<[string, unknown?]> = [];
  let active = false;
  const guard = (name: string, arg?: unknown) => {
    calls.push([name, arg]);
    if (!active) throw new Error('No active conversation. Call startSession() first.');
  };
  const port: ConversationPort = {
    startSession: (o) => void calls.push(['startSession', o]),
    endSession: () => {
      calls.push(['endSession']);
      active = false;
    },
    sendUserMessage: (t) => guard('sendUserMessage', t),
    sendContextualUpdate: (t) => guard('sendContextualUpdate', t),
    sendUserActivity: () => guard('sendUserActivity'),
    setMuted: (m) => guard('setMuted', m),
  };
  return {
    port,
    calls,
    connect: () => (active = true),
    sent: () => calls.filter(([n]) => n === 'sendUserMessage' || n === 'sendContextualUpdate'),
  };
}

function setup(o: { token?: 'ok' | 'fail' } = {}) {
  const conv = mockConversation();
  const failed: FailReason[] = [];
  const captions: Caption[] = [];
  const posted: VoiceLine[][] = [];
  const logs: string[] = [];
  const s = createJudgeSession({
    betId: BET,
    conv: () => conv.port,
    mintToken: () =>
      o.token === 'fail'
        ? Promise.reject(Object.assign(new Error('judge not set up'), { code: 'UPSTREAM_ERROR' }))
        : Promise.resolve({ conversation_token: 'lk_tok', conversation_id: 'conv_1' }),
    dynamicVariables: VARS,
    postLines: async (l) => void posted.push(l),
    onCaption: (c) => captions.push(c),
    onFailed: (r) => failed.push(r),
    log: (m) => logs.push(m),
    now: () => Date.parse('2026-11-21T18:00:00.000Z'),
  });
  /** start() and let the token promise settle. */
  const started = async () => {
    s.start();
    await vi.advanceTimersByTimeAsync(0);
  };
  /** What the SDK does on a good connect: conversation created, status, onConnect. */
  const connected = (conversationId = 'conv_1') => {
    conv.connect();
    s.onStatus('connected');
    s.onConnect({ conversationId });
  };
  return { s, conv, failed, captions, posted, logs, started, connected };
}

const cue = (name: string, speak = true) => ({
  cue: name as never,
  text: `[EVENT] ${name} x=1 :: Do the thing.`,
  speak,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('judge session: start and failure -> typed fallback', () => {
  it('mints, then startSession with the token and the dynamic variables verbatim', async () => {
    const t = setup();
    await t.started();
    expect(t.conv.calls[0]).toEqual([
      'startSession',
      { conversationToken: 'lk_tok', dynamicVariables: VARS },
    ]);
    expect(t.s.phase()).toBe('connecting');
    t.connected();
    expect(t.s.phase()).toBe('connected');
    expect(t.failed).toEqual([]);
  });

  it('a refused token (no key on the server: 502 not_configured) fails once with "token"', async () => {
    const t = setup({ token: 'fail' });
    await t.started();
    expect(t.failed).toEqual(['token']);
    expect(t.conv.calls.filter(([n]) => n === 'startSession')).toEqual([]);
    expect(t.s.phase()).toBe('failed');
  });

  it('a start error before connecting fails; a client-tool error while connected does not', async () => {
    const t = setup();
    await t.started();
    t.s.onError('Session failed to start');
    expect(t.failed).toEqual(['session']);
    expect(t.conv.calls.at(-1)).toEqual(['endSession']);

    const u = setup();
    await u.started();
    u.connected();
    u.s.onError('Client tool execution failed with following error: boom');
    expect(u.failed).toEqual([]);
    expect(u.s.phase()).toBe('connected');
  });

  it(`no connection within ${CONNECT_TIMEOUT_MS / 1000} s fails with "timeout" and ends the attempt`, async () => {
    const t = setup();
    await t.started();
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS - 1);
    expect(t.failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.failed).toEqual(['timeout']);
    expect(t.conv.calls.map(([n]) => n)).toContain('endSession');
    // a late connect after the fallback changes nothing
    t.connected();
    expect(t.s.phase()).toBe('failed');
    expect(t.failed).toEqual(['timeout']);
  });

  it('a disconnect we did not ask for fails; our own stop() never does', async () => {
    const t = setup();
    await t.started();
    t.connected();
    t.s.onDisconnect({ reason: 'error' });
    t.s.onStatus('disconnected');
    expect(t.failed).toEqual(['disconnected']); // once

    const u = setup();
    await u.started();
    u.connected();
    u.s.stop();
    u.s.onStatus('disconnecting');
    u.s.onStatus('disconnected');
    u.s.onDisconnect({ reason: 'user' });
    expect(u.failed).toEqual([]);
    expect(u.s.phase()).toBe('stopped');
    expect(u.conv.calls.at(-1)).toEqual(['endSession']);
  });

  it('stop() during the token mint never starts a session', async () => {
    const t = setup();
    t.s.start();
    t.s.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.conv.calls.filter(([n]) => n === 'startSession')).toEqual([]);
    expect(t.failed).toEqual([]);
  });

  it('a conversation id that differs from the minted one is logged (tools would be WRONG_BET)', async () => {
    const t = setup();
    await t.started();
    t.connected('conv_other');
    expect(t.logs).toContain('voice.conversation_id_mismatch');
  });
});

describe('judge session: [EVENT] cues (§4.5)', () => {
  it('ruling / redo / payout lines go to sendUserMessage verbatim; ATTEMPT_ARMED is context', async () => {
    const t = setup();
    await t.started();
    t.connected();
    for (const c of ['RULING', 'REDO', 'PAID', 'LOCKED', 'AUTHORIZED']) t.s.onCue(cue(c));
    t.s.onCue(cue('ATTEMPT_ARMED', false));
    expect(t.conv.sent()).toEqual([
      ['sendUserMessage', '[EVENT] RULING x=1 :: Do the thing.'],
      ['sendUserMessage', '[EVENT] REDO x=1 :: Do the thing.'],
      ['sendUserMessage', '[EVENT] PAID x=1 :: Do the thing.'],
      ['sendUserMessage', '[EVENT] LOCKED x=1 :: Do the thing.'],
      ['sendUserMessage', '[EVENT] AUTHORIZED x=1 :: Do the thing.'],
      ['sendContextualUpdate', '[EVENT] ATTEMPT_ARMED x=1 :: Do the thing.'],
    ]);
  });

  it('cues before the session connects are queued (never thrown into the hub) and flushed in order', async () => {
    const t = setup();
    await t.started();
    expect(() => t.s.onCue(cue('AUTHORIZED'))).not.toThrow();
    expect(() => t.s.onCue(cue('LOCKED'))).not.toThrow();
    t.connected();
    expect(t.conv.sent()).toEqual([
      ['sendUserMessage', '[EVENT] AUTHORIZED x=1 :: Do the thing.'],
      ['sendUserMessage', '[EVENT] LOCKED x=1 :: Do the thing.'],
    ]);
    // after a failure cues are dropped quietly
    const u = setup({ token: 'fail' });
    await u.started();
    expect(() => u.s.onCue(cue('RULING'))).not.toThrow();
    expect(u.conv.sent()).toEqual([]);
  });

  it('request_attempt is allowed after LOCKED / REDO, not after ATTEMPT_ARMED (§4.4)', async () => {
    const t = setup();
    await t.started();
    t.connected();
    expect(t.s.canAttempt()).toBe(false);
    t.s.onCue(cue('LOCKED'));
    expect(t.s.canAttempt()).toBe(true);
    t.s.onCue(cue('ATTEMPT_ARMED', false));
    expect(t.s.canAttempt()).toBe(false);
    t.s.onCue(cue('REDO'));
    expect(t.s.canAttempt()).toBe(true);
  });
});

describe('judge session: mute, do not end (FINDINGS §4) + user activity', () => {
  it('muted from the terms card to the ruling, one continuous span', () => {
    expect(micMutedFor('DRAFTING')).toBe(false);
    expect(micMutedFor('TERMS_PROPOSED')).toBe(false);
    for (const s of [
      'AWAITING_AUTHORIZATIONS',
      'AWAITING_LOCK',
      'LOCKED',
      'ATTEMPT',
      'JUDGING',
    ] as const)
      expect([s, micMutedFor(s)]).toEqual([s, true]);
    for (const s of ['RULED', 'HEARING', 'APPEALED', 'CONCEDED'] as const)
      expect([s, micMutedFor(s)]).toEqual([s, false]);
    // The session lingers after the bet ends only to speak the closing [EVENT] line.
    for (const s of ['PAID', 'VOIDED', 'CANCELLED', 'EXPIRED'] as const)
      expect([s, micMutedFor(s)]).toEqual([s, true]);
    expect(micMutedFor(null)).toBe(false);
  });

  it('mutes (never ends) the live session and pings sendUserActivity every 10 s while muted', async () => {
    const t = setup();
    await t.started();
    t.s.setMuted(true); // before connect: applied on connect, not thrown
    t.connected();
    expect(t.conv.calls).toContainEqual(['setMuted', true]);
    const pings = () => t.conv.calls.filter(([n]) => n === 'sendUserActivity').length;
    await vi.advanceTimersByTimeAsync(ACTIVITY_EVERY_MS * 3);
    expect(pings()).toBe(3);
    t.s.setMuted(false);
    expect(t.conv.calls.at(-1)).toEqual(['setMuted', false]);
    await vi.advanceTimersByTimeAsync(ACTIVITY_EVERY_MS * 3);
    expect(pings()).toBe(3);
    expect(t.conv.calls.map(([n]) => n)).not.toContain('endSession');
  });
});

describe('judge session: captions + transcript relay', () => {
  it('judge and party lines -> captions (server ids) and one batched POST; our [EVENT] text is skipped', async () => {
    const t = setup();
    await t.started();
    t.connected();
    t.s.onMessage({ role: 'agent', message: "Order. Logan, Jake: what's the bet?", event_id: 1 });
    t.s.onMessage({ role: 'user', message: 'Bet you cannot flip it.', event_id: 1 });
    t.s.onMessage({ role: 'user', message: '[EVENT] LOCKED pot=$10 :: Announce it.', event_id: 2 });
    t.s.onMessage({ role: 'user', message: '   ', event_id: 3 });
    expect(t.captions.map((c) => [c.who, c.text])).toEqual([
      ['judge', "Order. Logan, Jake: what's the bet?"],
      ['a', 'Bet you cannot flip it.'],
    ]);
    // Same event id, different speakers: different ids (both valid UUIDv4 for the server).
    const [j, p] = t.captions;
    expect(j!.id).not.toBe(p!.id);
    expect(Uuid.safeParse(j!.id).success && Uuid.safeParse(p!.id).success).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(t.posted).toEqual([
      [
        {
          utterance_id: j!.id,
          role: 'judge',
          text: "Order. Logan, Jake: what's the bet?",
          final: true,
          at: '2026-11-21T18:00:00.000Z',
        },
        {
          utterance_id: p!.id,
          role: 'party',
          party: 'A',
          text: 'Bet you cannot flip it.',
          final: true,
          at: '2026-11-21T18:00:00.000Z',
        },
      ],
    ]);
  });

  it('utteranceId is deterministic and UUIDv4-shaped; isEventLine', () => {
    expect(utteranceId(BET, 'judge', 7)).toBe('7f3c2a9e-4b1d-4e8a-8c2f-000000000007');
    expect(utteranceId(BET, 'party', 7)).toBe('7f3c2a9e-4b1d-4e8a-9c2f-000000000007');
    expect(utteranceId(BET, 'judge', 7)).toBe(utteranceId(BET, 'judge', 7));
    expect(Uuid.safeParse(utteranceId(BET, 'judge', 2 ** 50)).success).toBe(true);
    expect(isEventLine('[EVENT] PAID winner=Jake :: x')).toBe(true);
    expect(isEventLine('  [event] x')).toBe(true);
    expect(isEventLine('Event over.')).toBe(false);
  });
});
