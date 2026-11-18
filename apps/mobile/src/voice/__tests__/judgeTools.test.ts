import { CLIENT_TOOLS } from '@youre-on/shared/judge/el-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCueOutbox,
  createLineBatcher,
  CUE_QUEUE_MAX,
  cueAction,
  judgeClientTools,
  type CueSink,
  type VoiceLine,
} from '../judgeTools';

describe('judge client tools (API-CONTRACT §4.4)', () => {
  const make = (
    o: {
      can?: boolean;
      fail?: string;
      details?: Record<string, unknown>;
      recorder?: 'judge_cam' | 'self';
    } = {},
  ) => {
    const calls: unknown[] = [];
    const tools = judgeClientTools({
      startAttempt: async (n) => {
        calls.push(['attempt', n]);
        if (o.fail) throw Object.assign(new Error(o.fail), { code: o.fail, details: o.details });
        return o.recorder;
      },
      showTermsCard: () => calls.push(['card']),
      cue: async (k) => void calls.push(['cue', k]),
      canAttempt: () => o.can ?? true,
    });
    return { tools, calls };
  };

  it('implements every client tool the agent registers', () => {
    expect(Object.keys(make().tools).sort()).toEqual([...CLIENT_TOOLS].sort());
  });

  it('request_attempt arms the camera, or reports the error code', async () => {
    expect(await make().tools.request_attempt({ attempt_no: 1 })).toBe(
      'armed: judge cam counting down',
    );
    expect(await make({ fail: 'INVALID_STATE' }).tools.request_attempt({ attempt_no: 2 })).toBe(
      'error: INVALID_STATE',
    );
    expect(await make().tools.request_attempt({ attempt_no: 0 })).toBe('error: VALIDATION_FAILED');
    // Two phones: A's own phone films (no judge cam in the room).
    expect(await make({ recorder: 'self' }).tools.request_attempt({ attempt_no: 1 })).toBe(
      'armed: this phone films, counting down',
    );
    expect(await make({ recorder: 'judge_cam' }).tools.request_attempt({ attempt_no: 1 })).toBe(
      'armed: judge cam counting down',
    );
    // A performs and there is no judge cam: B's phone has to start it.
    expect(
      await make({
        fail: 'INVALID_STATE',
        details: { reason: 'no_judge_cam' },
      }).tools.request_attempt({ attempt_no: 1 }),
    ).toBe('error: NO_JUDGE_CAM');
    // Only after [EVENT] LOCKED / REDO.
    const early = make({ can: false });
    expect(await early.tools.request_attempt({ attempt_no: 1 })).toBe('error: INVALID_STATE');
    expect(early.calls).toEqual([]);
  });

  it('cue forwards only the four kinds; show_terms_card brings the card forward', () => {
    const m = make();
    m.tools.cue({ kind: 'gavel' });
    m.tools.cue({ kind: 'airhorn' });
    m.tools.show_terms_card();
    expect(m.calls).toEqual([['cue', 'gavel'], ['card']]);
  });

  it('judge.cue: speak -> user message, else contextual update (verbatim)', () => {
    expect(cueAction({ cue: 'LOCKED', text: '[EVENT] LOCKED pot=$10 :: x', speak: true })).toEqual({
      send: 'user',
      text: '[EVENT] LOCKED pot=$10 :: x',
    });
    expect(cueAction({ cue: 'ATTEMPT_ARMED', text: 't', speak: false }).send).toBe('context');
  });
});

describe('transcript batcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const line = (i: number): VoiceLine => ({
    utterance_id: String(i),
    role: 'judge',
    text: `l${i}`,
    final: true,
    at: '2026-11-21T18:00:00.000Z',
  });

  it('flushes at most every 250 ms, in order', () => {
    const posts: VoiceLine[][] = [];
    const b = createLineBatcher(async (l) => void posts.push(l));
    b.add(line(1));
    b.add(line(2));
    vi.advanceTimersByTime(249);
    expect(posts).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(posts.map((p) => p.map((l) => l.utterance_id))).toEqual([['1', '2']]);
    b.add(line(3));
    b.flush();
    expect(posts).toHaveLength(2);
  });
});

describe('cue outbox (the voice session may not be there)', () => {
  /** A stand-in for the SDK controls: throws like it does while there is no conversation. */
  function fakeSession() {
    const sent: string[] = [];
    let live = false;
    const sink: CueSink = {
      sendUserMessage(t) {
        if (!live) throw new Error('No active conversation. Call startSession() first.');
        sent.push(`user:${t}`);
      },
      sendContextualUpdate(t) {
        if (!live) throw new Error('No active conversation. Call startSession() first.');
        sent.push(`context:${t}`);
      },
    };
    return { sink, sent, connect: () => (live = true), drop: () => (live = false) };
  }

  it('sends straight through a live session', () => {
    const s = fakeSession();
    s.connect();
    const o = createCueOutbox(() => s.sink);
    o.push({ send: 'user', text: '[EVENT] LOCKED' });
    o.push({ send: 'context', text: '[EVENT] ATTEMPT_ARMED' });
    expect(s.sent).toEqual(['user:[EVENT] LOCKED', 'context:[EVENT] ATTEMPT_ARMED']);
    expect(o.pending).toBe(0);
  });

  it('never throws without a session (the crash: token refused, then B declined)', () => {
    const s = fakeSession();
    const logs: string[] = [];
    const o = createCueOutbox(
      () => s.sink,
      (m) => logs.push(m),
    );
    expect(() => o.push({ send: 'user', text: '[EVENT] DECLINED' })).not.toThrow();
    expect(s.sent).toEqual([]);
    expect(o.pending).toBe(1);
    expect(logs).toEqual(['voice.cue_deferred']);
  });

  it('holds cues until the session connects, then sends them in order', () => {
    const s = fakeSession();
    const o = createCueOutbox(() => s.sink);
    o.push({ send: 'context', text: 'a' });
    o.push({ send: 'user', text: 'b' });
    o.flush(); // still not connected: nothing lost
    expect(o.pending).toBe(2);
    s.connect();
    o.flush();
    expect(s.sent).toEqual(['context:a', 'user:b']);
    expect(o.pending).toBe(0);
  });

  it('keeps the order: a new cue waits behind older ones', () => {
    const s = fakeSession();
    const o = createCueOutbox(() => s.sink);
    o.push({ send: 'user', text: 'first' });
    s.connect();
    o.push({ send: 'user', text: 'second' });
    expect(s.sent).toEqual([]);
    o.flush();
    expect(s.sent).toEqual(['user:first', 'user:second']);
  });

  it('keeps only the newest CUE_QUEUE_MAX while disconnected', () => {
    const s = fakeSession();
    const o = createCueOutbox(() => s.sink);
    for (let i = 0; i < CUE_QUEUE_MAX + 3; i++) o.push({ send: 'context', text: String(i) });
    expect(o.pending).toBe(CUE_QUEUE_MAX);
    s.connect();
    o.flush();
    expect(s.sent[0]).toBe('context:3');
    expect(s.sent).toHaveLength(CUE_QUEUE_MAX);
  });

  it('a session that drops mid-flush keeps the rest for the next connect', () => {
    const s = fakeSession();
    let n = 0;
    const o = createCueOutbox(() => {
      if (++n === 3) s.drop();
      return s.sink;
    });
    o.push({ send: 'user', text: 'x' }); // n=1, not live: queued
    o.push({ send: 'user', text: 'y' });
    s.connect();
    o.flush(); // n=2 sends x; n=3 drops before y
    expect(s.sent).toEqual(['user:x']);
    expect(o.pending).toBe(1);
  });
});
