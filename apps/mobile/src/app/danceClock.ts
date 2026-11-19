// The clock offset the two-phone Dance Off maps go_at with (../dance/model/schedule): a
// round-trip-compensated probe of the server clock (../net/clockProbe), taken once per bet when
// this phone enters a dance screen (the recorder or the display), so both phones' t0 agree to
// within each probe's rtt / 2 instead of each phone's last one-way Clock sample. Until the probe
// answers (or when it cannot: offline, an old server), the app Clock's offset.
import { useEffect, useState } from 'react';

import { probeServerOffset } from '../net/clockProbe';
import type { FetchLike } from '../net/signedFetch';

const plainFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

export function useDanceClockOffset(p: {
  /** This phone is on a dance screen (dance or danceDisplay). */
  active: boolean;
  /** The bet: one probe per bet. */
  betId: string | null;
  baseUrl: string;
  /** The app Clock's offsetMs. */
  fallbackMs: number;
}): number {
  const [probed, setProbed] = useState<{ betId: string; offsetMs: number } | null>(null);
  const { active, betId, baseUrl } = p;
  const have = probed !== null && probed.betId === betId;
  useEffect(() => {
    if (!active || betId === null || have) return;
    let live = true;
    void probeServerOffset({ baseUrl, fetch: plainFetch }).then((est) => {
      if (live && est) setProbed({ betId, offsetMs: est.offsetMs });
    });
    return () => {
      live = false;
    };
  }, [active, betId, baseUrl, have]);
  return have ? probed.offsetMs : p.fallbackMs;
}
