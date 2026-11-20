import { describe, expect, it } from 'vitest';

import {
  createWakeDetector,
  DEFAULT_WAKE_TIMING,
  type TranscriptInput,
  type UtteranceReason,
  type WakeEvent,
} from '../detector';

const T = (text: string, segment = 0, isFinal = false): TranscriptInput => ({
  text,
  isFinal,
  segment,
});

const utterance = (text: string, reason: UtteranceReason): WakeEvent[] => [
  { type: 'utterance', text, reason },
];

describe('wake detector', () => {
  it('uses the planned timing by default', () => {
    expect(DEFAULT_WAKE_TIMING).toMatchObject({
      endSilenceMs: 1300,
      maxUtteranceMs: 9000,
      noTailTimeoutMs: 4000,
    });
  });

  it('ignores everything before the wake word', () => {
    const d = createWakeDetector();
    expect(d.feed(T('I bet you can not'), 0)).toEqual([]);
    expect(d.feed(T('I bet you can not do it', 1), 500)).toEqual([]);
    expect(d.tick(60_000)).toEqual([]);
    expect(d.phase).toBe('idle');
    expect(d.partial).toBe('');
  });

  it('wakes once, then ends the challenge after the silence', () => {
    const d = createWakeDetector();
    expect(d.feed(T('hey Jarvis'), 0)).toEqual([{ type: 'wake' }]);
    expect(d.phase).toBe('capturing');
    expect(d.feed(T('hey Jarvis I bet'), 300)).toEqual([]);
    expect(d.feed(T('hey Jarvis I bet Mo'), 600)).toEqual([]);
    expect(d.partial).toBe('I bet Mo');
    expect(d.tick(1800)).toEqual([]);
    expect(d.tick(1900)).toEqual(utterance('I bet Mo', 'silence'));
    expect(d.phase).toBe('done');
    // Done: nothing more until reset, even "Jarvis" again.
    expect(d.feed(T('hey Jarvis I bet Mo. Jarvis'), 2000)).toEqual([]);
    expect(d.tick(10_000)).toEqual([]);
  });

  it('does not wake twice in one capture', () => {
    const d = createWakeDetector();
    expect(d.feed(T('Jarvis'), 0)).toEqual([{ type: 'wake' }]);
    expect(d.feed(T('Jarvis Jarvis'), 200)).toEqual([]);
    expect(d.feed(T('Jarvis Jarvis go'), 400)).toEqual([]);
    expect(d.partial).toBe('go');
  });

  it('re-punctuating or re-casing the same words does not hold the capture open', () => {
    const d = createWakeDetector();
    d.feed(T('jarvis i bet mo'), 0);
    expect(d.feed(T('Jarvis, I bet Mo.'), 1000)).toEqual([]);
    expect(d.tick(1300)).toEqual(utterance('I bet Mo.', 'silence'));
  });

  it('a final result after a pause ends the challenge at once', () => {
    const d = createWakeDetector();
    expect(d.feed(T('Jarvis I bet Mo'), 0)).toEqual([{ type: 'wake' }]);
    expect(d.feed(T('Jarvis, I bet Mo.', 0, true), 700)).toEqual(utterance('I bet Mo.', 'final'));
  });

  it('a final result while still talking (a native restart) waits for the next segment', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis I bet'), 0);
    expect(d.feed(T('Jarvis I bet Mo', 0, true), 200)).toEqual([]);
    expect(d.feed(T("can't do ten", 1), 600)).toEqual([]);
    expect(d.partial).toBe("I bet Mo can't do ten");
    expect(d.tick(1800)).toEqual([]);
    expect(d.tick(1900)).toEqual(utterance("I bet Mo can't do ten", 'silence'));
  });

  it('the wake word and a final in one event still waits for the silence', () => {
    const d = createWakeDetector();
    expect(d.feed(T('Jarvis I bet Mo', 0, true), 0)).toEqual([{ type: 'wake' }]);
    expect(d.tick(1299)).toEqual([]);
    expect(d.tick(1300)).toEqual(utterance('I bet Mo', 'silence'));
  });

  it('caps the challenge at maxUtteranceMs from the wake', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis'), 0);
    let n = 0;
    for (let t = 500; t < 9000; t += 500) {
      n++;
      expect(d.feed(T(`Jarvis ${'go '.repeat(n)}`), t)).toEqual([]);
    }
    expect(d.tick(8999)).toEqual([]);
    expect(d.tick(9000)).toEqual(utterance(Array(n).fill('go').join(' '), 'max'));
  });

  it('only "Jarvis": an empty challenge after noTailTimeoutMs', () => {
    const d = createWakeDetector();
    expect(d.feed(T('Hey Jarvis'), 0)).toEqual([{ type: 'wake' }]);
    // The silence rule is for a challenge; an empty tail waits longer.
    expect(d.tick(1300)).toEqual([]);
    // Fillers after the wake word are not a challenge and do not restart the wait.
    expect(d.feed(T('Hey Jarvis um'), 1000)).toEqual([]);
    expect(d.tick(3999)).toEqual([]);
    expect(d.tick(4000)).toEqual(utterance('', 'no_tail'));
  });

  it('a final with nothing after the wake word keeps waiting', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis', 0, true), 0);
    expect(d.phase).toBe('capturing');
    expect(d.tick(4000)).toEqual(utterance('', 'no_tail'));
  });

  it('a challenge that starts after a pause', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis'), 0);
    expect(d.feed(T('Jarvis bet Sam'), 2500)).toEqual([]);
    expect(d.tick(3799)).toEqual([]);
    expect(d.tick(3800)).toEqual(utterance('bet Sam', 'silence'));
  });

  it('segment rollover: the wake in one task, the challenge in the next', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis', 3), 0);
    expect(d.feed(T('um I bet Mo', 4), 800)).toEqual([]);
    expect(d.partial).toBe('I bet Mo');
    expect(d.tick(2100)).toEqual(utterance('I bet Mo', 'silence'));
  });

  it('segment rollover keeps every earlier segment', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis I bet'), 0);
    d.feed(T('Mo', 1), 300);
    d.feed(T("can't", 2), 600);
    d.feed(T("can't do ten", 2), 900);
    expect(d.tick(2200)).toEqual(utterance("I bet Mo can't do ten", 'silence'));
  });

  it('"Jarvis" said again in a later segment starts the challenge over', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis I bet'), 0);
    expect(d.feed(T('no wait Jarvis, Mo owes me', 1), 500)).toEqual([]);
    expect(d.tick(1800)).toEqual(utterance('Mo owes me', 'silence'));
  });

  it('ignores a late event from an older segment', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis I bet', 0), 0);
    d.feed(T('Mo', 1), 300);
    expect(d.feed(T('Jarvis I bet something else entirely', 0), 400)).toEqual([]);
    expect(d.partial).toBe('I bet Mo');
  });

  it('the recognizer revising the wake word away keeps the challenge', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis I bet'), 0);
    // New words, but no wake word any more: still talking, tail unchanged.
    expect(d.feed(T('Service I bet Mo'), 1000)).toEqual([]);
    expect(d.partial).toBe('I bet');
    expect(d.tick(2299)).toEqual([]);
    expect(d.tick(2300)).toEqual(utterance('I bet', 'silence'));
  });

  it('the recognizer restarting its text in the same task keeps both halves', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis I bet Mo'), 0);
    // Same segment, but the text started over after a pause: the old tail is not in it.
    expect(d.feed(T("can't do ten"), 800)).toEqual([]);
    expect(d.partial).toBe("I bet Mo can't do ten");
    // Later events of that task keep growing the new half.
    expect(d.feed(T("can't do ten pushups"), 1200)).toEqual([]);
    expect(d.partial).toBe("I bet Mo can't do ten pushups");
    expect(d.tick(2499)).toEqual([]);
    expect(d.tick(2500)).toEqual(utterance("I bet Mo can't do ten pushups", 'silence'));
  });

  it('a revision only counts whole words of the tail', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis go'), 0);
    // "go" only as part of "going": a restarted text, not a revision.
    expect(d.feed(T('going home'), 500)).toEqual([]);
    expect(d.partial).toBe('go going home');
  });

  it('a misheard wake word works like the real one', () => {
    const d = createWakeDetector();
    expect(d.feed(T('Jervis, race me to the door'), 0)).toEqual([{ type: 'wake' }]);
    expect(d.tick(1300)).toEqual(utterance('race me to the door', 'silence'));
  });

  it('names that sound alike never wake it', () => {
    const d = createWakeDetector();
    expect(d.feed(T('Travis said Davis has great customer service'), 0)).toEqual([]);
    expect(d.phase).toBe('idle');
  });

  it('reset() re-arms', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis go'), 0);
    d.tick(2000);
    expect(d.phase).toBe('done');
    d.reset();
    expect(d.phase).toBe('idle');
    // A fresh native session numbers its segments from scratch.
    expect(d.feed(T('Jarvis again', 0), 3000)).toEqual([{ type: 'wake' }]);
  });

  it('reset({skipThroughSegment}) ignores the task that still holds the old "Jarvis"', () => {
    const d = createWakeDetector();
    d.feed(T('Jarvis I bet', 2), 0);
    d.reset({ skipThroughSegment: 2 });
    expect(d.feed(T('Jarvis I bet Mo', 2), 100)).toEqual([]);
    expect(d.phase).toBe('idle');
    expect(d.feed(T('Jarvis go', 3), 200)).toEqual([{ type: 'wake' }]);
  });

  it('takes custom timing', () => {
    const d = createWakeDetector({ endSilenceMs: 500, noTailTimeoutMs: 1000 });
    d.feed(T('Jarvis go'), 0);
    expect(d.tick(500)).toEqual(utterance('go', 'silence'));
    d.reset();
    d.feed(T('Jarvis'), 0);
    expect(d.tick(1000)).toEqual(utterance('', 'no_tail'));
  });

  it('wake and an immediate endpoint can come from the same feed', () => {
    const d = createWakeDetector({ maxUtteranceMs: 0 });
    expect(d.feed(T('Jarvis go'), 0)).toEqual([
      { type: 'wake' },
      { type: 'utterance', text: 'go', reason: 'max' },
    ]);
  });

  // In a loud room the recognizer writes "a" for the breath after "Jarvis". Ending the capture
  // on that sent the judge "a" as the whole challenge.
  describe('a tail that is not a challenge yet ("a")', () => {
    it('does not end on the short silence: the real sentence still gets heard', () => {
      const d = createWakeDetector();
      expect(d.feed(T('Jarvis'), 0)).toEqual([{ type: 'wake' }]);
      expect(d.feed(T('Jarvis a'), 300)).toEqual([]);
      // 1.3 s of nothing new used to end it here, with "a"
      expect(d.tick(1700)).toEqual([]);
      expect(d.tick(2500)).toEqual([]);
      expect(d.phase).toBe('capturing');
      expect(d.feed(T('Jarvis a dance off against Eva'), 2800)).toEqual([]);
      expect(d.tick(4000)).toEqual([]);
      expect(d.tick(4100)).toEqual(utterance('a dance off against Eva', 'silence'));
    });

    it('is nothing said when that is all there ever was, never "a"', () => {
      const d = createWakeDetector();
      d.feed(T('Jarvis'), 0);
      d.feed(T('Jarvis a'), 300);
      expect(d.tick(4200)).toEqual([]);
      expect(d.tick(4300)).toEqual(utterance('', 'no_tail'));
      expect(d.phase).toBe('done');
    });

    it('is not ended by a final result either', () => {
      const d = createWakeDetector();
      d.feed(T('Jarvis'), 0);
      d.feed(T('Jarvis the'), 300);
      expect(d.feed(T('Jarvis the', 0, true), 1000)).toEqual([]);
      expect(d.phase).toBe('capturing');
      // a new task brings the challenge; the stub is not kept in front of it
      expect(d.feed(T('I bet Mo misses', 1), 1500)).toEqual([]);
      expect(d.tick(2900)).toEqual(utterance('I bet Mo misses', 'silence'));
    });

    it('still ends at the hard cap, with nothing', () => {
      const d = createWakeDetector({ noTailTimeoutMs: 60_000 });
      d.feed(T('Jarvis'), 0);
      d.feed(T('Jarvis a'), 300);
      expect(d.tick(8999)).toEqual([]);
      expect(d.tick(9000)).toEqual(utterance('', 'no_tail'));
    });

    it('leaves a short real answer alone: a name, one word', () => {
      for (const said of ['Mo', 'Eva', 'scan']) {
        const d = createWakeDetector();
        d.feed(T('Jarvis'), 0);
        d.feed(T(`Jarvis ${said}`), 300);
        expect(d.tick(1500)).toEqual([]);
        expect(d.tick(1600)).toEqual(utterance(said, 'silence'));
      }
    });
  });

  // "Tap to talk" with no voice judge: the tap starts the capture, no wake word needed.
  describe('arm (tap to talk)', () => {
    it('captures what is said after the tap, skipping what the task had heard before it', () => {
      const d = createWakeDetector();
      expect(d.feed(T('so anyway we were talking'), 0)).toEqual([]);
      expect(d.arm(1000)).toEqual([{ type: 'wake' }]);
      expect(d.phase).toBe('capturing');
      expect(d.partial).toBe('');
      // the running task's text still starts with the old words
      expect(d.feed(T('so anyway we were talking I bet'), 1400)).toEqual([]);
      expect(d.feed(T('so anyway we were talking I bet Mo misses'), 1800)).toEqual([]);
      expect(d.partial).toBe('I bet Mo misses');
      expect(d.tick(3000)).toEqual([]);
      expect(d.tick(3200)).toEqual(utterance('I bet Mo misses', 'silence'));
    });

    it('works before anything was heard, and across a new recognition task', () => {
      const d = createWakeDetector();
      expect(d.arm(0)).toEqual([{ type: 'wake' }]);
      expect(d.feed(T('I bet Mo'), 300)).toEqual([]);
      expect(d.feed(T("can't do ten", 1), 800)).toEqual([]);
      expect(d.tick(2200)).toEqual(utterance("I bet Mo can't do ten", 'silence'));
    });

    it('is nothing said when nobody speaks after the tap', () => {
      const d = createWakeDetector();
      d.feed(T('background chatter'), 0);
      d.arm(500);
      expect(d.feed(T('background chatter'), 900)).toEqual([]);
      expect(d.tick(4400)).toEqual([]);
      expect(d.tick(4600)).toEqual(utterance('', 'no_tail'));
    });

    it('still takes "Jarvis, ..." said after the tap as the start of the challenge', () => {
      const d = createWakeDetector();
      d.feed(T('hello there'), 0);
      d.arm(500);
      expect(d.feed(T('hello there Jarvis I bet Mo misses'), 1200)).toEqual([]);
      expect(d.partial).toBe('I bet Mo misses');
    });

    it('does nothing while a capture is already running or after it is done', () => {
      const d = createWakeDetector();
      d.feed(T('Jarvis go'), 0);
      expect(d.arm(100)).toEqual([]);
      expect(d.partial).toBe('go');
      d.tick(5000);
      expect(d.phase).toBe('done');
      expect(d.arm(6000)).toEqual([]);
    });
  });
});
