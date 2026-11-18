// Stage sound: which moments make a sound (fresh ones only, once each), and that every sound
// schedules on a WebAudio graph without throwing (a fake AudioContext records the calls).
import { describe, expect, it } from 'vitest';
import { FRESH_MS, freshSounds, isSfx, SFX, StageAudio, synth } from '../src/sound';
import { LOOP_MS, previewAt, PREVIEW_STEPS } from '../src/preview';

const START = Date.parse('2026-11-20T15:00:00.000Z');

describe('which moments sound', () => {
  it('the preview sequence, heard live: lock, redo, gavel, paid, in that order, once each', () => {
    const seen = new Set<string>();
    const heard: string[] = [];
    for (let t = 0; t < 56_000; t += 250) {
      const f = previewAt(START, START + t);
      for (const id of Object.keys(f.state.bets))
        heard.push(...freshSounds(f.state, id, seen, f.now));
    }
    expect(heard).toEqual(['lock', 'redo', 'gavel', 'paid']);
  });

  it('a stage that connects late (seq-0 replay of old events) stays silent', () => {
    const f = previewAt(START, START, 'paid');
    const seen = new Set<string>();
    const late = f.now + 60_000;
    expect(freshSounds(f.state, f.state.focusBetId!, seen, late)).toEqual([]);
    expect(seen.size).toBe(4); // lock, two rulings, paid: marked so they never sound later
    expect(freshSounds(f.state, f.state.focusBetId!, seen, f.now)).toEqual([]);
  });

  it('the Gemini bet: lock, gavel (settlement), paid', () => {
    const seen = new Set<string>();
    const heard: string[] = [];
    // from 66 s: the flip's payout (49.6 s) is older than FRESH_MS, the BTC lock (67 s) is next
    for (let t = 66_000; t < LOOP_MS; t += 500) {
      const f = previewAt(START, START + t);
      for (const id of Object.keys(f.state.bets))
        heard.push(...freshSounds(f.state, id, seen, f.now));
    }
    expect(heard).toEqual(['lock', 'gavel', 'paid']);
    expect(66_000 - 49_600).toBeGreaterThan(FRESH_MS);
    expect(PREVIEW_STEPS.market).toBeGreaterThan(66_000);
  });

  it('stage cue names are sounds', () => {
    for (const k of ['gavel', 'drumroll', 'buzzer', 'cheer']) expect(isSfx(k)).toBe(true);
    expect(isSfx('kazoo')).toBe(false);
  });
});

/** Enough of AudioContext to schedule nodes, counting what was started. */
function fakeCtx(state: 'suspended' | 'running' = 'suspended') {
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  const node = () => ({ connect() {}, start() {}, stop() {} });
  let started = 0;
  const ctx = {
    state,
    currentTime: 1,
    sampleRate: 8000,
    destination: {},
    resumed: 0,
    async resume() {
      ctx.resumed++;
      ctx.state = 'running';
    },
    createOscillator: () => ({
      ...node(),
      type: 'sine',
      frequency: param(),
      start: () => void started++,
    }),
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: 'lowpass', frequency: param(), Q: param() }),
    createBuffer: (_c: number, len: number) => {
      const data = new Float32Array(len);
      return { getChannelData: () => data };
    },
    createBufferSource: () => ({ ...node(), buffer: null, start: () => void started++ }),
    get started() {
      return started;
    },
  };
  return ctx;
}

describe('synthesis', () => {
  it('every sound schedules sources on the graph', () => {
    for (const kind of SFX) {
      const ctx = fakeCtx('running');
      synth(ctx as never, kind);
      expect(ctx.started, kind).toBeGreaterThan(0);
    }
  });

  it('StageAudio: silent until unlocked by a gesture; mute; no WebAudio is fine', async () => {
    const ctx = fakeCtx();
    const a = new StageAudio(() => ctx as never);
    expect(a.play('gavel')).toBe(false); // no context yet
    a.unlock();
    await Promise.resolve();
    expect(ctx.resumed).toBe(1);
    expect(a.ready).toBe(true);
    expect(a.play('gavel')).toBe(true);
    a.muted = true;
    expect(a.play('gavel')).toBe(false);
    const none = new StageAudio(() => null);
    none.unlock();
    expect(none.play('paid')).toBe(false);
    const broken = new StageAudio(() => {
      throw new Error('no audio');
    });
    expect(() => broken.unlock()).not.toThrow();
  });
});
