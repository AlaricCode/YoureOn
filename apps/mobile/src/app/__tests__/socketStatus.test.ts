import { describe, expect, it } from 'vitest';

import type { WsStatus } from '../../net/ws';
import { getConnectionStatus, setConnectionStatus } from '../../ui/connection';
import { createSocketStatusHandler } from '../socketStatus';

function harness() {
  const offline: boolean[] = [];
  let lives = 0;
  const onStatus = createSocketStatusHandler({
    offline: (v) => offline.push(v),
    live: () => lives++,
  });
  return { onStatus, offline, lives: () => lives };
}

describe('the socket status in the app (DemoApp rt.onStatus)', () => {
  it('feeds the reconnect banner every screen shows (it was never fed: mid-bet screens stayed silent)', () => {
    setConnectionStatus('idle');
    const h = harness();
    h.onStatus('live');
    expect(getConnectionStatus()).toBe('live');
    h.onStatus('reconnecting');
    // ui/parts Screen shows "Reconnecting" on the terms card, live, ruling and payout too.
    expect(getConnectionStatus()).toBe('reconnecting');
    h.onStatus('stopped');
    expect(getConnectionStatus()).toBe('stopped');
  });

  it("home's offline flag: reconnecting or unauthorized; a judge-cam turn-off re-sent once live", () => {
    const h = harness();
    const seq: WsStatus[] = ['connecting', 'live', 'reconnecting', 'unauthorized', 'live'];
    seq.forEach(h.onStatus);
    expect(h.offline).toEqual([false, false, true, true, false]);
    expect(h.lives()).toBe(2);
  });
});
