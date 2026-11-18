import { Uuid } from '@youre-on/shared/primitives';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceLine } from '../judgeTools';
import { BetState } from '@youre-on/shared/bet-state';

import {
  ACTIVITY_EVERY_MS,
  CONNECT_TIMEOUT_MS,
  createJudgeSession,
  isEventLine,
  micMutedFor,
  MINT_RETRY_MS,
  utteranceId,
  utteranceKey,
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

/** An ApiClientError-shaped rejection (net/signedFetch): the server's code and retryable flag. */
const apiError = (code: string, retryable: boolean, details?: Record<string, unknown>) =>
  Object.assign(new Error(code), { code, retryable, details });
const TOKEN = { conversation_token: 'lk_tok', conversation_id: 'conv_1' };

function setup(
  o: {
    token?: 'ok' | 'fail';
    /** Results of successive mintToken calls (an Error rejects); overrides `token`. */
    mints?: Array<typeof TOKEN | Error>;
    mic?: () => Promise<boolean>;
  } = {},
) {
  const conv = mockConversation();
  const failed: FailReason[] = [];
  const captions: Caption[] = [];
  const posted: VoiceLine[][] = [];
  const logs: string[] = [];
  let mints = 0;
  const s = createJudgeSession({
    betId: BET,
    conv: () => conv.port,
    ...(o.mic ? { micPermission: o.mic } : {}),
    mintToken: () => {
      mints += 1;
      if (o.mints) {
        const r = o.mints[Math.min(mints, o.mints.length) - 1]!;
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      }
      return o.token === 'fail'
        ? Promise.reject(apiError('UPSTREAM_ERROR', false, { reason: 'not_configured' }))
        : Promise.resolve(TOKEN);
    },
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
  return { s, conv, failed, captions, posted, logs, started, connected, mints: () => mints };
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

  it('a retryable token failure (504 UPSTREAM_TIMEOUT, a 502 blip, NETWORK) is retried once after 1 s', async () => {
    for (const err of [
      apiError('UPSTREAM_TIMEOUT', true),
      apiError('UPSTREAM_ERROR', true, { upstream_status: 502 }),
      apiError('NETWORK', true),
    ]) {
      const t = setup({ mints: [err, TOKEN] });
      await t.started();
      expect([t.mints(), t.s.phase()]).toEqual([1, 'minting']);
      await vi.advanceTimersByTimeAsync(MINT_RETRY_MS);
      expect(t.mints()).toBe(2);
      expect(t.conv.calls[0]).toEqual([
        'startSession',
        { conversationToken: 'lk_tok', dynamicVariables: VARS },
      ]);
      expect(t.failed).toEqual([]);
      expect(t.logs).toContain('voice.token_retry');
    }
    // Twice in a row: typed terms, after exactly one retry.
    const u = setup({ mints: [apiError('UPSTREAM_TIMEOUT', true)] });
    await u.started();
    await vi.advanceTimersByTimeAsync(MINT_RETRY_MS * 5);
    expect([u.mints(), u.failed]).toEqual([2, ['token']]);
  });

  it('a non-retryable token failure (no key, spend off, bet over) fails at once, no retry', async () => {
    for (const err of [
      apiError('UPSTREAM_ERROR', false, { reason: 'not_configured' }),
      apiError('UPSTREAM_ERROR', false, { reason: 'spend_disabled' }),
      apiError('INVALID_STATE', false),
    ]) {
      const t = setup({ mints: [err, TOKEN] });
      await t.started();
      expect([t.mints(), t.failed]).toEqual([1, ['token']]);
      await vi.advanceTimersByTimeAsync(MINT_RETRY_MS * 2);
      expect(t.mints()).toBe(1);
    }
    // stop() while waiting to retry: no second mint, no fallback.
    const u = setup({ mints: [apiError('UPSTREAM_TIMEOUT', true), TOKEN] });
    await u.started();
    u.s.stop();
    await vi.advanceTimersByTimeAsync(MINT_RETRY_MS * 2);
    expect([u.mints(), u.failed, u.conv.calls.filter(([n]) => n === 'startSession')]).toEqual([
      1,
      [],
      [],
    ]);
  });

  it('the mic prompt comes before the mint and is not on the connect clock; denied -> "mic"', async () => {
    let answer!: (granted: boolean) => void;
    const t = setup({ mic: () => new Promise<boolean>((r) => (answer = r)) });
    await t.started();
    // A fresh install: the iOS prompt sits there for longer than the connect timeout.
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS * 2);
    expect([t.mints(), t.failed, t.s.phase()]).toEqual([0, [], 'minting']);
    answer(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.mints()).toBe(1);
    expect(t.s.phase()).toBe('connecting');
    t.connected();
    expect(t.failed).toEqual([]);

    const u = setup({ mic: async () => false });
    await u.started();
    expect([u.mints(), u.failed]).toEqual([0, ['mic']]);
    // Unknown (the module threw): logged, and LiveKit asks at connect as before.
    const w = setup({
      mic: async () => {
        throw new Error('expo-audio missing');
      },
    });
    await w.started();
    expect([w.mints(), w.failed, w.s.phase()]).toEqual([1, [], 'connecting']);
    expect(w.logs).toContain('voice.mic_permission_unknown');
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

  it('B taps accept after the judge was told to wait: INVITE_ACCEPTED starts a judge turn', async () => {
    const t = setup();
    await t.started();
    t.connected();
    const line =
      '[EVENT] INVITE_ACCEPTED name=Jake :: Say Jake is in, then call confirm_terms again.';
    t.s.onCue({ cue: 'INVITE_ACCEPTED', text: line, speak: true });
    // A user message (a contextual update would not make the judge speak or call the tool).
    expect(t.conv.sent()).toEqual([['sendUserMessage', line]]);
    // Our own [EVENT] text coming back as a user transcript is never captioned or relayed.
    t.s.onMessage({ role: 'user', message: line, event_id: 9 });
    expect(t.captions).toEqual([]);
    expect(t.s.canAttempt()).toBe(false);
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
  it('live only while negotiating or in a hearing; muted from the terms card on', () => {
    expect(micMutedFor('DRAFTING')).toBe(false);
    expect(micMutedFor('TERMS_PROPOSED')).toBe(false);
    // A hearing: the parties argue out loud to the judge.
    expect(micMutedFor('HEARING')).toBe(false);
    for (const s of [
      'AWAITING_AUTHORIZATIONS',
      'AWAITING_LOCK',
      'LOCKED',
      'ATTEMPT',
      'JUDGING',
      // Beat 6: five minutes on speaker during the pitch; the judge must not answer it.
      'AWAITING_MARKET',
      // The ruling and its appeal / GG window: they tap, no spoken tool (no file_appeal).
      'RULED',
      'CONCEDED',
      'FINALIZED',
      'APPEALED',
      'APPEAL_RESOLVED',
      // The session lingers after the bet ends only to speak the closing [EVENT] line.
      'PAID',
      'VOIDED',
      'CANCELLED',
      'EXPIRED',
    ] as const)
      expect([s, micMutedFor(s)]).toEqual([s, true]);
    expect(micMutedFor(null)).toBe(false);
    // Every state is decided (a state added later starts muted).
    expect(BetState.options.filter((s) => !micMutedFor(s))).toEqual([
      'DRAFTING',
      'TERMS_PROPOSED',
      'HEARING',
    ]);
  });

  it('a skill bet is one mute span from the card to the payout: no toggle at the ruling', () => {
    const path = [
      'TERMS_PROPOSED',
      'AWAITING_AUTHORIZATIONS',
      'AWAITING_LOCK',
      'LOCKED',
      'ATTEMPT',
      'JUDGING',
      'RULED',
      'FINALIZED',
      'PAID',
    ] as const;
    const toggles = path.slice(1).filter((s, k) => micMutedFor(s) !== micMutedFor(path[k]!));
    expect(toggles).toEqual(['AWAITING_AUTHORIZATIONS']);
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

  it('two agent responses in one turn (pre-tool speech, then the read-back) are two lines', async () => {
    const t = setup();
    await t.started();
    t.connected();
    // The SDK's event_id is the turn counter; response_id tells the responses apart.
    t.s.onMessage({
      role: 'agent',
      message: 'Bold. Writing that down.',
      event_id: 4,
      response_id: 'resp_a',
    });
    t.s.onMessage({
      role: 'agent',
      message: 'Jake lands a water bottle flip upright. Five dollars each.',
      event_id: 4,
      response_id: 'resp_b',
    });
    // A resend of the first response keeps its id (voice/lines is idempotent on it).
    t.s.onMessage({
      role: 'agent',
      message: 'Bold. Writing that down.',
      event_id: 4,
      response_id: 'resp_a',
    });
    const ids = t.captions.map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[2]).toBe(ids[0]);
    // An older SDK without response_id: the text separates them, a resend still matches.
    const u = setup();
    await u.started();
    u.connected();
    u.s.onMessage({ role: 'agent', message: 'Bold. Writing that down.', event_id: 4 });
    u.s.onMessage({ role: 'agent', message: 'Five dollars each.', event_id: 4 });
    u.s.onMessage({ role: 'agent', message: 'Bold. Writing that down.', event_id: 4 });
    const uids = u.captions.map((c) => c.id);
    expect([new Set(uids).size, uids[2] === uids[0]]).toEqual([2, true]);
    await vi.advanceTimersByTimeAsync(250);
    expect(new Set(u.posted.flat().map((l) => l.utterance_id)).size).toBe(2);
  });

  it('utteranceId is deterministic and UUIDv4-shaped; utteranceKey; isEventLine', () => {
    const k = utteranceKey({ response_id: 'resp_1', event_id: 7, text: 'Hi.', at: 0 });
    expect(k).toBe('r:resp_1');
    expect(utteranceKey({ event_id: 7, text: 'Hi.', at: 0 })).toBe('e:7:Hi.');
    expect(utteranceKey({ text: 'Hi.', at: 1700 })).toBe('e:1700:Hi.');
    expect(utteranceId(BET, 'judge', k)).toMatch(/^7f3c2a9e-4b1d-4e8a-8c2f-[0-9a-f]{12}$/);
    expect(utteranceId(BET, 'party', k)).toMatch(/^7f3c2a9e-4b1d-4e8a-9c2f-[0-9a-f]{12}$/);
    expect(utteranceId(BET, 'judge', k)).toBe(utteranceId(BET, 'judge', k));
    expect(utteranceId(BET, 'judge', k)).not.toBe(utteranceId(BET, 'judge', 'r:resp_2'));
    expect(Uuid.safeParse(utteranceId(BET, 'judge', k)).success).toBe(true);
    expect(isEventLine('[EVENT] PAID winner=Jake :: x')).toBe(true);
    expect(isEventLine('  [event] x')).toBe(true);
    expect(isEventLine('Event over.')).toBe(false);
  });
});
