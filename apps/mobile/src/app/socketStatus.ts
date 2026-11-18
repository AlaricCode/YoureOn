// What a realtime status change does in the app (DemoApp's rt.onStatus):
//   - the reconnect banner every screen shows (ui/connection, read by ui/parts Screen). Nothing
//     fed it after the UI-polish merge, so only home (its own `offline` prop) ever said
//     "Reconnecting"; the terms card, live, ruling and payout screens stayed silent;
//   - home's offline flag (reconnecting or unauthorized);
//   - a judge-cam turn-off the server never confirmed is re-sent once the socket is live.
// Pure TS: tested in node.
import type { WsStatus } from '../net/ws';
import { setConnectionStatus } from '../ui/connection';

export interface SocketStatusSinks {
  offline(offline: boolean): void;
  live(): void;
}

export const isOfflineStatus = (s: WsStatus): boolean =>
  s === 'reconnecting' || s === 'unauthorized';

export function createSocketStatusHandler(d: SocketStatusSinks): (s: WsStatus) => void {
  return (s) => {
    setConnectionStatus(s);
    d.offline(isOfflineStatus(s));
    if (s === 'live') d.live();
  };
}
