// The slow-mo replay on the projector (src/slowmo.ts, src/SlowMoPlayer.tsx): when it plays on its
// own, the R key's toggle, how it is labelled (never "REPLAY": that word is for pre-recorded
// fallbacks), the held frame, the foul freeze, and the ?preview sample.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { slowmoTimeline, type ReplayFrame, type ReplayMoment } from '@youre-on/shared/replay';
import { CACHED_RULING_MODEL } from '@youre-on/shared/ruling';
import { PAID_FRESH_MS as APP_FRESH, PAID_MOMENT_MS as APP_MOMENT } from '../src/App';
import { previewAt } from '../src/preview';
import {
  availableMoment,
  fetchReplay,
  fetchReplayAsset,
  NO_SLOWMO,
  PAID_FRESH_MS,
  PAID_MOMENT_MS,
  parseSlowmoLaunch,
  playedKey,
  previewMoment,
  resolveFrame,
  shouldAutoPlay,
  slowmoLabels,
  slowmoToggle,
  SLOWMO_AUTO_WINDOW_MS,
} from '../src/slowmo';
import { SlowMo } from '../src/SlowMoPlayer';
import { emptyBet, frameKey, type BetView } from '../src/ticker';
import { KEYS } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';

/** The sample bet once paid (?preview=paid): Jake (B) won attempt 2, judge cited frames 7 and 6. */
const paidBet = (): BetView => {
  const f = previewAt(START, START, 'paid');
  return f.state.bets[f.state.focusBetId!]!;
};

const PAID_AT = Date.parse('2026-11-20T15:00:49.400Z');
const paid = (over: Partial<BetView> = {}): BetView => ({
  ...emptyBet(BET),
  state: 'PAID',
  ruling: {
    outcome: 'B_WINS',
    reason: 'It lands upright.',
    confidence: 0.94,
    cited_frames: [7],
    model: 'anthropic/claude-sonnet-5-5',
    stage: 'attempt',
    void_reason: null,
    ruling_hash: 'a'.repeat(64),
    attempt_no: 2,
    redo_reason: null,
  },
  evidence: { attempt_no: 2, frames: 9 },
  payout: { to_a: '0', to_b: '10000000', event: 'BetFinalized', signature: null },
  paid_at: new Date(PAID_AT).toISOString(),
  ...over,
});
const auto = (o: Partial<Parameters<typeof shouldAutoPlay>[0]> = {}) =>
  shouldAutoPlay({
    bet: paid(),
    paidSeenAt: PAID_AT + 300,
    now: PAID_AT + 300 + PAID_MOMENT_MS,
    overlayOpen: false,
    operatorOpen: false,
    played: new Set(),
    ...o,
  });

describe('auto-play: once, after a fresh payout, never during the appeal window', () => {
  it('uses the App’s PAID moment timings', () => {
    expect(PAID_MOMENT_MS).toBe(APP_MOMENT);
    expect(PAID_FRESH_MS).toBe(APP_FRESH);
  });

  it('fires PAID_MOMENT_MS after the payout first showed (not before), for a while', () => {
    expect(auto()).toBe(true);
    expect(auto({ now: PAID_AT + 300 + PAID_MOMENT_MS - 1 })).toBe(false);
    expect(auto({ now: PAID_AT + 300 + PAID_MOMENT_MS + SLOWMO_AUTO_WINDOW_MS + 1 })).toBe(false);
  });

  it('never while RULED (the appeal window: the judge talks, the outcome can change)', () => {
    expect(auto({ bet: paid({ state: 'RULED', payout: null, paid_at: null }) })).toBe(false);
    expect(auto({ bet: paid({ state: 'RULED' }) })).toBe(false);
  });

  it('not for a stale payout seen on a cold start', () => {
    const seen = PAID_AT + PAID_FRESH_MS + 1;
    expect(auto({ paidSeenAt: seen, now: seen + PAID_MOMENT_MS })).toBe(false);
  });

  it('not over an overlay (1-6 REPLAY clip, QR, help) or the operator panel', () => {
    expect(auto({ overlayOpen: true })).toBe(false);
    expect(auto({ operatorOpen: true })).toBe(false);
  });

  it('not twice for the same (bet, attempt); not for a refund', () => {
    expect(auto({ played: new Set([playedKey(BET, 2, 'win')]) })).toBe(false);
    expect(auto({ played: new Set([playedKey(BET, 2, 'foul')]) })).toBe(false);
    expect(auto({ played: new Set([playedKey(BET, 1, 'win')]) })).toBe(true);
    const voided = paid({ ruling: { ...paid().ruling!, outcome: 'VOID' } });
    expect(auto({ bet: voided })).toBe(false);
  });
});

