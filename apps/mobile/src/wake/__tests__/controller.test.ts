import { describe, expect, it } from 'vitest';

import {
  createWakeController,
  type NativeStateEvent,
  type NativeWakeState,
  type Subscription,
  type WakeClock,
  type WakeNative,
  type WakePermissions,
  type WakeStartOptions,
  type WakeStartResult,
  type WakeStatus,
} from '../controller';
import type { TranscriptInput } from '../detector';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

class FakeNative implements WakeNative {
  perms: WakePermissions = { speech: 'granted', mic: 'granted' };
  startResult: WakeStartResult = { ok: true, onDevice: true };
  startGate: Promise<void> | null = null;
  stopGate: Promise<void> | null = null;
  readonly log: string[] = [];
  readonly starts: WakeStartOptions[] = [];
  private readonly transcripts = new Set<(e: TranscriptInput) => void>();
  private readonly states = new Set<(e: NativeStateEvent) => void>();

  async requestPermissions(): Promise<WakePermissions> {
    this.log.push('perm');
    return this.perms;
  }
  async start(options: WakeStartOptions): Promise<WakeStartResult> {
    this.log.push('start');
    this.starts.push(options);
    if (this.startGate) await this.startGate;
    return this.startResult;
  }
  async stop(): Promise<void> {
    this.log.push('stop');
    if (this.stopGate) await this.stopGate;
    this.log.push('stopped');
  }
  addTranscriptListener(fn: (e: TranscriptInput) => void): Subscription {
    this.transcripts.add(fn);
    return { remove: () => void this.transcripts.delete(fn) };
  }
  addStateListener(fn: (e: NativeStateEvent) => void): Subscription {
    this.states.add(fn);
    return { remove: () => void this.states.delete(fn) };
  }
  say(text: string, segment = 0, isFinal = false) {
    for (const f of [...this.transcripts]) f({ text, isFinal, segment });
  }
  state(state: NativeWakeState, message?: string) {
    for (const f of [...this.states]) f(message === undefined ? { state } : { state, message });
  }
  get listeners() {
    return this.transcripts.size + this.states.size;
  }
  count(entry: string) {
    return this.log.filter((l) => l === entry).length;
  }
}

function setup(load: () => Promise<WakeNative | null>, n: FakeNative | null) {
  let now = 0;
  let nextId = 0;
  const intervals = new Map<number, () => void>();
  const clock: WakeClock = {
    now: () => now,
    setInterval: (fn) => {
      nextId++;
      intervals.set(nextId, fn);
      return nextId;
    },
    clearInterval: (h) => void intervals.delete(h as number),
  };
  const events: string[] = [];
  const statuses: WakeStatus[] = [];
  const c = createWakeController({
    load,
    clock,
    callbacks: {
      onWake: () => events.push('wake'),
      onUtterance: (text) => {
        events.push(`utterance:${text}`);
        n?.log.push('utterance');
      },
      onCancel: () => events.push('cancel'),
      onError: (m) => events.push(`error:${m}`),
      onStatus: (s) => statuses.push(s),
      onAvailable: (a) => events.push(`available:${a}`),
    },
  });
  /** Moves the clock and runs one detector tick at the new time. */
  const advance = (ms: number) => {
    now += ms;
    for (const fn of [...intervals.values()]) fn();
  };
  return { c, events, statuses, advance, intervals };
}

const withNative = (n = new FakeNative()) => ({ n, ...setup(async () => n, n) });

/** Enabled and listening. */
async function listening(n = new FakeNative()) {
  const s = withNative(n);
  s.c.setEnabled(true);
  await flush();
  expect(s.c.status).toBe('listening');
  return s;
}

