// Phone panes (panes.ts): the layout cycle, each slot's source state machine, crop, prefs in
// localStorage, ?panes= / ?layout=, the party names on the slots, which phone glows, the
// "Phones big" status rail, and acquiring a source with fake media APIs.
import { describe, expect, it, vi } from 'vitest';
import { previewAt, type PreviewStep } from '../src/preview';
import type { BetView } from '../src/ticker';
import {
  acquire,
  classifyMediaError,
  constraintsFor,
  cropStyle,
  cueText,
  initialPanes,
  loadPrefs,
  nextLayout,
  PaneMedia,
  PANES_KEY,
  panesReducer,
  parsePanesQuery,
  phoneCues,
  prefsOf,
  railSummary,
  retryOf,
  savePrefs,
  slotMessage,
  slotName,
  slotOfReq,
  sourceLabel,
  stopStream,
  testPatternLabel,
  watchEnded,
  type MediaDeps,
  type MediaStreamLike,
  type MediaTrackLike,
  type PanesAction,
  type PanesState,
  type StorageLike,
} from '../src/panes';

const run = (actions: PanesAction[], s: PanesState = initialPanes()) =>
  actions.reduce(panesReducer, s);

const betAt = (step: PreviewStep): BetView => {
  const { state } = previewAt(0, 0, step);
  return state.bets[state.focusBetId!]!;
};

class FakeTrack implements MediaTrackLike {
  readyState = 'live';
  stopped = false;
  private fns = new Set<() => void>();
  constructor(
    readonly kind = 'video',
    readonly label = 'Reflector 4 – iPhone',
  ) {}
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
  addEventListener(_t: 'ended', fn: () => void) {
    this.fns.add(fn);
  }
  removeEventListener(_t: 'ended', fn: () => void) {
    this.fns.delete(fn);
  }
  end() {
    this.readyState = 'ended';
    for (const f of [...this.fns]) f();
  }
  get listeners() {
    return this.fns.size;
  }
}
const streamOf = (...tracks: FakeTrack[]): MediaStreamLike & { tracks: FakeTrack[] } => ({
  tracks,
  getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  getTracks: () => tracks,
});
const named = (name: string) => Object.assign(new Error(name), { name });

describe('layout', () => {
  it('P cycles stage -> phones + stage -> phones big -> stage', () => {
    expect(nextLayout('stage')).toBe('flank');
    expect(nextLayout('flank')).toBe('big');
    expect(nextLayout('big')).toBe('stage');
    const s = run([{ type: 'cycle' }, { type: 'cycle' }]);
    expect(s.layout).toBe('big');
    expect(run([{ type: 'layout', mode: 'flank' }]).layout).toBe('flank');
  });

  it('the operator panel is closed by default and toggles (O), Esc closes it', () => {
    const s = initialPanes();
    expect(s.operator).toBe(false);
    const open = panesReducer(s, { type: 'operator' });
    expect(open.operator).toBe(true);
    expect(panesReducer(open, { type: 'operator' }).operator).toBe(false);
    expect(panesReducer(open, { type: 'operator', open: false }).operator).toBe(false);
    // closing a closed panel changes nothing (Esc on every overlay)
    expect(panesReducer(s, { type: 'operator', open: false })).toBe(s);
  });
});

