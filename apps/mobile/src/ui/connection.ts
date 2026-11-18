// The realtime connection's state, for the reconnect banner on every screen (TASKS D5-M2).
// net/ws.ts reports a WsStatus; whoever owns the realtime client passes it to
// `setConnectionStatus` (app/DemoApp.tsx, after the merge: one line next to its 'offline'
// dispatch). Screens read it through ui/parts Screen, so no screen needs a prop for it.
import { useSyncExternalStore } from 'react';

import type { WsStatus } from '../net/ws';

let status: WsStatus = 'idle';
const listeners = new Set<() => void>();

export function setConnectionStatus(next: WsStatus): void {
  if (next === status) return;
  status = next;
  for (const l of listeners) l();
}

export const getConnectionStatus = (): WsStatus => status;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** True while the socket is trying to come back (not on first connect, not when stopped). */
export function useReconnecting(): boolean {
  return useSyncExternalStore(subscribe, () => status === 'reconnecting');
}
