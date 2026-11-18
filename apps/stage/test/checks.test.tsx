// The ref cam on the stage (checks.ts, checks-view.tsx, preview-checks.ts): the fold of
// checks.compiled / checks.report, the quiet "Ref cam" line on the terms card, the ✓ / ✗ / ? rows
// and the veto line on the ruling, the SAM boxes scaled onto the cited frame, old servers and bad
// payloads, and the ?preview=refcam… scenes built from the real bottle-flip SAM runs.
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ChecksCompiledPayload, ChecksReportPayload } from '@youre-on/shared/checks/events';
import { App } from '../src/App';
import {
  boxFrame,
  boxRect,
  compactLabels,
  compactReadback,
  foldChecks,
  markOf,
  refCamLine,
  reportFor,
  whyWords,
  type ChecksSlice,
} from '../src/checks';
import { RefCamFrame, RefCamResult, RefCamTermsLine } from '../src/checks-view';
import { previewAt } from '../src/preview';
import {
  FIXTURE_REPORTS,
  FLIP_READBACK,
  isRefcamPreview,
  OFFLINE_REPORT,
  previewRefcamAt,
  REFCAM_PREVIEW_STEPS,
} from '../src/preview-checks';
import { applyFrame, emptyBet, initialTicker, type BetView, type TickerState } from '../src/ticker';
import { BetCard, TermsCard } from '../src/view';

const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
const focusOf = (s: TickerState): BetView => s.bets[s.focusBetId!]!;

const BET = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const T0 = Date.parse('2026-11-21T18:00:00.000Z');
let seq = 0;
const ev = (type: string, payload: unknown) => ({
  v: 1,
  type,
  bet_id: BET,
  seq: ++seq,
  ts: new Date(T0 + seq * 100).toISOString(),
  source: 'server',
  payload,
});
const fold = (s: TickerState, type: string, payload: unknown) =>
  applyFrame(s, { kind: 'frame', raw: ev(type, payload), receivedAt: T0 + seq * 100 });
const compiled = (terms_hash = HASH_A, decision: 'checks' | 'judge_only' = 'checks') => ({
  terms_hash,
  decision,
  readback: decision === 'checks' ? FLIP_READBACK : 'Judge only, no ref cam.',
});

describe('checks.compiled / checks.report fold', () => {
  it('both events land in the bet’s checks slice through the real reducer', () => {
    let s = fold(initialTicker, 'checks.compiled', compiled());
    expect(s.dropped).toBe(0);
    expect(s.bets[BET]!.checks).toEqual({ compiled: compiled(), report: null });
    s = fold(s, 'checks.report', FIXTURE_REPORTS.bottle_flip_1);
    expect(s.dropped).toBe(0);
    expect(s.bets[BET]!.checks?.compiled).toEqual(compiled());
    expect(s.bets[BET]!.checks?.report).toEqual(FIXTURE_REPORTS.bottle_flip_1);
  });

  it('a newer terms_hash supersedes the readback; a newer attempt supersedes the report', () => {
    let s = fold(initialTicker, 'checks.compiled', compiled(HASH_A));
    s = fold(s, 'checks.compiled', compiled(HASH_B, 'judge_only'));
    expect(s.bets[BET]!.checks?.compiled?.terms_hash).toBe(HASH_B);
    s = fold(s, 'checks.report', { ...FIXTURE_REPORTS.bottle_flip_1, attempt_no: 2 });
    // a replayed attempt-1 report never replaces attempt 2's
    const v = foldChecks(s.bets[BET]!, {
      ...ev('checks.report', { ...FIXTURE_REPORTS.bottle_flip_2_success, attempt_no: 1 }),
    } as never);
    expect(v.checks?.report?.attempt_no).toBe(2);
    expect(v.checks?.report?.veto?.kind).toBe('unconfirmed');
  });

  it('other events leave the slice alone; a bet with no checks events has none', () => {
    const b: ChecksSlice = { checks: null };
    expect(foldChecks(b, ev('judge.cue', { cue: 'PAID', text: 'x', speak: false }) as never)).toBe(
      b,
    );
    expect(emptyBet(BET).checks).toBeNull();
    const s = fold(initialTicker, 'bet.invite_answered', { party: 'B', answer: 'accepted' });
    expect(s.bets[BET]!.checks).toBeNull();
  });

  it('a malformed payload or an unknown checks.* type is dropped, never folded', () => {
    let s = fold(initialTicker, 'checks.compiled', { terms_hash: 'nope', decision: 'checks' });
    expect(s.dropped).toBe(1);
    s = fold(s, 'checks.report', { ...FIXTURE_REPORTS.bottle_flip_1, attempt_no: 0 });
    expect(s.dropped).toBe(2);
    s = fold(s, 'checks.preview', { anything: true });
    expect(s.dropped).toBe(3);
    expect(s.bets[BET]).toBeUndefined();
  });

  it('the fixture payloads are valid checks.* payloads', () => {
    for (const r of [...Object.values(FIXTURE_REPORTS), OFFLINE_REPORT])
      expect(ChecksReportPayload.safeParse(r).success).toBe(true);
    expect(ChecksCompiledPayload.safeParse(compiled()).success).toBe(true);
  });
});