describe('the slot state machine', () => {
  it('requesting -> live, with the source label', () => {
    let s = run([{ type: 'request', slot: 'A', kind: 'screen', req: 1 }]);
    expect(s.slots.A.source).toEqual({ status: 'requesting', kind: 'screen', req: 1 });
    expect(slotMessage(s.slots.A)).toMatch(/window/);
    s = panesReducer(s, { type: 'granted', req: 1, label: 'AirPlay' });
    expect(s.slots.A.source).toEqual({ status: 'live', kind: 'screen', req: 1, label: 'AirPlay' });
    expect(slotMessage(s.slots.A)).toBeNull();
    expect(s.slots.B.source.status).toBe('empty');
  });

  it('drops the answer to a superseded request', () => {
    const s = run([
      { type: 'request', slot: 'A', kind: 'screen', req: 1 },
      { type: 'request', slot: 'A', kind: 'test', req: 2 },
    ]);
    expect(panesReducer(s, { type: 'granted', req: 1, label: 'late' })).toBe(s);
    expect(panesReducer(s, { type: 'failed', req: 1, error: 'denied', message: 'x' })).toBe(s);
    expect(panesReducer(s, { type: 'ended', req: 1 })).toBe(s);
    expect(
      panesReducer(s, { type: 'granted', req: 2, label: 'Test pattern' }).slots.A.source,
    ).toMatchObject({ status: 'live', req: 2 });
  });

  it('a denied permission is an error the slot can retry by click', () => {
    const s = run([
      { type: 'request', slot: 'B', kind: 'screen', req: 4 },
      { type: 'failed', req: 4, ...classifyMediaError(named('NotAllowedError'), 'screen') },
    ]);
    expect(s.slots.B.source).toMatchObject({ status: 'error', kind: 'screen', error: 'denied' });
    expect(slotMessage(s.slots.B)).toMatch(/click to try again$/);
    expect(retryOf(s.slots.B)).toEqual({ kind: 'screen', deviceId: null });
  });

  it('the user stopping a share: "Source ended — click to pick again"', () => {
    const s = run([
      { type: 'request', slot: 'A', kind: 'screen', req: 1 },
      { type: 'granted', req: 1, label: 'w' },
      { type: 'ended', req: 1 },
    ]);
    expect(s.slots.A.source).toEqual({ status: 'ended', kind: 'screen' });
    expect(slotMessage(s.slots.A)).toBe('Source ended — click to pick again');
    expect(retryOf(s.slots.A)).toEqual({ kind: 'screen', deviceId: null });
  });

  it('a camera unplugged: retried with the same camera', () => {
    const s = run([
      { type: 'request', slot: 'B', kind: 'camera', req: 3, deviceId: 'cam-1' },
      { type: 'granted', req: 3, label: 'Continuity Camera' },
      { type: 'ended', req: 3 },
    ]);
    expect(s.slots.B.deviceId).toBe('cam-1');
    expect(slotMessage(s.slots.B)).toMatch(/Camera disconnected/);
    expect(retryOf(s.slots.B)).toEqual({ kind: 'camera', deviceId: 'cam-1' });
  });

  it('nothing to retry while empty, requesting or live', () => {
    const s = run([{ type: 'request', slot: 'A', kind: 'test', req: 1 }]);
    expect(retryOf(s.slots.A)).toBeNull();
    expect(retryOf(s.slots.B)).toBeNull();
    expect(retryOf(panesReducer(s, { type: 'granted', req: 1, label: 't' }).slots.A)).toBeNull();
  });

  it('stop empties the slot; a request that was stopped is no longer anyone', () => {
    const s = run([
      { type: 'request', slot: 'A', kind: 'test', req: 1 },
      { type: 'stop', slot: 'A' },
    ]);
    expect(s.slots.A.source.status).toBe('empty');
    expect(slotOfReq(s, 1)).toBeNull();
    expect(panesReducer(s, { type: 'granted', req: 1, label: 'x' })).toBe(s);
    expect(panesReducer(s, { type: 'stop', slot: 'A' })).toBe(s);
  });

  it('swap moves the feeds (and their crop and camera) between A and B', () => {
    const s = run([
      { type: 'request', slot: 'A', kind: 'screen', req: 1 },
      { type: 'granted', req: 1, label: 'Reflector: iPhone (Logan)' },
      { type: 'crop', slot: 'A', crop: 'trim-m' },
      { type: 'request', slot: 'B', kind: 'camera', req: 2, deviceId: 'cam' },
      { type: 'swap' },
    ]);
    expect(s.slots.B.source).toMatchObject({ status: 'live', req: 1 });
    expect(s.slots.B.crop).toBe('trim-m');
    expect(s.slots.A.source).toMatchObject({ status: 'requesting', req: 2 });
    expect(s.slots.A.deviceId).toBe('cam');
    // the camera's answer still lands, now in A
    expect(slotOfReq(s, 2)).toBe('A');
    expect(panesReducer(s, { type: 'granted', req: 2, label: 'c' }).slots.A.source.status).toBe(
      'live',
    );
  });
});

