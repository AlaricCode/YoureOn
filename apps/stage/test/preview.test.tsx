// ?preview: the sample sequence folds through the real reducer with zero dropped frames, every
// step renders the moment it is named after, the loop advances monotonically, and the App boots
// into it from the URL. Also the overlays (PAID moment, QR, help, health strip).
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { phaseOf, PHASES } from '../src/phase';
import {
  bottleFrame,
  LOOP_MS,
  PREVIEW_HEALTH,
  PREVIEW_STEPS,
  previewAt,
  previewState,
} from '../src/preview';
import { explorerTx } from '../src/ticker';
import {
  featuredTx,
  HealthStrip,
  HelpOverlay,
  KEYS,
  PaidMoment,
  QrOverlay,
  StageView,
  tickerRows,
} from '../src/view';
import { initialReplays } from '../src/replays';

/** A 5-minute boundary, so both bets' market windows line up (deterministic Gemini widget). */
const START = Date.parse('2026-11-20T15:00:00.000Z');
const text = (html: string) => html.replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
const at = (step: keyof typeof PREVIEW_STEPS) => previewAt(START, START, step);
const render = (step: keyof typeof PREVIEW_STEPS) => {
  const f = at(step);
  return text(
    renderToString(
      <StageView state={f.state} now={f.now} preview={step} showHealth health={PREVIEW_HEALTH} />,
    ),
  );
};

describe('preview sequence', () => {
  it('every step folds with no dropped frames and no errors', () => {
    for (const step of Object.keys(PREVIEW_STEPS) as Array<keyof typeof PREVIEW_STEPS>) {
      const f = at(step);
      expect(f.state.dropped, step).toBe(0);
      expect(f.state.errors, step).toEqual([]);
      expect(f.t).toBe(PREVIEW_STEPS[step]);
      expect(f.now).toBe(START + PREVIEW_STEPS[step]);
    }
    const end = previewAt(START, START + LOOP_MS - 1);
    expect(end.state.dropped).toBe(0);
    expect(Object.keys(end.state.bets)).toHaveLength(2);
  });

  it('each bet moves forward through the phases as the loop plays', () => {
    const seen: Record<string, number> = {};
    for (let t = 0; t < LOOP_MS; t += 500) {
      const s = previewAt(START, START + t).state;
      const bet = s.focusBetId ? s.bets[s.focusBetId] : null;
      if (!bet) continue;
      const i = PHASES.indexOf(phaseOf(bet));
      expect(i, `t=${t}`).toBeGreaterThanOrEqual(seen[bet.bet_id] ?? 0);
      seen[bet.bet_id] = i;
    }
    // both bets reach Paid
    expect(Object.values(seen)).toEqual([5, 5]);
    // the loop restarts at the challenge
    const again = previewAt(START, START + LOOP_MS + 1_000, null).state;
    expect(phaseOf(again.bets[again.focusBetId!]!)).toBe('challenge');
  });

  it('the steps are the moments they are named after', () => {
    expect(phaseOf(at('challenge').state.bets[at('challenge').state.focusBetId!]!)).toBe(
      'challenge',
    );
    const challenge = render('challenge');
    expect(challenge).toContain('Logan challenged Jake');
    // The bottle flip is a face challenge between rivals: the record sits under VS.
    expect(challenge.replace(/<!-- -->/g, '')).toContain(
      'Logan 4–7 Jake · Rivals · Jake won 2 straight',
    );
    expect(challenge).toContain('PREVIEW · sample data');

    const terms = render('terms');
    expect(terms).toContain('Terms are set');
    expect(terms).toContain('It comes to rest standing upright on its base.');
    expect(terms).toContain('Does landing on the cap count? <b>No. Only upright on its base.</b>');
    expect(
      text(
        renderToString(
          <StageView state={previewAt(START, START + 5_000).state} now={START + 5_000} />,
        ),
      ),
    ).toContain('<span class="label player">Jake</span> Easy money. I never miss.');

    const lock = render('lock');
    expect(lock).toContain('1 of 2 authorized');
    expect(lock).toContain('Nothing has moved yet');
    expect(lock).toMatch(/TERMS CODE<\/span><span class="code">[0-9a-f]{4}·[0-9a-f]{4}/);

    const locked = render('locked');
    expect(locked).toContain('LOCKED');
    expect(locked).toContain('$10 in escrow');
    expect(locked).toContain('1 transaction · 3 signatures');
    expect(locked).toContain('Streams +2.8 s');
    expect(locked).toContain('SCAN · Lock transaction');
    expect(locked).toContain('<svg class="qr"');
    expect(locked).toContain('Fee payer');

    expect(render('attempt')).toContain('Attempt 1 · Jake is up');
    const redo = render('redo');
    expect(redo).toContain('Redo');
    expect(redo).toContain('cited frame 2');
    expect(render('judging')).toContain('Attempt 2 · The judge is watching 8 frames');

    const ruling = render('ruling');
    expect(ruling).toContain('Jake wins');
    expect(ruling).toMatch(/Appeal window 0:0[78]/);
    expect(ruling).toContain('cited frame 7');
    expect(ruling).toContain('WINNER');
    expect(ruling).toContain('SCAN · Ruling transaction');

    const paid = render('paid');
    expect(paid).toContain('PAID');
    expect(paid).toContain('+$10');
    expect(paid).toContain('SCAN · Payout transaction');
    expect(paid).toContain('Paid. Jake takes ten dollars');

    const market = render('market');
    expect(market).toContain('Waiting on Gemini');
    expect(market).toContain('Logan UP $6.10 · Jake DOWN $3.90');
    expect(market).toContain('locked');
    expect(market).toContain('Market');

    const settled = render('settled');
    expect(settled).toContain('GEMINI SETTLES IT');
    expect(settled).toContain('Logan wins');
    expect(settled).toContain('WINNER');
    const end = previewAt(START, START + LOOP_MS - 1);
    const html = text(renderToString(<StageView state={end.state} now={end.now} />));
    expect(html).toContain('Logan</span><span class="amt">+$10');
  });

  it('the health strip shows sample values in preview', () => {
    const html = render('locked');
    expect(html).toContain('4.820 SOL');
    expect(html).toContain('7 free / 8');
    expect(html).toContain('142 ms');
  });

  it('the ticker shows chain events with the Streams lag and Explorer links', () => {
    const s = at('paid').state;
    const rows = tickerRows(s);
    expect(rows[0]!.type).toBe('chain.BetClosed');
    expect(
      rows.some((r) => r.type === 'chain.BetFinalized' && r.explorer?.includes('cluster=devnet')),
    ).toBe(true);
    const html = render('paid');
    expect(html).toContain('BetFinalized');
    expect(html).toMatch(/BetCreated<\/code><span class="lag"> \+2\.8 s/);
  });

  it('bottle frames are SVG data URLs', () => {
    expect(bottleFrame(2, 7)).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(decodeURIComponent(bottleFrame(2, 7))).toContain('rotate(720)');
    expect(decodeURIComponent(bottleFrame(1, 4))).not.toContain('rotate('); // out of frame
  });

  it('previewState (old API) is the ruling moment', () => {
    const s = previewState(START, START);
    expect(s.bets[s.focusBetId!]!.ruling?.outcome).toBe('B_WINS');
  });
});

