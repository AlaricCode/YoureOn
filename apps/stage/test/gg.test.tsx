// The GG moment and the spoken review request on the stage (gg.ts, gg-moment.tsx, preview-gg.ts):
// the fold of bet.gg / review.requested / review.closed (and the appeal / revert rules), the
// moment's clock (stamp -> record tick -> payout count-up -> down), the review banner's states,
// the PAID panel's label, the gavel + cheer dedupe, and the ?preview=gg / ?preview=review scenes.
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { recordAfter } from '@youre-on/shared/gg';
import { App } from '../src/App';
import {
  CHEER_DEDUPE_MS,
  COUNT_UP_MS,
  countUpMicro,
  cueSoundAllowed,
  foldGg,
  freshGgSounds,
  ggCoversPayout,
  ggFrame,
  ggMomentEnd,
  ggMomentOn,
  GG_HOLD_AFTER_PAID_MS,
  GG_MAX_MS,
  GG_RECORD_TICK_MS,
  GG_REVERT_MS,
  payoutLabel,
  recordChips,
  reviewShown,
  type GgSlice,
} from '../src/gg';
import { GgMoment, ReviewBanner } from '../src/gg-moment';
import {
  GG_PREVIEW_STEPS,
  isGgPreview,
  PREVIEW_RECORD_BEFORE,
  previewGgAt,
} from '../src/preview-gg';
import { applyFrame, initialTicker, type BetView, type TickerState } from '../src/ticker';
import { BetCard, PaidMoment } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
const scene = (step: string, nowMs = START) => previewGgAt(START, nowMs, step);
const focusOf = (s: TickerState): BetView => s.bets[s.focusBetId!]!;

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const T0 = Date.parse('2026-11-21T18:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 100;
const ev = (type: string, payload: unknown, at = T0) => ({
  v: 1,
  type,
  bet_id: BET,
  seq: ++seq,
  ts: iso(at),
  source: type.startsWith('chain.') ? 'chain' : 'server',
  payload,
});
const after = recordAfter(PREVIEW_RECORD_BEFORE, 'B');
const ggPayload = {
  by: 'A',
  winner: 'B',
  to_a: '0',
  to_b: '10000000',
  record: { before: PREVIEW_RECORD_BEFORE, after },
  conceded_at: iso(T0),
};
const REVIEW = '00000000-0000-4000-8000-0000000007e1';
const reviewPayload = (confirmBy: number) => ({
  review_id: REVIEW,
  for_party: 'A',
  source: 'voice',
  requested_at: iso(T0),
  confirm_by: iso(confirmBy),
});
const stateEv = (state: string, prev: string, at = T0) =>
  ev(
    'bet.state',
    {
      state,
      prev,
      onchain_status: 'Resolved',
      chain_ack: 'rpc',
      pending_tx: null,
      reason: null,
    },
    at,
  );
const run = (frames: unknown[], s: TickerState = initialTicker) =>
  frames.reduce<TickerState>(
    (acc, raw) => applyFrame(acc, { kind: 'frame', raw, receivedAt: T0 }),
    s,
  );
const slice = (
  over: Partial<
    GgSlice & { paid_at: string | null; payout: { to_a: string; to_b: string } | null }
  > = {},
) => ({
  gg: null,
  review: null,
  paid_at: null,
  payout: null,
  ...over,
});

describe('fold', () => {
  it('bet.gg, review.requested and review.closed parse and fold onto the card', () => {
    const s = run([ev('review.requested', reviewPayload(T0 + 6_000)), ev('bet.gg', ggPayload)]);
    expect(s.dropped).toBe(0);
    const b = s.bets[BET]!;
    expect(b.gg).toMatchObject({ by: 'A', winner: 'B', to_b: '10000000', reverted_at: null });
    expect(b.gg!.record!.after).toMatchObject({ a_wins: 7, b_wins: 5, streak: { length: 3 } });
    // the GG closes the open review (the banner hides)
    expect(b.review).toMatchObject({ review_id: REVIEW, for_party: 'A', status: 'gg' });
    expect(reviewShown(b.review, T0)).toBeNull();
  });

  it('a bet.gg whose winner is the GG-er is dropped by the shared schema', () => {
    const s = run([ev('bet.gg', { ...ggPayload, winner: 'A' })]);
    expect(s.dropped).toBe(1);
  });

  it('review: declined / lapsed close it; an appeal confirms it; a stale close is ignored', () => {
    const open = run([ev('review.requested', reviewPayload(T0 + 6_000))]);
    expect(open.bets[BET]!.review!.status).toBe('open');
    const closed = (reason: string, id = REVIEW) =>
      run([ev('review.closed', { review_id: id, reason })], open).bets[BET]!.review!.status;
    expect(closed('declined')).toBe('declined');
    expect(closed('lapsed')).toBe('lapsed');
    expect(closed('declined', '00000000-0000-4000-8000-000000000999')).toBe('open');
    const appealed = run([ev('tx.submitted', { kind: 'appeal', signature: '3'.repeat(88) })], open)
      .bets[BET]!;
    expect(appealed.review!.status).toBe('confirmed');
    expect(run([stateEv('APPEALED', 'RULED')], open).bets[BET]!.review!.status).toBe('confirmed');
    // a resent review.requested (same id) changes nothing
    const again = run([ev('review.requested', reviewPayload(T0 + 9_000))], open);
    expect(again.bets[BET]!.review!.confirm_by_ms).toBe(T0 + 6_000);
  });

  it('a reverted concede (RULED after CONCEDED) marks the GG reverted, reopens the review', () => {
    const s = run([
      ev('review.requested', reviewPayload(T0 + 6_000)),
      stateEv('CONCEDED', 'RULED'),
      ev('bet.gg', ggPayload),
      stateEv('RULED', 'CONCEDED', T0 + 1_500),
    ]);
    const b = s.bets[BET]!;
    expect(b.gg!.reverted_at).toBe(iso(T0 + 1_500));
    expect(b.review!.status).toBe('open');
    expect(ggCoversPayout(b)).toBe(false);
  });

  it('foldGg leaves other events alone', () => {
    const v = slice();
    expect(
      foldGg(v, ev('judge.line', { utterance_id: REVIEW, text: 'x', final: true }) as never),
    ).toBe(v);
  });
});

describe('the moment clock', () => {
  const gg = (over = {}) => ({
    by: 'A' as const,
    winner: 'B' as const,
    to_a: '0',
    to_b: '10000000',
    record: { before: PREVIEW_RECORD_BEFORE, after },
    at: iso(T0),
    seq: 1,
    reverted_at: null,
    ...over,
  });

  it('countUpMicro eases from 0 to the amount and lands exactly', () => {
    expect(countUpMicro(0n, '10000000', T0, T0 - 5)).toBe('0');
    expect(countUpMicro(0n, '10000000', T0, T0 + COUNT_UP_MS)).toBe('10000000');
    expect(countUpMicro(0n, '10000001', T0, T0 + COUNT_UP_MS)).toBe('10000001'); // exact at the end
    for (let t = 1; t < COUNT_UP_MS; t += 37)
      expect(Number(countUpMicro(0n, '10000000', T0, T0 + t)) % 10_000, `t=${t}`).toBe(0);
    const mid = Number(countUpMicro(0n, '10000000', T0, T0 + COUNT_UP_MS / 2));
    expect(mid).toBeGreaterThan(5_000_000); // ease-out: past half at half time
    expect(mid).toBeLessThan(10_000_000);
    let last = 0;
    for (let t = 0; t <= COUNT_UP_MS; t += 100) {
      const v = Number(countUpMicro(0n, '10000000', T0, T0 + t));
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  it('stamp -> record tick -> payout count-up', () => {
    const b = slice({ gg: gg() });
    expect(ggFrame(b, T0 + 100)).toMatchObject({
      ticked: false,
      record: PREVIEW_RECORD_BEFORE,
      paid: false,
      shown: { A: '0', B: '0' },
    });
    expect(ggFrame(b, T0 + GG_RECORD_TICK_MS)).toMatchObject({ ticked: true, record: after });
    const paid = slice({
      gg: gg(),
      paid_at: iso(T0 + 1_600),
      payout: { to_a: '0', to_b: '10000000' },
    });
    expect(ggFrame(paid, T0 + 1_600)!.shown.B).toBe('0');
    expect(ggFrame(paid, T0 + 1_600 + COUNT_UP_MS)!.shown).toEqual({ A: '0', B: '10000000' });
  });

  it('holds 6 s after the payout, 12 s at most without one, and never for a replayed GG', () => {
    const noPay = slice({ gg: gg() });
    expect(ggMomentOn(noPay, T0)).toBe(true);
    expect(ggMomentEnd(noPay)).toBe(T0 + GG_MAX_MS);
    expect(ggMomentOn(noPay, T0 + GG_MAX_MS)).toBe(false);
    const paid = slice({ gg: gg(), paid_at: iso(T0 + 1_600) });
    expect(ggMomentEnd(paid)).toBe(T0 + 1_600 + GG_HOLD_AFTER_PAID_MS);
    expect(ggCoversPayout(paid)).toBe(true);
    // a payout that lands after the moment came down gets the ordinary PAID moment
    const slow = slice({ gg: gg(), paid_at: iso(T0 + GG_MAX_MS + 500) });
    expect(ggCoversPayout(slow)).toBe(false);
    expect(ggMomentEnd(slow)).toBe(T0 + GG_MAX_MS);
    // cold start: the GG happened long ago
    expect(ggMomentOn(paid, T0 + 60_000)).toBe(false);
    expect(ggMomentOn(null, T0)).toBe(false);
    // reverted: up GG_REVERT_MS after the revert, with its own line
    const rev = slice({ gg: gg({ reverted_at: iso(T0 + 1_500) }) });
    expect(ggMomentEnd(rev)).toBe(T0 + 1_500 + GG_REVERT_MS);
    expect(ggFrame(rev, T0 + 2_000)!.reverted).toBe(true);
  });

  it('record chips: the streak from 2, RIVALS, names', () => {
    expect(recordChips(after, { A: 'Logan', B: 'Jake' })).toEqual([
      { kind: 'streak', text: 'Jake ×3' },
      { kind: 'rival', text: 'RIVALS' },
    ]);
    const first = recordAfter(
      { ...PREVIEW_RECORD_BEFORE, a_wins: 0, b_wins: 0, total: 0, streak: null, rival: false },
      'A',
    );
    expect(recordChips(first, { A: 'Logan', B: 'Jake' })).toEqual([]);
  });

  it('payoutLabel names how the money moved', () => {
    expect(payoutLabel('BetConceded')).toBe('GG');
    expect(payoutLabel('BetFinalized')).toBe('Ruling stands');
    expect(payoutLabel('AppealResolved')).toBe('After appeal');
    expect(payoutLabel('BetRefunded')).toBe('Refunded');
    expect(payoutLabel('Refund')).toBe('Refunded');
    expect(payoutLabel('payout')).toBe('Paid');
  });
});

describe('sound', () => {
  it('a gavel for a fresh bet.gg, once; a replayed one is silent', () => {
    const s = run([ev('bet.gg', ggPayload)]);
    const seen = new Set<string>();
    expect(freshGgSounds(s, BET, seen, T0 + 300)).toEqual(['gavel']);
    expect(freshGgSounds(s, BET, seen, T0 + 400)).toEqual([]);
    expect(freshGgSounds(s, BET, new Set(), T0 + 60_000)).toEqual([]);
  });

  it("a stage.cue cheer right after the stage's own is dropped; other cues are not", () => {
    expect(cueSoundAllowed('cheer', T0, T0 + 1_000)).toBe(false);
    expect(cueSoundAllowed('cheer', T0, T0 + CHEER_DEDUPE_MS)).toBe(true);
    expect(cueSoundAllowed('cheer', null, T0)).toBe(true);
    expect(cueSoundAllowed('gavel', T0, T0 + 10)).toBe(true);
  });
});

describe('?preview=gg / ?preview=review', () => {
  it('every scene step folds with no dropped frames', () => {
    for (const step of Object.keys(GG_PREVIEW_STEPS)) {
      const f = scene(step);
      expect(f.state.dropped, step).toBe(0);
      expect(f.state.errors, step).toEqual([]);
      expect(isGgPreview(step)).toBe(true);
    }
    expect(isGgPreview('ruling')).toBe(false);
    expect(isGgPreview('toString')).toBe(false);
    // the loop plays the whole GG scene
    const end = scene('gg', START + 13_000);
    expect(focusOf(end.state).state).toBe('PAID');
  });

  it('gg-stamp: the stamp, the record before the tick; no payout yet', () => {
    const f = scene('gg-stamp');
    const b = focusOf(f.state);
    expect(ggMomentOn(b, f.now)).toBe(true);
    const html = text(renderToString(<GgMoment bet={b} now={f.now} />));
    expect(html).toContain('<span class="gg-who">Logan:</span> <span class="gg-word">GG</span>');
    expect(html).toContain('Good game.');
    expect(html).toContain('HEAD TO HEAD');
    expect(html).toMatch(/gg-num">7<.*gg-num">4</);
    expect(html).toContain('Paying out…');
    expect(html).not.toContain('RIVALS');
  });

  it('gg-record: the winner number rolled, chips up', () => {
    const f = scene('gg-record');
    const html = text(renderToString(<GgMoment bet={focusOf(f.state)} now={f.now} />));
    expect(html).toContain('<span class="gg-num rolled">5</span>');
    expect(html).toContain('Jake ×3');
    expect(html).toContain('RIVALS');
  });

  it('gg-paid: the payout counted up; the PAID moment stays down', () => {
    const f = scene('gg-paid');
    const b = focusOf(f.state);
    expect(b.payout).toMatchObject({ event: 'BetConceded', to_b: '10000000' });
    expect(ggCoversPayout(b)).toBe(true);
    const html = text(renderToString(<GgMoment bet={b} now={f.now} />));
    expect(html).toContain('<span>Jake</span><span class="amt">+$10');
    expect(html).toContain('<span>Logan</span><span class="amt">$0</span>');
    expect(html).toContain('Paid · BetConceded · devnet');
    expect(text(renderToString(<PaidMoment bet={b} />))).toContain(
      'GG · BetConceded on Solana devnet',
    );
  });

  it('gg-done: the moment is down; the PAID panel says GG with the record', () => {
    const f = scene('gg-done');
    const b = focusOf(f.state);
    expect(ggMomentOn(b, f.now)).toBe(false);
    const html = text(renderToString(<BetCard bet={b} now={f.now} />));
    expect(html).toContain('<span class="paid-via gg">GG</span>');
    expect(html).toContain('BetConceded · devnet');
    expect(html).toContain('Logan said GG · Logan 7-5 Jake');
  });

  it('a first meeting says so; no record (null) hides the row, never the GG', () => {
    const f = scene('gg-record');
    const b = focusOf(f.state);
    const zero = {
      ...PREVIEW_RECORD_BEFORE,
      a_wins: 0,
      b_wins: 0,
      total: 0,
      streak: null,
      rival: false,
    };
    const first: BetView = {
      ...b,
      gg: { ...b.gg!, record: { before: zero, after: recordAfter(zero, 'B') } },
    };
    const html = text(renderToString(<GgMoment bet={first} now={f.now} />));
    expect(html).toContain('First meeting');
    expect(html).toContain('<span class="gg-num rolled">1</span>');
    const none = text(
      renderToString(<GgMoment bet={{ ...b, gg: { ...b.gg!, record: null } }} now={f.now} />),
    );
    expect(none).not.toContain('HEAD TO HEAD');
    expect(none).toContain('Good game.');
  });

  it("gg-reverted: GG didn't go through", () => {
    const f = scene('gg-reverted');
    const b = focusOf(f.state);
    expect(b.state).toBe('RULED');
    expect(ggMomentOn(b, f.now)).toBe(true);
    const html = text(renderToString(<GgMoment bet={b} now={f.now} />));
    expect(html).toContain('gg-moment reverted');
    expect(html).toContain("GG didn't go through");
    expect(html).not.toContain('HEAD TO HEAD');
  });

  it('review-open: the banner with the loser and the countdown to confirm_by', () => {
    const f = scene('review-open');
    const b = focusOf(f.state);
    expect(b.review!.status).toBe('open');
    const html = text(renderToString(<BetCard bet={b} now={f.now} />));
    expect(html).toContain('REVIEW REQUESTED');
    expect(html).toContain('Logan confirms on their phone');
    expect(html).toMatch(/review-banner open.*countdown">0:0[3-5]</);
    expect(html).toContain('Jake wins'); // the ruling is still up
    expect(html).not.toContain('Appeal window'); // the banner has the appeal bar's place
  });

  it('review-confirmed: CONFIRMED in the appeal bar slot, then the panel takes over', () => {
    const f = scene('review-confirmed');
    const b = focusOf(f.state);
    expect(b.appealed).toBe(false); // the appeal tx is sent, not landed
    expect(b.review!.status).toBe('confirmed');
    const html = text(renderToString(<BetCard bet={b} now={f.now} />));
    expect(html).toContain('CONFIRMED');
    expect(html).toContain('three-judge panel');
    expect(html).not.toContain('Appealed · the panel is reviewing');
    expect(html).not.toContain('Appeal window');
    const p = scene('review-panel');
    const panel = text(renderToString(<BetCard bet={focusOf(p.state)} now={p.now} />));
    expect(panel).toContain('APPEAL · THREE-MODEL PANEL');
    expect(panel).toContain('GPT');
    expect(panel).not.toContain('review-banner');
  });

  it('review-declined / review-lapsed: the ruling stands', () => {
    const d = scene('review-declined');
    expect(text(renderToString(<ReviewBanner bet={focusOf(d.state)} now={d.now} />))).toContain(
      'Logan kept the ruling',
    );
    const l = scene('review-lapsed');
    const lb = focusOf(l.state);
    expect(lb.review!.status).toBe('lapsed');
    const html = text(renderToString(<ReviewBanner bet={lb} now={l.now} />));
    expect(html).toContain('NOT CONFIRMED');
    expect(html).toContain('the ruling stands');
  });

  it('an open review past confirm_by reads as lapsed (a lost server timer)', () => {
    const f = scene('review-open');
    const b = focusOf(f.state);
    expect(reviewShown(b.review, b.review!.confirm_by_ms + 1)).toBe('lapsed');
  });
});

describe('App from the URL', () => {
  const g = globalThis as { location?: unknown };
  const prev = g.location;
  afterEach(() => {
    g.location = prev;
  });
  const boot = (step: string) => {
    g.location = {
      search: `?preview=${step}&nopreload`,
      hash: '',
      origin: 'https://youre-on.fly.dev',
      href: `https://youre-on.fly.dev/stage/?preview=${step}`,
    };
    return text(renderToString(<App />));
  };

  it('?preview=gg-paid shows the GG moment in place of the PAID moment', () => {
    const html = boot('gg-paid');
    expect(html).toContain('data-testid="gg-moment"');
    expect(html).not.toContain('class="paid-moment"');
  });

  it('?preview=review-open shows the review banner', () => {
    expect(boot('review-open')).toContain('REVIEW REQUESTED');
  });
});
