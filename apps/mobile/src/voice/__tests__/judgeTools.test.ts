import { CLIENT_TOOLS } from '@youre-on/shared/judge/el-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLineBatcher, cueAction, judgeClientTools, type VoiceLine } from '../judgeTools';

describe('judge client tools (API-CONTRACT §4.4)', () => {
  const make = (o: { can?: boolean; fail?: string } = {}) => {
    const calls: unknown[] = [];
    const tools = judgeClientTools({
      startAttempt: async (n) => {
        calls.push(['attempt', n]);
        if (o.fail) throw Object.assign(new Error(o.fail), { code: o.fail });
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