describe('the Ref cam line on the terms card', () => {
  it('shows the readback without its lead and offline footnote, only for the terms on screen', () => {
    const checks = { compiled: compiled(HASH_A), report: null };
    expect(refCamLine(checks, HASH_A)).toEqual({
      decision: 'checks',
      text: 'the bottle: fully in shot at the end; comes to rest; stands upright. Film from the side.',
    });
    // no shared subject: the readback as written
    expect(compactReadback('the cup is on the table; the ball lands in the cup.')).toBe(
      'the cup is on the table; the ball lands in the cup.',
    );
    expect(compactReadback('the ball stays up; the ball lands in the cup.')).toBe(
      'the ball: stays up; lands in the cup.',
    );
    expect(refCamLine(checks, HASH_B)).toBeNull(); // a stale compile never reads back old terms
    expect(refCamLine(checks, null)).toBeNull();
    expect(refCamLine(null, HASH_A)).toBeNull();
    expect(refCamLine({ compiled: compiled(HASH_A, 'judge_only'), report: null }, HASH_A)).toEqual({
      decision: 'judge_only',
      text: 'Judge only',
    });
  });

  it('renders as one quiet line on the TermsCard (the main preview’s terms step)', () => {
    const f = previewAt(START, START, 'terms');
    const html = text(renderToString(<TermsCard bet={focusOf(f.state)} />));
    expect(html).toContain('class="refcam-line on"');
    expect(html).toContain(
      '<span class="label">Ref cam</span> <span class="refcam-text">the bottle: fully in shot at the end;',
    );
    expect(html).not.toContain('offline');
    const judgeOnly = text(
      renderToString(
        <RefCamTermsLine
          checks={{ compiled: compiled(HASH_A, 'judge_only'), report: null }}
          termsHash={HASH_A}
        />,
      ),
    );
    expect(judgeOnly).toContain('class="refcam-line judge-only"');
    expect(judgeOnly).toContain('Judge only');
  });

  it('nothing on the card before (or without) a checks.compiled', () => {
    const f = previewAt(START, START, 'terms');
    const b = { ...focusOf(f.state), checks: null };
    expect(text(renderToString(<TermsCard bet={b} />))).not.toContain('Ref cam');
  });
});

