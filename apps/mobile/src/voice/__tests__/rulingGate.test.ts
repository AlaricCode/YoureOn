// ../gg: the voice host's mic opens in RULED only once the judge has said the ruling, and only
// for a decisive camera ruling (session.ts micMutedFor + ./rulingGate).
import { describe, expect, it } from 'vitest';

import { BetState } from '@youre-on/shared/bet-state';

import { createRulingGate, RULING_SPOKEN_FALLBACK_MS } from '../rulingGate';
import { micMutedFor } from '../session';

function fakeTimers() {
  let t = 0;
  let next = 1;
  const due = new Map<number, { at: number; f: () => void }>();
  return {
    setTimeout: (f: () => void, ms: number) => {
      const id = next++;
      due.set(id, { at: t + ms, f });
      return id;
    },
    clearTimeout: (h: unknown) => void due.delete(h as number),
    advance(ms: number) {
      t += ms;
      for (const [id, d] of [...due]) {
        if (d.at <= t) {
          due.delete(id);
          d.f();
        }
      }
    },
    pending: () => due.size,
  };
}

const setup = () => {
  const timers = fakeTimers();
  const seen: boolean[] = [];
  const gate = createRulingGate({ onChange: (v) => seen.push(v), timers });
  return { timers, seen, gate };
};

describe('ruling gate', () => {
  it('opens after the judge speaks the ruling and goes back to listening', () => {
    const { gate, seen, timers } = setup();
    gate.onMode('speaking'); // before the cue: ignored
    gate.onMode('listening');
    expect(seen).toEqual([]);
    gate.onCue('RULING');
    gate.onMode('listening'); // not after a speaking turn yet
    expect(seen).toEqual([]);
    gate.onMode('speaking');
    gate.onMode('listening');
    expect(seen).toEqual([true]);
    expect(gate.spoken()).toBe(true);
    expect(timers.pending()).toBe(0); // the fallback is cancelled
    gate.onMode('speaking');
    gate.onMode('listening');
    expect(seen).toEqual([true]); // once
  });

  it('falls back after RULING_SPOKEN_FALLBACK_MS when no mode change comes', () => {
    const { gate, seen, timers } = setup();
    gate.onCue('RULING');
    timers.advance(RULING_SPOKEN_FALLBACK_MS - 1);
    expect(seen).toEqual([]);
    timers.advance(1);
    expect(seen).toEqual([true]);
  });

  it('other cues do nothing; a new RULING (after a REDO) arms it again', () => {
    const { gate, seen, timers } = setup();
    gate.onCue('LOCKED');
    gate.onCue('REDO');
    timers.advance(RULING_SPOKEN_FALLBACK_MS * 2);
    expect(seen).toEqual([]);
    gate.onCue('RULING');
    timers.advance(RULING_SPOKEN_FALLBACK_MS);
    gate.onCue('RULING');
    expect(seen).toEqual([true, false]);
    gate.onMode('speaking');
    gate.onMode('listening');
    expect(seen).toEqual([true, false, true]);
  });

  it('stop() cancels a pending fallback', () => {
    const { gate, seen, timers } = setup();
    gate.onCue('RULING');
    gate.stop();
    timers.advance(RULING_SPOKEN_FALLBACK_MS);
    gate.onMode('speaking');
    gate.onMode('listening');
    expect(seen).toEqual([]);
  });
});

describe('micMutedFor with the RULED review gate', () => {
  it('RULED opens only when reviewable AND the ruling was spoken', () => {
    expect(micMutedFor('RULED', { reviewable: true, rulingSpoken: true })).toBe(false);
    expect(micMutedFor('RULED', { reviewable: true, rulingSpoken: false })).toBe(true);
    expect(micMutedFor('RULED', { reviewable: false, rulingSpoken: true })).toBe(true);
    expect(micMutedFor('RULED')).toBe(true);
  });

  it('changes no other state', () => {
    const o = { reviewable: true, rulingSpoken: true };
    for (const s of BetState.options)
      if (s !== 'RULED') expect([s, micMutedFor(s, o)]).toEqual([s, micMutedFor(s)]);
  });

  it('a reviewable skill bet toggles twice more: on after the ruling line, off when it moves on', () => {
    const path = ['JUDGING', 'RULED', 'RULED', 'CONCEDED', 'PAID'] as const;
    const spoken = [false, false, true, true, true];
    const muted = path.map((s, i) =>
      micMutedFor(s, { reviewable: true, rulingSpoken: spoken[i]! }),
    );
    expect(muted).toEqual([true, true, false, true, true]);
  });
});
