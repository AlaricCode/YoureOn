import { describe, expect, it } from 'vitest';
import { audioCrossCheck, beaconOffsetMs, isImpactTag, scribeToSessionTime } from '../src/evidence/index.js';

describe('audio cross-check (§7.6)', () => {
  it('classifies impact tags', () => {
    expect(isImpactTag('impact')).toBe(true);
    expect(isImpactTag('Thud')).toBe(true);
    expect(isImpactTag('clap')).toBe(true);
    expect(isImpactTag('laughter')).toBe(false);
  });

  it('no impact tags anywhere ⇒ no disagreement', () => {
    const r = audioCrossCheck([{ type: 'disappears_into', frame: 40 }], [[{ type: 'laughter', at_ms: 4000 }], []]);
    expect(r.audio_disagree).toBe(false);
    expect(r.flag).toBe(0);
    expect(r.any_impact).toBe(false);
  });

  it('impact within ±500 ms of the frame interval agrees (boundaries)', () => {
    // frame 40 covers [4000, 4100); window [3500, 4600)
    for (const at of [3500, 4000, 4599]) {
      const r = audioCrossCheck([{ type: 'touches', frame: 40 }], [[{ type: 'thud', at_ms: at }]]);
      expect(r.audio_disagree, `at ${at}`).toBe(false);
      expect(r.events[0]!.witnesses).toEqual([0]);
    }
    for (const at of [3499, 4600]) {
      const r = audioCrossCheck([{ type: 'touches', frame: 40 }], [[{ type: 'thud', at_ms: at }]]);
      expect(r.audio_disagree, `at ${at}`).toBe(true);
      expect(r.flag).toBe(0b100);
    }
  });

  it('any witness suffices; released_by/crosses never set the flag', () => {
    const r = audioCrossCheck(
      [
        { type: 'disappears_into', frame: 10 },
        { type: 'crosses', frame: 90 },
        { type: 'released_by', frame: 70 },
        { type: 'enters', frame: 20 },
      ],
      [[], [{ type: 'impact', at_ms: 1200 }]],
    );
    expect(r.audio_disagree).toBe(false);
    expect(r.events.map((e) => e.type)).toEqual(['disappears_into', 'crosses', 'released_by']);
    expect(r.events[0]!.witnesses).toEqual([1]);
    expect(r.events[1]!.witnesses).toEqual([]);
  });

  it('maps device-local Scribe times to session time', () => {
    const t = scribeToSessionTime(
      { segments: [{ speaker: 's0', start_ms: 5000, end_ms: 6000, text: 'hi' }], events: [{ type: 'clap', at_ms: 7000 }] },
      3500,
    );
    expect(t.segments[0]).toEqual({ speaker: 's0', start_ms: 1500, end_ms: 2500, text: 'hi' });
    expect(t.events[0]).toEqual({ type: 'clap', at_ms: 3500 });
    expect(beaconOffsetMs(96000, 48000)).toBe(2000);
    expect(beaconOffsetMs(24000, 16000, 100)).toBe(1600);
  });
});