describe('the Ref cam result on the ruling', () => {
  it('✓ / ✗ / ? / – per value, and a few plain words for why', () => {
    expect(['true', 'false', 'unknown', 'abstain'].map((v) => markOf(v as never))).toEqual([
      '✓',
      '✗',
      '?',
      '–',
    ]);
    expect(whyWords({ value: 'true', why: 'ok' })).toBeNull();
    expect(whyWords({ value: 'unknown', why: 'between_bands' })).toBe('too close to call');
    expect(whyWords({ value: 'false', why: 'absent' })).toBe('not seen');
  });

  it('compactLabels drops a shared "the …" subject, never a lone or mixed one', () => {
    expect(
      compactLabels([
        'the bottle fully in shot at the end',
        'the bottle comes to rest',
        'the bottle stands upright',
      ]),
    ).toEqual({
      subject: 'the bottle',
      labels: ['fully in shot at the end', 'comes to rest', 'stands upright'],
    });
    expect(compactLabels(['the can touches the cup', 'the cup comes to rest'])).toEqual({
      subject: null,
      labels: ['the can touches the cup', 'the cup comes to rest'],
    });
    expect(compactLabels(['the bottle stands upright']).subject).toBeNull();
  });

  it('one line: the veto label, what went wrong first, then the passes; the why only if new', () => {
    const r = FIXTURE_REPORTS.bottle_flip_1;
    const html = text(renderToString(<RefCamResult report={r} reason={r.veto.why} />));
    expect(html).toContain('class="refcam-result vetoed"');
    expect(html).toContain(
      '<span class="label veto-title" title="Camera couldn\'t confirm">Ref cam veto</span>',
    );
    // display order: ? first, then the two ✓ (spec order among equals)
    expect(html.match(/class="refcam-check (\w+)"/g)).toEqual([
      'class="refcam-check unsure"',
      'class="refcam-check yes"',
      'class="refcam-check yes"',
    ]);
    expect(html).toMatch(
      /\?<\/span><span class="what">stands upright<span class="why"> \(too close to call\)/,
    );
    expect(html).toMatch(/✓<\/span><span class="what">fully in shot at the end/);
    expect(html).toContain('title="Ref cam · the bottle"');
    // the ruling's reason is veto.why word for word: not printed twice
    expect(html).not.toContain(r.veto.why);
    expect(html).not.toContain('refcam-veto');
    // a why the ruling does not already say gets its own line
    const other = text(renderToString(<RefCamResult report={r} reason="Something else." />));
    expect(other).toContain(`<p class="refcam-veto">${r.veto.why}</p>`);
  });

  it('✗ for a failed gate (the fling), and no veto when the checks changed nothing', () => {
    const fling = text(
      renderToString(<RefCamResult report={FIXTURE_REPORTS.bottle_flip_3_fling} />),
    );
    expect(fling).toMatch(/class="refcam-check no"><span class="mark" aria-hidden="true">✗/);
    expect(fling).toContain('title="Not on camera"');
    expect(fling).toContain(
      `<p class="refcam-veto">${FIXTURE_REPORTS.bottle_flip_3_fling.veto.why}`,
    );
    const ok = text(
      renderToString(<RefCamResult report={FIXTURE_REPORTS.bottle_flip_2_success} />),
    );
    expect(ok.match(/✓/g)).toHaveLength(3);
    expect(ok).toContain('<span class="label">Ref cam</span>');
    expect(ok).not.toContain('veto');
    const off = text(renderToString(<RefCamResult report={OFFLINE_REPORT} />));
    expect(off).toContain('offline · the judge decided alone');
    expect(off).not.toMatch(/class="refcam-check /);
  });

  it('only for the ruling’s own attempt', () => {
    const checks = { compiled: null, report: { ...FIXTURE_REPORTS.bottle_flip_1, attempt_no: 2 } };
    expect(reportFor(checks, 2)?.attempt_no).toBe(2);
    expect(reportFor(checks, 1)).toBeNull();
    expect(reportFor(checks, null)).toBeNull();
    expect(reportFor(null, 2)).toBeNull();
  });
});

describe('the boxes', () => {
  const size = { w: 288, h: 512 };

  it('boxRect keeps the frame’s pixel space (the viewBox) and gives the same box in %', () => {
    expect(boxRect({ box_xyxy: [118, 116, 190, 223] }, size)).toEqual({
      x: 118,
      y: 116,
      width: 72,
      height: 107,
      pct: { left: '40.97%', top: '22.66%', width: '25.00%', height: '20.90%' },
    });
    // clamped to the frame
    expect(boxRect({ box_xyxy: [250, 500, 400, 700] }, size)).toMatchObject({
      x: 250,
      y: 500,
      width: 38,
      height: 12,
    });
  });

  it('RefCamFrame: viewBox = frame_size, the box keeps its aspect, each rect at SAM’s px', () => {
    const r = FIXTURE_REPORTS.bottle_flip_1;
    const html = text(renderToString(<RefCamFrame report={r} idx={11} url="data:x" cited />));
    expect(html).toContain('style="width:min(30vh, 12.38vh);aspect-ratio:288 / 512"');
    // a landscape (tripod) frame keeps its 16:9 too: bounded by width, height follows
    const wide = { ...r, frame_size: { w: 512, h: 288 } };
    expect(text(renderToString(<RefCamFrame report={wide} idx={11} url="data:x" />))).toContain(
      'style="width:min(30vh, 39.11vh);aspect-ratio:512 / 288"',
    );
    expect(html).toContain('viewBox="0 0 288 512"');
    expect(html).toContain('preserveAspectRatio="none"');
    expect(html).toContain('<rect x="125" y="114" width="71" height="106"');
    expect(html).toContain('alt="cited frame 11"');
    expect(html).toContain('frame 11 · ref cam · bottle');
  });

  it('boxFrame: the latest boxed frame with an image, preferring the deciding row’s', () => {
    const r = FIXTURE_REPORTS.bottle_flip_1;
    const urls = Array.from({ length: 12 }, (_, i) => `u${i}`);
    expect(boxFrame(r, urls)).toBe(11);
    expect(boxFrame(r, urls.slice(0, 11))).toBe(10); // frame 11 not fetched yet
    expect(boxFrame(r, [])).toBeNull(); // no frames on the stage: rows only
    expect(boxFrame(FIXTURE_REPORTS.bottle_flip_3_fling, urls)).toBeNull(); // no boxes
    expect(boxFrame(OFFLINE_REPORT, urls)).toBeNull();
  });
});

describe('?preview=refcam… scenes', () => {
  it('every scene folds with no dropped frames and no errors', () => {
    for (const step of REFCAM_PREVIEW_STEPS) {
      expect(isRefcamPreview(step)).toBe(true);
      const f = previewRefcamAt(START, step);
      expect(f.state.dropped, step).toBe(0);
      expect(f.state.errors, step).toEqual([]);
    }
    expect(isRefcamPreview('refcam-nope')).toBe(false);
    expect(isRefcamPreview(null)).toBe(false);
  });

  it('refcam (bottle_flip_1): REDO whose reason is veto.why, ? on upright, the box on frame 11', () => {
    const f = previewRefcamAt(START, 'refcam');
    const b = focusOf(f.state);
    expect(b.ruling?.outcome).toBe('REDO');
    expect(b.ruling?.reason).toBe(FIXTURE_REPORTS.bottle_flip_1.veto.why);
    const html = text(renderToString(<BetCard bet={b} now={f.now} />));
    expect(html).toContain('Redo');
    expect(html).toContain('class="refcam-result vetoed"');
    expect(html).toContain("Camera couldn't confirm");
    // printed once: as the ruling's reason
    expect(html.split(FIXTURE_REPORTS.bottle_flip_1.veto.why)).toHaveLength(2);
    expect(html).toContain('viewBox="0 0 288 512"');
    expect(html).toContain('<rect x="125" y="114" width="71" height="106"');
    expect(html).toContain('class="refcam-line on"');
  });

  it('refcam-ok: three ✓ and the win stands; refcam-fling: ✗ in shot, no boxes', () => {
    const ok = previewRefcamAt(START, 'refcam-ok');
    const okHtml = text(renderToString(<BetCard bet={focusOf(ok.state)} now={ok.now} />));
    expect(focusOf(ok.state).ruling?.outcome).toBe('B_WINS');
    expect(okHtml).toContain('Jake wins');
    expect(okHtml.match(/class="refcam-check yes"/g)).toHaveLength(3);
    expect(okHtml).toContain('<rect x="49" y="137" width="70" height="176"');
    const fl = previewRefcamAt(START, 'refcam-fling');
    const flHtml = text(renderToString(<BetCard bet={focusOf(fl.state)} now={fl.now} />));
    expect(flHtml).toContain('Not on camera');
    expect(flHtml).not.toContain('refcam-boxes');
  });

  it('the main preview: the readback on the terms, ✓✓✓ with a box on the winning ruling', () => {
    const f = previewAt(START, START, 'ruling');
    const html = text(renderToString(<BetCard bet={focusOf(f.state)} now={f.now} />));
    expect(html.match(/class="refcam-check yes"/g)).toHaveLength(3);
    expect(html).toContain('viewBox="0 0 160 120"');
    expect(html).toContain('alt="cited frame 7"');
    // attempt 1's report (judge already said REDO): ✗ in shot, no veto
    const redo = previewAt(START, START, 'redo');
    const r = text(renderToString(<BetCard bet={focusOf(redo.state)} now={redo.now} />));
    expect(r).toContain('class="refcam-check no"');
    expect(r).not.toContain('refcam-veto');
  });
});

describe('App from the URL', () => {
  const g = globalThis as { location?: unknown };
  const prev = g.location;
  afterEach(() => {
    g.location = prev;
  });
  it('?preview=refcam shows the ref cam veto', () => {
    g.location = {
      search: '?preview=refcam&nopreload',
      hash: '',
      origin: 'https://youre-on.fly.dev',
      href: 'https://youre-on.fly.dev/stage/?preview=refcam',
    };
    const html = text(renderToString(<App />));
    expect(html).toContain('class="refcam-result vetoed"');
    expect(html).toContain('viewBox="0 0 288 512"');
  });
});