describe('crop', () => {
  it('fit / trim / fill', () => {
    expect(cropStyle('fit')).toEqual({ fit: 'contain', insetPct: 0 });
    expect(cropStyle('trim-s')).toEqual({ fit: 'contain', insetPct: 4 });
    expect(cropStyle('trim-l')).toEqual({ fit: 'contain', insetPct: 12 });
    expect(cropStyle('fill')).toEqual({ fit: 'cover', insetPct: 0 });
  });
});

describe('media errors', () => {
  it('classifies the media API rejections', () => {
    expect(classifyMediaError(named('NotAllowedError'), 'camera').error).toBe('denied');
    expect(classifyMediaError(named('NotFoundError'), 'camera')).toEqual({
      error: 'notfound',
      message: 'That camera is not connected',
    });
    expect(classifyMediaError(named('OverconstrainedError'), 'camera').error).toBe('notfound');
    expect(classifyMediaError(named('NotReadableError'), 'camera').error).toBe('busy');
    expect(classifyMediaError(named('Unsupported'), 'screen').message).toMatch(/https/);
    expect(classifyMediaError(new Error('boom'), 'test')).toEqual({
      error: 'other',
      message: 'boom',
    });
    expect(classifyMediaError(null, 'test').error).toBe('other');
  });
});

