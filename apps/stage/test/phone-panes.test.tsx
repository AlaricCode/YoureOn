// Phone panes rendered (PhonePanes.tsx): each layout, the empty / ended slot, the cue badges,
// the status rail, the operator panel, and the help overlay's new keys.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperatorPanel, PhoneStage, type PhonePanes } from '../src/PhonePanes';
import { initialPanes, panesReducer, type PanesAction, type PanesState } from '../src/panes';
import { previewAt } from '../src/preview';
import { HelpOverlay } from '../src/view';

const { state: preview } = previewAt(0, 0, 'lock');
const bet = preview.bets[preview.focusBetId!]!;
const badge = { text: 'PREVIEW', cls: 'preview' };
const run = (actions: PanesAction[]) => actions.reduce(panesReducer, initialPanes());
const panesOf = (state: PanesState) => ({
  state,
  streams: new Map<number, MediaStream>(),
  clickSlot: () => undefined,
});
const STAGE = <div className="stage">the stage</div>;

describe('PhoneStage', () => {
  it('stage only: just the stage', () => {
    const html = renderToString(
      <PhoneStage panes={panesOf(initialPanes())} bet={bet} badge={badge} stage={STAGE} />,
    );
    expect(html).toBe('<div class="stage">the stage</div>');
  });

  it('phones + stage: A, the stage in the middle, B, named after the parties', () => {
    const s = run([{ type: 'layout', mode: 'flank' }]);
    const html = renderToString(
      <PhoneStage panes={panesOf(s)} bet={bet} badge={badge} stage={STAGE} />,
    );
    expect(html).toContain('phones-shell flank');
    expect(html.indexOf('phone phone-a')).toBeLessThan(html.indexOf('the stage'));
    expect(html.indexOf('the stage')).toBeLessThan(html.indexOf('phone phone-b'));
    expect(html).toContain(`>${bet.names.A}<`);
    expect(html).toContain(`>${bet.names.B}<`);
    expect(html).toContain('>No feed<');
    // nothing for the operator on the projected layout (O, the panel, stays off the screen)
    expect(html).not.toContain('press O');
    expect(html).not.toContain('operator');
    // the lock: whoever has not confirmed glows
    expect(html).toMatch(/cue-act/);
    expect(html).toContain('>confirm<');
  });

  it('phones big: the status rail instead of the stage, with the QR', () => {
    const { state } = previewAt(0, 0, 'ruling');
    const ruled = state.bets[state.focusBetId!]!;
    const s = run([{ type: 'layout', mode: 'big' }]);
    const html = renderToString(
      <PhoneStage panes={panesOf(s)} bet={ruled} badge={badge} stage={STAGE} />,
    );
    expect(html).toContain('phones-shell big');
    expect(html).not.toContain('the stage');
    expect(html).toContain('status-rail');
    expect(html).toContain('$10 pot');
    expect(html).toMatch(/wins<\/p>/);
    expect(html).toContain('SCAN · ');
    expect(html).toContain('>WINNER<');
    expect(html).toContain('>GG<');
  });

  it('no bet: Phone A / Phone B and the waiting line', () => {
    const s = run([{ type: 'layout', mode: 'big' }]);
    const html = renderToString(
      <PhoneStage panes={panesOf(s)} bet={null} badge={badge} stage={STAGE} />,
    );
    expect(html).toContain('>Phone A<');
    expect(html).toContain('>Phone B<');
    expect(html).toContain('Waiting for a challenge…');
  });

  it('an ended source says so on the phone', () => {
    const s = run([
      { type: 'layout', mode: 'flank' },
      { type: 'request', slot: 'B', kind: 'screen', req: 1 },
      { type: 'granted', req: 1, label: 'w' },
      { type: 'ended', req: 1 },
    ]);
    const html = renderToString(
      <PhoneStage panes={panesOf(s)} bet={bet} badge={badge} stage={STAGE} />,
    );
    expect(html).toContain('src-ended');
    expect(html).toContain('Source ended — click to pick again');
  });
});

describe('OperatorPanel', () => {
  it('per slot: the three sources, stop, crop; layout and swap on top', () => {
    const state = run([
      { type: 'operator', open: true },
      { type: 'request', slot: 'A', kind: 'test', req: 1 },
      { type: 'granted', req: 1, label: 'Test pattern' },
    ]);
    const noop = () => undefined;
    const panes: PhonePanes = {
      state,
      streams: new Map(),
      cameras: [{ deviceId: 'c1', label: 'FaceTime HD Camera' }],
      canScreen: true,
      canCamera: true,
      pick: noop,
      stop: noop,
      swap: noop,
      cycle: noop,
      setLayout: noop,
      setCrop: noop,
      toggleOperator: noop,
      clickSlot: noop,
    };
    const html = renderToString(<OperatorPanel panes={panes} bet={bet} />);
    for (const t of [
      'Window or screen',
      'Camera',
      'Test pattern',
      'Stop',
      'Trim 8%',
      'Swap A ⇄ B',
      'Phones + stage',
      'Phones big',
      'FaceTime HD Camera',
    ])
      expect(html).toContain(t);
    expect(html).toContain('● Test pattern');
    expect(html).toContain('No source');
  });
});

describe('help', () => {
  it('lists P and O', () => {
    const html = renderToString(<HelpOverlay onClose={() => undefined} />);
    expect(html).toContain('>P<');
    expect(html).toContain('>O<');
  });
});
