// The round-trip-compensated offset the two-phone Dance Off maps go_at with (../clockProbe).
import { describe, expect, it } from 'vitest';

import {
  bestOffset,
  healthServerMs,
  PROBE_MAX_RTT_MS,
  probeServerOffset,
  type ClockSample,
} from '../clockProbe';
import type { FetchLike } from '../signedFetch';

describe('bestOffset', () => {
  it('keeps the minimum round trip and takes its midpoint', () => {
    // The true offset is +1000 ms. Sample 1: slow uplink (300 ms out, 20 back); sample 2: 20/20.
    const samples: ClockSample[] = [
      { sentAt: 0, receivedAt: 320, serverMs: 1_300 },
      { sentAt: 1_000, receivedAt: 1_040, serverMs: 2_020 },
    ];
    expect(bestOffset(samples)).toEqual({ offsetMs: 1_000, rttMs: 40 });
    // Taken one way (server_time − received, as Clock.sync does), both would say 980.
  });

  it('skips unusable samples', () => {
    expect(bestOffset([])).toBeNull();
    expect(
      bestOffset([
        { sentAt: 10, receivedAt: 5, serverMs: 100 },
        { sentAt: 0, receivedAt: PROBE_MAX_RTT_MS + 1, serverMs: 100 },
        { sentAt: 0, receivedAt: 10, serverMs: Number.NaN },
      ]),
    ).toBeNull();
  });
});

describe('probeServerOffset', () => {
  it('probes GET /health and estimates the offset within half the best round trip', async () => {
    let clock = 0;
    const trueOffset = 12_345;
    const legs = [
      [400, 30],
      [25, 25],
      [80, 10],
    ];
    let i = 0;
    const urls: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      urls.push(`${init.method} ${url}`);
      const [up, down] = legs[i++ % legs.length]!;
      clock += up!;
      const server = clock + trueOffset;
      clock += down!;
      return {
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: true, server_time: new Date(server).toISOString() }),
      };
    };
    const est = await probeServerOffset({
      baseUrl: 'https://yo.example/',
      fetch,
      now: () => clock,
      count: 3,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(urls).toEqual(Array(3).fill('GET https://yo.example/health'));
    expect(est).toEqual({ offsetMs: trueOffset, rttMs: 50 });
  });

  it('is null when nothing answers', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('offline');
    };
    expect(
      await probeServerOffset({ baseUrl: 'https://x', fetch, count: 2, sleep: async () => {} }),
    ).toBeNull();
  });

  it('reads server_time from a health body', () => {
    expect(healthServerMs('{"server_time":"2026-11-21T18:07:00.123Z"}')).toBe(
      Date.parse('2026-11-21T18:07:00.123Z'),
    );
    expect(healthServerMs('{"server_time":5}')).toBeNull();
    expect(healthServerMs('nope')).toBeNull();
  });
});