describe('acquire (media APIs injected)', () => {
  it('a window: getDisplayMedia, video only, the cursor hidden', async () => {
    const s = streamOf(new FakeTrack());
    const getDisplayMedia = vi.fn(async (_c: Record<string, unknown>) => s);
    expect(await acquire('screen', { label: 'Phone A' }, { getDisplayMedia })).toBe(s);
    const c = getDisplayMedia.mock.calls[0]![0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(c.audio).toBe(false);
    expect(c.video.cursor).toBe('never');
    expect(c.selfBrowserSurface).toBe('exclude');
  });

  it('a camera: getUserMedia with the exact device', async () => {
    const getUserMedia = vi.fn(async () => streamOf(new FakeTrack()));
    await acquire('camera', { label: 'x', deviceId: 'cam-9' }, { getUserMedia });
    expect(getUserMedia).toHaveBeenCalledWith(constraintsFor('camera', 'cam-9'));
    expect(constraintsFor('camera', 'cam-9').video).toMatchObject({
      deviceId: { exact: 'cam-9' },
    });
    expect(constraintsFor('camera', null).video).not.toHaveProperty('deviceId');
  });

  it('a test pattern is labelled with the slot', async () => {
    const testPattern = vi.fn(() => streamOf(new FakeTrack('video', 'canvas-id')));
    const st = await acquire('test', { label: 'Phone B · Jake' }, { testPattern });
    expect(testPattern).toHaveBeenCalledWith('Phone B · Jake');
    expect(sourceLabel('test', st)).toBe('Test pattern');
    expect(sourceLabel('screen', streamOf(new FakeTrack('video', ' ')))).toBe('Window or screen');
    expect(sourceLabel('screen', streamOf(new FakeTrack()))).toBe('Reflector 4 – iPhone');
  });

  it('a missing API rejects as Unsupported; a permission error passes through', async () => {
    await expect(acquire('screen', { label: '' }, {})).rejects.toMatchObject({
      name: 'Unsupported',
    });
    await expect(acquire('test', { label: '' }, {})).rejects.toMatchObject({
      name: 'Unsupported',
    });
    const getUserMedia = () => Promise.reject(named('NotAllowedError'));
    await expect(acquire('camera', { label: '' }, { getUserMedia })).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });

  it('a source with no video is stopped and rejected', async () => {
    const audio = new FakeTrack('audio');
    await expect(
      acquire('screen', { label: '' }, { getDisplayMedia: async () => streamOf(audio) }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(audio.stopped).toBe(true);
  });

  it('watchEnded fires once on the track ending, and detaches', () => {
    const t = new FakeTrack();
    const onEnd = vi.fn();
    const off = watchEnded(streamOf(t), onEnd);
    t.end();
    t.end();
    expect(onEnd).toHaveBeenCalledTimes(1);
    off();
    expect(t.listeners).toBe(0);
  });

  it('watchEnded on an already-ended stream fires on the next tick', async () => {
    const t = new FakeTrack();
    t.stop();
    const onEnd = vi.fn();
    watchEnded(streamOf(t), onEnd);
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('stopStream stops every track and tolerates null', () => {
    const a = new FakeTrack();
    const b = new FakeTrack('audio');
    stopStream(streamOf(a, b));
    expect(a.stopped && b.stopped).toBe(true);
    expect(() => stopStream(null)).not.toThrow();
  });
});

/** A deferred getDisplayMedia / getUserMedia: each call waits until the test answers it. */
function pendingApi() {
  const calls: Array<{
    resolve: (s: ReturnType<typeof streamOf>) => void;
    reject: (e: unknown) => void;
  }> = [];
  const fn = vi.fn(
    () =>
      new Promise<ReturnType<typeof streamOf>>((resolve, reject) =>
        calls.push({ resolve, reject }),
      ),
  );
  return { fn, calls };
}

/** PaneMedia wired to the real reducer, as the hook wires it. */
function harness(deps: MediaDeps<ReturnType<typeof streamOf>>) {
  let state = initialPanes();
  let streams: ReadonlyMap<number, unknown> = new Map();
  const media = new PaneMedia(deps, {
    dispatch: (a) => (state = panesReducer(state, a)),
    onStreams: (m) => (streams = m),
  });
  return {
    media,
    get state() {
      return state;
    },
    get streams() {
      return streams;
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('PaneMedia: every capture is stopped exactly once', () => {
  it('calls getDisplayMedia synchronously (inside the click), then goes live', async () => {
    const api = pendingApi();
    const h = harness({ getDisplayMedia: api.fn });
    const done = h.media.pick('A', 'screen', null, 'Phone A');
    expect(api.fn).toHaveBeenCalledTimes(1); // before any await: the user gesture still holds
    expect(h.state.slots.A.source.status).toBe('requesting');
    const s = streamOf(new FakeTrack());
    api.calls[0]!.resolve(s);
    await done;
    expect(h.state.slots.A.source).toMatchObject({ status: 'live', label: 'Reflector 4 – iPhone' });
    expect(h.streams.size).toBe(1);
    expect(h.media.running).toBe(1);
  });

  it('picking again stops the old capture; stop empties the slot', async () => {
    const t1 = new FakeTrack();
    const t2 = new FakeTrack();
    const queue = [streamOf(t1), streamOf(t2)];
    const h = harness({ getDisplayMedia: async () => queue.shift()! });
    await h.media.pick('A', 'screen', null, '');
    await h.media.pick('A', 'screen', null, '');
    expect(t1.stopped).toBe(true);
    expect(t1.listeners).toBe(0);
    expect(t2.stopped).toBe(false);
    h.media.stop('A');
    expect(t2.stopped).toBe(true);
    expect(h.state.slots.A.source.status).toBe('empty');
    expect(h.streams.size).toBe(0);
    expect(h.media.running).toBe(0);
  });

  it('an answer for a superseded or stopped request is stopped on arrival', async () => {
    const api = pendingApi();
    const h = harness({ getDisplayMedia: api.fn });
    const first = h.media.pick('B', 'screen', null, '');
    const second = h.media.pick('B', 'screen', null, '');
    const late = new FakeTrack();
    const kept = new FakeTrack();
    api.calls[1]!.resolve(streamOf(kept));
    await second;
    api.calls[0]!.resolve(streamOf(late));
    await first;
    expect(late.stopped).toBe(true);
    expect(kept.stopped).toBe(false);
    expect(h.state.slots.B.source.status).toBe('live');

    const third = h.media.pick('A', 'screen', null, '');
    h.media.stop('A');
    const orphan = new FakeTrack();
    api.calls[2]!.resolve(streamOf(orphan));
    await third;
    expect(orphan.stopped).toBe(true);
    expect(h.state.slots.A.source.status).toBe('empty');
    expect(h.media.running).toBe(1);
  });

  it('the share stopped from the browser bar: ended, released, retry by click', async () => {
    const t = new FakeTrack();
    const h = harness({ getDisplayMedia: async () => streamOf(t) });
    await h.media.pick('A', 'screen', null, '');
    t.end();
    expect(h.state.slots.A.source).toEqual({ status: 'ended', kind: 'screen' });
    expect(t.listeners).toBe(0);
    expect(h.streams.size).toBe(0);
    expect(retryOf(h.state.slots.A)).toEqual({ kind: 'screen', deviceId: null });
  });

  it('a denied permission is an error on that slot only', async () => {
    const h = harness({ getUserMedia: () => Promise.reject(named('NotAllowedError')) });
    await h.media.pick('B', 'camera', 'cam-1', '');
    expect(h.state.slots.B.source).toMatchObject({ status: 'error', error: 'denied' });
    expect(h.state.slots.B.deviceId).toBe('cam-1');
    expect(h.state.slots.A.source.status).toBe('empty');
  });

  it('swap keeps both feeds running, then stop acts on the swapped slot', async () => {
    const ta = new FakeTrack();
    const tb = new FakeTrack();
    const h = harness({ testPattern: (l) => streamOf(l.endsWith('A') ? ta : tb) });
    await h.media.pick('A', 'test', null, 'Phone A');
    await h.media.pick('B', 'test', null, 'Phone B');
    h.media.swap();
    expect(ta.stopped || tb.stopped).toBe(false);
    h.media.stop('A'); // A now shows what was B
    expect(tb.stopped).toBe(true);
    expect(ta.stopped).toBe(false);
  });

  it('dispose stops everything and drops the answers still on the way', async () => {
    const api = pendingApi();
    const live = new FakeTrack();
    const h = harness({ getDisplayMedia: api.fn, testPattern: () => streamOf(live) });
    await h.media.pick('A', 'test', null, '');
    const pending = h.media.pick('B', 'screen', null, '');
    h.media.dispose();
    expect(live.stopped).toBe(true);
    const arriving = new FakeTrack();
    api.calls[0]!.resolve(streamOf(arriving));
    await pending;
    await tick();
    expect(arriving.stopped).toBe(true);
    expect(h.media.running).toBe(0);
  });
});

describe('prefs', () => {
  const memory = (): StorageLike & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    };
  };

  it('round-trips the layout, crop and camera (not the sources)', () => {
    const store = memory();
    const s = run([
      { type: 'layout', mode: 'big' },
      { type: 'crop', slot: 'B', crop: 'trim-s' },
      { type: 'device', slot: 'A', deviceId: 'cam-1' },
      { type: 'request', slot: 'A', kind: 'camera', req: 1 },
    ]);
    savePrefs(store, prefsOf(s));
    const back = initialPanes(loadPrefs(store));
    expect(back.layout).toBe('big');
    expect(back.slots.B.crop).toBe('trim-s');
    expect(back.slots.A.deviceId).toBe('cam-1');
    expect(back.slots.A.source.status).toBe('empty');
  });

  it('garbage, a blocked storage and no storage all fall back to the defaults', () => {
    const store = memory();
    store.data.set(PANES_KEY, '{not json');
    expect(loadPrefs(store)).toEqual({});
    store.data.set(
      PANES_KEY,
      JSON.stringify({ layout: 'huge', crop: { A: 'zoom', B: 'fill' }, deviceId: { A: 7 } }),
    );
    expect(loadPrefs(store)).toEqual({
      crop: { A: 'fit', B: 'fill' },
      deviceId: { A: null, B: null },
    });
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadPrefs(throwing)).toEqual({});
    expect(() => savePrefs(throwing, prefsOf(initialPanes()))).not.toThrow();
    expect(loadPrefs(null)).toEqual({});
    expect(initialPanes({}).layout).toBe('stage');
  });
});

describe('launch query', () => {
  it('?panes=test starts test patterns; ?layout= picks the layout', () => {
    expect(parsePanesQuery('?preview&panes=test&layout=flank')).toEqual({
      test: true,
      layout: 'flank',
      sources: { A: 'test', B: 'test' },
    });
    expect(parsePanesQuery('?layout=phones').layout).toBe('big');
    expect(parsePanesQuery('?layout=nope&panes=x')).toEqual({
      test: false,
      layout: null,
      sources: {},
    });
    expect(parsePanesQuery('')).toEqual({ test: false, layout: null, sources: {} });
  });
});

describe('the bet on screen', () => {
  it('slots carry the parties’ names, else Phone A / Phone B', () => {
    expect(slotName(null, 'A')).toBe('Phone A');
    const bet = betAt('lock');
    expect(slotName(bet, 'A')).toBe(bet.names.A);
    expect(slotName({ ...bet, names: { A: '  ', B: null } }, 'B')).toBe('Phone B');
    expect(testPatternLabel(bet, 'B')).toBe(`Phone B · ${bet.names.B}`);
    expect(testPatternLabel(null, 'B')).toBe('Phone B');
  });

  it('the challenged phone glows while the challenge waits', () => {
    const bet = { ...betAt('challenge'), invite: null, state: 'DRAFTING' };
    expect(phoneCues(bet)).toEqual({ A: null, B: 'act' });
    expect(cueText(bet, 'act')).toBe('challenged');
  });

  it('in the lock, each phone that still has to confirm', () => {
    const bet = betAt('lock');
    const cues = phoneCues(bet);
    expect(cues.A).toBe(bet.auth.A ? null : 'act');
    expect(cues.B).toBe(bet.auth.B ? null : 'act');
    expect(cueText(bet, 'act')).toBe('confirm');
    expect(phoneCues({ ...bet, auth: { A: null, B: null } })).toEqual({ A: 'act', B: 'act' });
  });

  it('in the attempt, the phone that films (the non-performer’s)', () => {
    const bet = betAt('attempt');
    const performer = (bet.performer ?? bet.envelope!.terms.performer)!;
    const filmer = performer === 'A' ? 'B' : 'A';
    expect(phoneCues(bet)[filmer]).toBe('act');
    expect(phoneCues(bet)[performer]).toBeNull();
    expect(cueText(bet, 'act')).toBe('filming');
  });

  it('the winner glows and the loser dims (GG) once ruled and paid', () => {
    for (const step of ['ruling', 'paid'] as const) {
      const bet = betAt(step);
      const o = bet.appeal_result?.final_outcome ?? bet.ruling!.outcome;
      const w = o === 'A_WINS' ? 'A' : 'B';
      expect(phoneCues(bet)).toEqual({ [w]: 'win', [w === 'A' ? 'B' : 'A']: 'lose' });
    }
    expect(cueText(null, 'lose')).toBe('GG');
  });

  it('no glow for a Gemini bet’s wait, a void, an ended bet or no bet', () => {
    expect(phoneCues(betAt('market'))).toEqual({ A: null, B: null });
    expect(phoneCues(null)).toEqual({ A: null, B: null });
    expect(phoneCues({ ...betAt('lock'), state: 'CANCELLED' })).toEqual({ A: null, B: null });
    const ruled = betAt('ruling');
    expect(
      phoneCues({ ...ruled, appeal_result: null, ruling: { ...ruled.ruling!, outcome: 'VOID' } }),
    ).toEqual({ A: null, B: null });
  });
});

describe('the "Phones big" status rail', () => {
  it('no bet: waiting', () => {
    expect(railSummary(null)).toMatchObject({
      phase: 'Waiting',
      status: 'Waiting for a challenge…',
    });
  });

  it('the key facts at each moment', () => {
    const lock = railSummary(betAt('lock'));
    expect(lock.phase).toBe('Lock');
    expect(lock.amount).toBe('$10 pot');
    expect(lock.matchup).toMatch(/ vs /);
    expect(lock.claim).toBeTruthy();
    expect(lock.status).toMatch(/of 2 confirmed/);

    const attempt = railSummary(betAt('attempt'));
    expect(attempt.phase).toBe('Attempt');
    expect(attempt.status).toMatch(/is up/);

    const ruling = railSummary(betAt('ruling'));
    expect(ruling.status).toMatch(/wins$/);
    expect(ruling.tone).toBe('good');

    const paid = railSummary(betAt('paid'));
    expect(paid.status).toMatch(/^PAID \$10 → /);

    expect(railSummary(betAt('market'))).toMatchObject({
      phase: 'Market',
      status: 'Locked · waiting on Gemini',
    });
    expect(railSummary({ ...betAt('lock'), state: 'EXPIRED' })).toMatchObject({
      status: 'Expired',
      tone: 'bad',
    });
  });
});