describe('wake controller', () => {
  it('loads at once, but starts nothing until enabled', async () => {
    const { n, c, events } = withNative();
    await flush();
    expect(events).toEqual(['available:true']);
    expect(c.available).toBe(true);
    expect(n.log).toEqual([]);
    expect(c.status).toBe('off');
  });

  it('asks for permissions, then starts on device with the wake word as a hint', async () => {
    const { n, statuses, intervals } = await listening();
    expect(n.log).toEqual(['perm', 'start']);
    expect(n.starts).toEqual([{ locale: 'en-US', contextualStrings: ['Jarvis'], onDevice: true }]);
    expect(statuses).toEqual(['listening']);
    expect(intervals.size).toBe(1);
  });

  it('never double-starts on quick toggles', async () => {
    const n = new FakeNative();
    const g = gate();
    n.startGate = g.promise;
    const { c } = withNative(n);
    c.setEnabled(true);
    await flush();
    c.setEnabled(false);
    c.setEnabled(true);
    c.setForeground(false);
    c.setForeground(true);
    await flush();
    g.open();
    await flush();
    expect(n.count('start')).toBe(1);
    expect(n.count('stop')).toBe(0);
    expect(c.status).toBe('listening');
  });

  it('a toggle that ends disabled stops what the pending start opened', async () => {
    const n = new FakeNative();
    const g = gate();
    n.startGate = g.promise;
    const { c } = withNative(n);
    c.setEnabled(true);
    await flush();
    c.setEnabled(false);
    g.open();
    await flush();
    expect(n.log).toEqual(['perm', 'start', 'stop', 'stopped']);
    expect(c.status).toBe('off');
  });

  it('wake at once, then the challenge only after the mic is released', async () => {
    const n = new FakeNative();
    const g = gate();
    const { c, events, advance, intervals } = await listening(n);
    n.stopGate = g.promise;
    n.say('Hey Jarvis');
    expect(events).toEqual(['available:true', 'wake']);
    expect(c.status).toBe('capturing');
    advance(500);
    n.say('Hey Jarvis, I bet Mo can’t do ten');
    advance(1300);
    expect(n.log.at(-1)).toBe('stop');
    expect(intervals.size).toBe(0);
    await flush();
    expect(events).not.toContain('utterance:I bet Mo can’t do ten');
    g.open();
    await flush();
    expect(n.log.slice(-3)).toEqual(['stop', 'stopped', 'utterance']);
    expect(events.at(-1)).toBe('utterance:I bet Mo can’t do ten');
    expect(c.status).toBe('heard');
  });

  it('only "Jarvis": an empty challenge', async () => {
    const { n, events, advance } = await listening();
    n.say('Jarvis');
    advance(4000);
    await flush();
    expect(events.at(-1)).toBe('utterance:');
  });

  it("stays 'heard' with the mic off until resume()", async () => {
    const { n, c, events, advance } = await listening();
    n.say('Jarvis go');
    advance(1300);
    await flush();
    expect(c.status).toBe('heard');
    n.say('Jarvis again');
    advance(5000);
    await flush();
    expect(events.filter((e) => e === 'wake')).toHaveLength(1);
    expect(n.count('start')).toBe(1);
    c.resume();
    await flush();
    expect(n.count('start')).toBe(2);
    expect(c.status).toBe('listening');
  });

  it('re-enabling also re-arms after an utterance; permissions are asked once', async () => {
    const { n, c, advance } = await listening();
    n.say('Jarvis go');
    advance(1300);
    await flush();
    c.setEnabled(false);
    await flush();
    expect(c.status).toBe('heard');
    c.setEnabled(true);
    await flush();
    expect(c.status).toBe('listening');
    expect(n.count('start')).toBe(2);
    expect(n.count('perm')).toBe(1);
  });

  it('denied permissions stick and never start the recognizer', async () => {
    const n = new FakeNative();
    n.perms = { speech: 'denied', mic: 'granted' };
    const { c } = withNative(n);
    c.setEnabled(true);
    await flush();
    expect(c.status).toBe('denied');
    c.setEnabled(false);
    c.setEnabled(true);
    await flush();
    expect(c.status).toBe('denied');
    expect(n.log).toEqual(['perm']);
  });

  it.each<[string, () => Promise<WakeNative | null>]>([
    ['no module in the binary', async () => null],
    ['the module failed to load', () => Promise.reject(new Error('boom'))],
  ])("'unavailable' when %s", async (_why, load) => {
    const { c, events } = setup(load, null);
    c.setEnabled(true);
    await flush();
    expect(c.status).toBe('unavailable');
    expect(c.available).toBe(false);
    expect(events).toEqual(['available:false']);
  });

  it('stops in the background and starts again when active', async () => {
    const { n, c } = await listening();
    c.setForeground(false);
    await flush();
    expect(n.log.slice(-2)).toEqual(['stop', 'stopped']);
    expect(c.status).toBe('off');
    c.setForeground(true);
    await flush();
    expect(n.count('start')).toBe(2);
    expect(c.status).toBe('listening');
  });

  it('backgrounding mid-challenge cancels it', async () => {
    const { n, c, events, advance } = await listening();
    n.say('Jarvis I bet');
    c.setForeground(false);
    await flush();
    advance(5000);
    await flush();
    expect(events.slice(-2)).toEqual(['wake', 'cancel']);
    expect(c.status).toBe('off');
  });

  it('disabled while the mic is being released: the challenge is dropped', async () => {
    const n = new FakeNative();
    const g = gate();
    const { c, events, advance } = await listening(n);
    n.stopGate = g.promise;
    n.say('Jarvis I bet');
    advance(1300);
    c.setEnabled(false);
    g.open();
    await flush();
    expect(events.slice(-2)).toEqual(['wake', 'cancel']);
    expect(c.status).toBe('off');
  });

  it('a failed start reports the reason; resume() retries', async () => {
    const n = new FakeNative();
    n.startResult = { ok: false, onDevice: false, reason: 'audio busy' };
    const { c, events } = withNative(n);
    c.setEnabled(true);
    await flush();
    expect(c.status).toBe('error');
    expect(events.at(-1)).toBe('error:audio busy');
    n.startResult = { ok: true, onDevice: true };
    c.resume();
    await flush();
    expect(c.status).toBe('listening');
  });

  it('a recognizer unavailable right now is a retried error, not a stuck unavailable', async () => {
    const n = new FakeNative();
    n.startResult = { ok: false, onDevice: false, reason: 'recognizer-unavailable' };
    const { c, events } = withNative(n);
    c.setEnabled(true);
    await flush();
    expect(c.available).toBe(true);
    expect(c.status).toBe('error');
    expect(events.at(-1)).toBe('error:recognizer-unavailable');
    // Back online / Dictation on: the next foreground retries, and the listeners are live.
    n.startResult = { ok: true, onDevice: true };
    c.setForeground(false);
    c.setForeground(true);
    await flush();
    expect(n.count('start')).toBe(2);
    expect(c.status).toBe('listening');
    n.say('Jarvis go');
    expect(events.at(-1)).toBe('wake');
  });

  it('a start that throws is an error, not a crash', async () => {
    const n = new FakeNative();
    n.start = () => Promise.reject(new Error('engine'));
    const { c, events } = withNative(n);
    c.setEnabled(true);
    await flush();
    expect(c.status).toBe('error');
    expect(events.at(-1)).toBe('error:engine');
  });

  it('a native error mid-capture cancels, reports and releases the audio session', async () => {
    const { n, c, events } = await listening();
    n.say('Jarvis I bet');
    n.state('error', 'engine failed');
    await flush();
    expect(events.slice(-3)).toEqual(['wake', 'cancel', 'error:engine failed']);
    expect(n.count('stop')).toBe(1);
    expect(c.status).toBe('error');
  });

  it('an interruption cancels the capture; the old task cannot wake it again', async () => {
    const { n, c, events, advance } = await listening();
    n.say('Jarvis I bet', 0);
    n.state('interrupted');
    expect(events.slice(-2)).toEqual(['wake', 'cancel']);
    expect(c.status).toBe('off');
    n.say('Jarvis I bet Mo', 0, true);
    advance(5000);
    n.state('listening');
    expect(c.status).toBe('listening');
    n.say('Jarvis go', 1);
    expect(events.filter((e) => e === 'wake')).toHaveLength(2);
    expect(c.status).toBe('capturing');
  });

  it('native restarts mid-capture keep capturing', async () => {
    const { n, c, events, advance } = await listening();
    n.say('Jarvis I bet', 0);
    n.state('restarting');
    n.state('listening');
    expect(c.status).toBe('capturing');
    n.say('Mo', 1);
    advance(1300);
    await flush();
    expect(events.at(-1)).toBe('utterance:I bet Mo');
  });

  it('dispose stops the recognizer, removes listeners and goes silent', async () => {
    const { n, c, events, statuses, intervals } = await listening();
    const before = [...events];
    const statusCount = statuses.length;
    c.dispose();
    expect(n.count('stop')).toBe(1);
    expect(n.listeners).toBe(0);
    expect(intervals.size).toBe(0);
    c.setEnabled(false);
    c.setEnabled(true);
    await flush();
    expect(events).toEqual(before);
    expect(statuses).toHaveLength(statusCount);
    expect(n.count('start')).toBe(1);
  });

  it('disposed while starting: the start that lands is stopped', async () => {
    const n = new FakeNative();
    const g = gate();
    n.startGate = g.promise;
    const { c, events } = withNative(n);
    c.setEnabled(true);
    await flush();
    c.dispose();
    g.open();
    await flush();
    expect(n.log).toEqual(['perm', 'start', 'stop', 'stopped']);
    expect(events).toEqual(['available:true']);
  });

  it('ignores transcripts while not running', async () => {
    const { n, events } = withNative();
    await flush();
    n.say('Jarvis I bet');
    expect(events).toEqual(['available:true']);
  });
});