describe('keys', () => {
  it('R toggles: an open slow-mo closes, anything else (a 1-6 clip too) is replaced', () => {
    expect(slowmoToggle({ kind: 'slowmo' })).toBe('close');
    expect(slowmoToggle(null)).toBe('open');
    expect(slowmoToggle({ kind: 'replay' })).toBe('open');
    expect(slowmoToggle({ kind: 'help' })).toBe('open');
  });

  it('help lists R next to 1-6; the line does not call it a REPLAY', () => {
    const keys = KEYS.map(([k]) => k);
    expect(keys).toContain('R');
    expect(keys).toContain('1 – 6');
    expect(KEYS.find(([k]) => k === 'R')![1]).not.toMatch(/replay/i);
  });

  it('the preview dev hooks: ?slowmo, ?slowmo=foul, &slowmo_at=<ms>', () => {
    expect(parseSlowmoLaunch('?preview=paid')).toEqual({ open: null, at: null });
    expect(parseSlowmoLaunch('?preview=paid&slowmo')).toEqual({ open: 'win', at: null });
    expect(parseSlowmoLaunch('?preview&slowmo=foul&slowmo_at=2500')).toEqual({
      open: 'foul',
      at: 2500,
    });
    expect(parseSlowmoLaunch('?slowmo&slowmo_at=x').at).toBeNull();
  });
});

describe('the preview moment', () => {
  it('builds from the sample bet: lead-in + landing frames, held on the judge’s frame 7', () => {
    const p = previewMoment(paidBet())!;
    expect(p.moment.kind).toBe('win');
    expect(p.moment.winner).toBe('B');
    expect(p.moment.frames.map((f) => f.idx)).toEqual([3, 4, 5, 6, 7]);
    expect(p.moment.hold_source).toBe('judge_cited');
    for (const f of p.moment.frames) expect(p.images[f.path]).toMatch(/^data:image\/svg\+xml/);
  });

  it('nothing before a ruling', () => {
    const f = previewAt(START, START, 'attempt');
    expect(previewMoment(f.state.bets[f.state.focusBetId!]!)).toBeNull();
  });
});

const names = { A: 'Logan', B: 'Jake' };
function draw(m: ReplayMoment, at: number | null, images: Record<string, string> = {}) {
  return text(
    renderToString(
      <SlowMo
        moment={m}
        names={names}
        src={(f) => images[f.path] ?? null}
        onClose={() => {}}
        freezeAt={at}
      />,
    ),
  );
}

describe('rendering', () => {
  const { moment, images } = previewMoment(paidBet())!;
  const tl = slowmoTimeline(moment);

  it('mid-play: the badge and the winner, every frame stacked, no hold label yet, never "REPLAY"', () => {
    const html = draw(moment, tl.steps[2]!.at_ms + 100, images);
    expect(html).toContain('SLOW-MO · WINNING MOMENT');
    expect(html).toContain('Jake wins');
    expect(html).not.toContain('REPLAY');
    expect(html).not.toContain("JUDGE'S FRAME");
    expect(html.match(/<img /g)).toHaveLength(moment.frames.length);
    expect(html).toContain('Live evidence frames · attempt 2');
    expect(html).toContain(moment.reason!);
  });

  it('on the hold: the judge’s frame is ringed and named', () => {
    const html = draw(moment, tl.hold_at_ms + 200, images);
    expect(html).toContain('slowmo-frame holding');
    expect(html).toContain("JUDGE'S FRAME 7");
  });

  it('a cached (demo) ruling keeps its "replay ruling" label', () => {
    const cached = { ...moment, model: CACHED_RULING_MODEL };
    expect(slowmoLabels(cached, names).cached).toBe(true);
    expect(draw(cached, 0, images)).toContain('replay ruling');
    expect(draw(moment, 0, images)).not.toContain('replay ruling');
  });

  it('a foul freezes on the detector moment with its measurement', () => {
    const foul = previewMoment(paidBet(), 'foul')!;
    const ftl = slowmoTimeline(foul.moment);
    const html = draw(foul.moment, ftl.hold_at_ms + 10, foul.images);
    expect(html).toContain('SLOW-MO · FOUL');
    expect(html).toContain('FOUL · Toe 17 cm over');
    expect(html).toContain('slowmo foul');
    expect(html).not.toContain(moment.reason!); // a foul shows no judge reason
  });

  it('a clip with overlays burned in: the video and only the badge', () => {
    const clip: ReplayMoment = {
      ...moment,
      kind: 'foul',
      hold_source: 'detector',
      foul: { label: 'Toe 17 cm over', measure_cm: 17, detector: 'sam3/fal@1' },
      reason: null,
      frames: [],
      clip: {
        url: 'https://storage.example/foul.mp4?sig=1',
        expires_at: '2026-11-20T15:20:00.000Z',
        mime: 'video/mp4',
        source_rate: 0.25,
        from_ms: 0,
        moment_ms: 4000,
        to_ms: 6000,
        overlays_burned: true,
      },
    };
    const html = draw(clip, null);
    expect(html).toContain('<video');
    expect(html).toContain('SLOW-MO · FOUL');
    expect(html).not.toContain('Jake wins');
    expect(html).not.toContain('Live evidence');
  });

  it('the toast text', () => {
    expect(NO_SLOWMO).toBe('No slow-mo yet');
  });
});