describe('overlays', () => {
  it('PAID moment: the amount, the winner, the event', () => {
    const f = at('paid');
    const bet = f.state.bets[f.state.focusBetId!]!;
    const html = text(renderToString(<PaidMoment bet={bet} />));
    expect(html).toContain('PAID');
    expect(html).toContain('$10 → Jake');
    expect(html).toContain('BetFinalized on Solana devnet');
  });

  it('QR overlay: the newest transaction; a fallback before any', () => {
    const f = at('paid');
    const bet = f.state.bets[f.state.focusBetId!]!;
    const tx = featuredTx(bet)!;
    expect(tx.label).toBe('Payout transaction');
    const html = renderToString(<QrOverlay tx={tx} onClose={() => {}} />);
    expect(html).toContain('<svg class="qr"');
    expect(html).toContain(`QR: Payout transaction`);
    expect(renderToString(<QrOverlay tx={null} onClose={() => {}} />)).toContain(
      'No transaction yet',
    );
    expect(featuredTx(at('lock').state.bets[at('lock').state.focusBetId!]!)).toBeNull();
    const locked = at('locked').state;
    expect(featuredTx(locked.bets[locked.focusBetId!]!)!.label).toBe('Lock transaction');
    expect(explorerTx(tx.signature)).toContain(tx.signature);
  });

  it('help lists every key', () => {
    const html = text(renderToString(<HelpOverlay onClose={() => {}} />));
    for (const [k, v] of KEYS) {
      expect(html).toContain(k);
      expect(html).toContain(v);
    }
  });

  it('health strip: an error first, REPLAY clips cached, the socket', () => {
    const html = text(
      renderToString(
        <HealthStrip
          health={null}
          error="demo health 404 (demo key or DEMO_MODE)"
          replays={initialReplays()}
          status="connecting"
        />,
      ),
    );
    expect(html.indexOf('demo health 404')).toBeLessThan(html.indexOf('REPLAY'));
    expect(html).toContain('0/6 cached');
    expect(html).toContain('hi warn');
    expect(html).toContain('connecting');
  });
});

describe('App from the URL', () => {
  const g = globalThis as { location?: unknown };
  const prev = g.location;
  afterEach(() => {
    g.location = prev;
  });

  it('?preview=<step> renders the stage with sample data, no connect form', () => {
    g.location = {
      search: '?preview=locked&nopreload',
      hash: '',
      origin: 'https://youre-on.fly.dev',
      href: 'https://youre-on.fly.dev/stage/?preview=locked',
    };
    const html = text(renderToString(<App />));
    expect(html).toContain('PREVIEW · sample data');
    expect(html).toContain('LOCKED');
    expect(html).toContain('Room</span> PREVIEW');
    expect(html).not.toContain('Stage key');
  });

  it('?room + #key prefill the form (the connect itself runs in an effect)', () => {
    g.location = {
      search: '?room=ABC234',
      hash: '#key=sk',
      origin: 'https://youre-on.fly.dev',
      href: 'https://youre-on.fly.dev/stage/?room=ABC234#key=sk',
    };
    const html = renderToString(<App />);
    expect(html).toContain('value="ABC234"');
    expect(html).toContain('placeholder="this server (https://youre-on.fly.dev)"');
  });
});
