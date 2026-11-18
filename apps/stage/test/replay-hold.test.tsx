// The REPLAY clips (~30 MB each) must not compete with a live beat on the pitch-day hotspot: the
// background download holds while a live bet is in progress, a clip in flight is aborted and
// fetched again afterwards, and the status strip / connect form show the progress.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { previewAt } from '../src/preview';
import {
  initialReplays,
  LIVE_IDLE_MS,
  liveBetInProgress,
  preloadReplays,
  replayProgress,
  replayUrl,
  type ClipState,
  type ReplayStatus,
} from '../src/replays';
import { emptyBet, type BetView } from '../src/ticker';
import { HealthStrip } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** Waits (up to 2 s) until `cond` holds: no fixed sleeps that a busy machine could outrun. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 400 && !cond(); i++) await tick(5);
  expect(cond()).toBe(true);
}
const video = () =>
  new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } });

function recorder() {
  let s = initialReplays();
  const states: Array<[number, ClipState]> = [];
  return {
    get s(): ReplayStatus {
      return s;
    },
    states,
    onChange: (beat: number, state: ClipState, url?: string) => {
      states.push([beat, state]);
      s = { clips: { ...s.clips, [beat]: state }, urls: url ? { ...s.urls, [beat]: url } : s.urls };
    },
  };
}

describe('the REPLAY download holds for a live bet', () => {
  it('nothing is fetched while paused; it starts when the beat is over', async () => {
    let paused = true;
    const fetched: string[] = [];
    const r = recorder();
    const run = preloadReplays({
      fetch: async (u) => {
        fetched.push(u);
        return video();
      },
      createObjectURL: () => 'blob:x',
      cancelled: () => false,
      paused: () => paused,
      onChange: r.onChange,
      pollMs: 2,
    });
    await tick(20);
    expect(fetched).toEqual([]);
    expect(r.s.clips[1]).toBe('paused');
    expect(replayProgress(r.s).state).toBe('paused');
    paused = false;
    await run;
    expect(fetched).toEqual([1, 2, 3, 4, 5, 6].map((b) => replayUrl(b)));
    expect(replayProgress(r.s)).toEqual({ ready: 6, present: 6, state: 'done' });
  });

  it('a pause mid-download aborts that clip; it is fetched again afterwards', async () => {
    let paused = false;
    const calls: Record<string, number> = {};
    let aborted = 0;
    const r = recorder();
    const run = preloadReplays({
      fetch: (u, init) => {
        calls[u] = (calls[u] ?? 0) + 1;
        if (u.endsWith('beat2.mp4') && calls[u] === 1)
          // a slow 30 MB clip: only the abort ends it
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => {
              aborted++;
              reject(new DOMException('aborted', 'AbortError'));
            }),
          );
        return Promise.resolve(video());
      },
      createObjectURL: () => 'blob:x',
      cancelled: () => false,
      paused: () => paused,
      onChange: r.onChange,
      pollMs: 2,
    });
    await until(() => r.s.clips[2] === 'loading');
    paused = true; // the lock starts
    await until(() => aborted === 1 && r.s.clips[2] === 'paused');
    paused = false; // paid
    await run;
    expect(calls[replayUrl(2)]).toBe(2);
    expect(r.s.clips[2]).toBe('ready');
    expect(r.states.filter(([b, st]) => b === 2 && st === 'error')).toEqual([]);
  });

  it('the page going away mid-download stops it too', async () => {
    let gone = false;
    let aborted = false;
    const run = preloadReplays({
      fetch: (_u, init) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          }),
        ),
      createObjectURL: () => 'blob:x',
      cancelled: () => gone,
      onChange: () => {},
      pollMs: 2,
    });
    await tick(5);
    gone = true;
    await run; // returns only once the abort lands
    expect(aborted).toBe(true);
  });
});

describe('liveBetInProgress', () => {
  it('a focused bet that is not over and had activity in the last 3 minutes', () => {
    const now = START + 1_000_000;
    const live = { ...emptyBet(BET, now - 10_000), state: 'LOCKED' };
    const s = (b: BetView | null) => ({
      bets: (b ? { [BET]: b } : {}) as Record<string, BetView>,
      focusBetId: b ? BET : null,
    });
    expect(liveBetInProgress(s(null), now)).toBe(false);
    expect(liveBetInProgress(s(live), now)).toBe(true);
    expect(liveBetInProgress(s({ ...live, state: 'PAID' }), now)).toBe(false);
    expect(liveBetInProgress(s({ ...live, state: 'EXPIRED' }), now)).toBe(false);
    expect(liveBetInProgress(s({ ...live, updated_at: now - LIVE_IDLE_MS - 1 }), now)).toBe(false); // a stuck rehearsal bet no longer holds the clips
  });

  it('over the preview: held during the flip, free once it is paid', () => {
    const at = (t: number) => {
      const f = previewAt(START, START + t);
      return liveBetInProgress(f.state, f.now);
    };
    expect(at(15_000)).toBe(true); // the lock
    expect(at(36_000)).toBe(true); // judging
    expect(at(52_000)).toBe(false); // paid and closed
  });
});

describe('progress on screen', () => {
  const status = (clips: Record<number, ClipState>): ReplayStatus => ({
    clips: { ...initialReplays().clips, ...clips },
    urls: {},
  });

  it('the status strip says loading / paused (live bet) / cached', () => {
    const strip = (s: ReplayStatus) =>
      renderToString(<HealthStrip health={null} error={null} replays={s} status="open" />).replace(
        /<!-- -->/g,
        '',
      );
    expect(strip(status({ 1: 'ready', 2: 'loading' }))).toContain('1/6 cached · loading');
    expect(strip(status({ 1: 'ready', 2: 'paused' }))).toContain('1/6 cached · paused (live bet)');
    const all = status({
      1: 'ready',
      2: 'ready',
      3: 'ready',
      4: 'ready',
      5: 'ready',
      6: 'missing',
    });
    expect(strip(all)).toContain('5/5 cached');
    expect(strip(all)).toContain('hi ok');
    expect(replayProgress(initialReplays()).state).toBe('idle');
  });
});