describe('fetching', () => {
  const frame = (over: Partial<ReplayFrame> = {}): ReplayFrame => ({
    idx: 4,
    t_ms: 3000,
    landing_crop: false,
    cited: false,
    path: `/v1/bets/${BET}/attempts/2/frames/4`,
    url: null,
    ...over,
  });

  it('resolveFrame: a signed url, else the card’s fetched JPEG, else the slow-mo cache', () => {
    const m = { bet_id: BET, attempt_no: 2 };
    const blobs = { [frameKey(BET, 2)]: { 4: 'blob:card4' } };
    const cache = new Map([[frame({ idx: 5 }).path.replace('/4', '/5'), 'blob:own5']]);
    expect(resolveFrame(m, frame({ url: 'https://cdn.example/f4.jpg' }), blobs, cache)).toBe(
      'https://cdn.example/f4.jpg',
    );
    expect(resolveFrame(m, frame(), blobs, cache)).toBe('blob:card4');
    const f5 = frame({ idx: 5, path: `/v1/bets/${BET}/attempts/2/frames/5` });
    expect(resolveFrame(m, f5, blobs, cache)).toBe('blob:own5');
    expect(resolveFrame(m, frame({ idx: 6, path: 'x' as never }), blobs, cache)).toBeNull();
  });

  it('availableMoment: frames that never arrived are dropped; a lost judge frame is not labelled', () => {
    const { moment } = previewMoment(paidBet())!;
    expect(availableMoment(moment, () => true)).toBe(moment);
    const held = moment.frames.at(-1)!;
    const lostHeld = availableMoment(moment, (f) => f !== held)!;
    expect(lostHeld.frames).toHaveLength(moment.frames.length - 1);
    expect(lostHeld.hold_source).toBe('last_frame');
    expect(lostHeld.moment_ms).toBe(lostHeld.frames.at(-1)!.t_ms);
    expect(slowmoLabels(lostHeld, { A: 'A', B: 'B' }).hold).toBe('LAST FRAME');
    const lostFirst = availableMoment(moment, (f) => f !== moment.frames[0])!;
    expect(lostFirst.hold_source).toBe(moment.hold_source);
    expect(availableMoment(moment, () => false)).toBeNull();
    const foul = previewMoment(paidBet(), 'foul')!.moment;
    expect(availableMoment(foul, (f) => f !== foul.frames.at(-1))).toBeNull();
  });

  it('fetchReplayAsset: the bearer goes to the server path only, never to a signed url', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const io = {
      fetch: (async (u: string, init?: RequestInit) => {
        calls.push([u, init]);
        return new Response(new Uint8Array([1]), { status: 200 });
      }) as unknown as typeof fetch,
      createObjectURL: () => 'blob:x',
    };
    expect(await fetchReplayAsset('https://srv.example', 'tok', frame(), io)).toBe('blob:x');
    expect(calls[0]![0]).toBe(`https://srv.example/v1/bets/${BET}/attempts/2/frames/4`);
    expect((calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer tok');
    await fetchReplayAsset(
      'https://srv.example',
      'tok',
      frame({ url: 'https://cdn.example/a' }),
      io,
    );
    expect(calls[1]).toEqual(['https://cdn.example/a', undefined]);
  });

  it('fetchReplay parses the response with the stage bearer', async () => {
    const { moment } = previewMoment(paidBet())!;
    let auth: string | null = null;
    const r = await fetchReplay('https://srv.example', 'tok', BET, (async (
      u: string,
      init?: RequestInit,
    ) => {
      expect(u).toBe(`https://srv.example/v1/bets/${BET}/replay`);
      auth = (init!.headers as Record<string, string>).authorization!;
      return Response.json({ replay: moment, why: 'ready', final: true });
    }) as unknown as typeof fetch);
    expect(auth).toBe('Bearer tok');
    expect(r.replay!.frames).toHaveLength(moment.frames.length);
    await expect(
      fetchReplay('https://srv.example', 'tok', BET, (async () =>
        Response.json(
          { error: { code: 'NOT_FOUND' } },
          { status: 404 },
        )) as unknown as typeof fetch),
    ).rejects.toThrow(/404/);
  });
});
