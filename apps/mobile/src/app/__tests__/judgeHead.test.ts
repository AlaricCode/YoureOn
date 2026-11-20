import { describe, expect, it } from 'vitest';

import { fromSnapshot } from '../../bets/store';
import { COPY, fill, t } from '../../screens/copy';
import { checkCopy } from '../../ui/copyRule';
import { judgeHead, judgeHostLabel } from '../judgeHead';
import { snapshot } from './fixtures';

/** A's phone, its session live and the mic open, nobody talking, no wake gate. */
const host = {
  voice: true,
  hostsJudge: true,
  live: true,
  micMuted: false,
  speaking: false,
  wakeWaiting: false,
};
/** B's phone: no session of its own (live / micMuted are A's view; B never has them). */
const guest = { ...host, hostsJudge: false, live: false, micMuted: true };

describe("the negotiate screen's judge disc and line", () => {
  it("B's phone never listens: it says the judge is on A's phone", () => {
    expect(judgeHead(guest)).toEqual({ line: 'elsewhere', speaking: false, listening: false });
    // Whatever A's session is doing.
    expect(judgeHead({ ...guest, live: true, micMuted: false })).toMatchObject({
      line: 'elsewhere',
      listening: false,
    });
    expect(judgeHead({ ...guest, wakeWaiting: true }).line).toBe('elsewhere');
  });

  it("B's disc still lights up while the judge's captions show it speaking", () => {
    expect(judgeHead({ ...guest, speaking: true })).toEqual({
      line: 'speaking',
      speaking: true,
      listening: false,
    });
  });

  it("A's phone listens only while the session is live and the mic is open", () => {
    expect(judgeHead(host)).toEqual({ line: 'listening', speaking: false, listening: true });
    expect(judgeHead({ ...host, live: false, micMuted: true })).toEqual({
      line: 'connecting',
      speaking: false,
      listening: false,
    });
    expect(judgeHead({ ...host, micMuted: true })).toEqual({
      line: 'muted',
      speaking: false,
      listening: false,
    });
    expect(judgeHead({ ...host, speaking: true }).line).toBe('speaking');
  });

  it('A\'s phone waiting for "Jarvis" keeps the wake hint, never Listening or Connecting', () => {
    expect(judgeHead({ ...host, live: false, micMuted: true, wakeWaiting: true })).toEqual({
      line: 'wake',
      speaking: false,
      listening: false,
    });
  });

  it('no voice judge at all: the waiting labels, on both phones', () => {
    expect(judgeHead({ ...host, voice: false }).line).toBe('off');
    expect(judgeHead({ ...guest, voice: false })).toEqual({
      line: 'off',
      speaking: false,
      listening: false,
    });
  });
});

describe('"Judge on {name}\'s phone"', () => {
  it('names A as the call-off copy does, and follows the copy rule', () => {
    const b = fromSnapshot(snapshot({ state: 'DRAFTING' }));
    const label = judgeHostLabel(b);
    expect(label).toBe(b.party_a!.display_name.split(/\s+/)[0]);
    expect(fill.judgeOn(label)).toBe(`Judge on ${label}'s phone`);
    for (const text of [fill.judgeOn(label), fill.judgeOn('Sim A'), fill.judgeOn('')])
      expect(checkCopy(text, 'contract')).toEqual([]);
    expect(checkCopy(t(COPY.negotiate.connecting), 'label')).toEqual([]);
  });

  it('two players with one first name: A gets the initial ("Sim A")', () => {
    const b = fromSnapshot(snapshot({ state: 'DRAFTING' }));
    const sims = {
      ...b,
      party_a: { ...b.party_a!, display_name: 'Sim Alpha' },
      party_b: { ...b.party_b!, display_name: 'Sim Beta' },
    };
    expect(judgeHostLabel(sims)).toBe('Sim A');
  });

  it('no name for A yet: the invite\'s challenger, else "their phone"', () => {
    const b = fromSnapshot(snapshot({ state: 'DRAFTING' }));
    const unnamed = { ...b, party_a: null, envelope: null };
    expect(judgeHostLabel(unnamed)).toBe('');
    expect(fill.judgeOn(judgeHostLabel(unnamed))).toBe('Judge on their phone');
    const invited = { ...unnamed, challenger: { ...b.party_a!, display_name: 'Eva Santos' } };
    expect(judgeHostLabel(invited)).toBe('Eva');
  });
});
