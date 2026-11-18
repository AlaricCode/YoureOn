// youreon:// links (app.json scheme), so the stage QRs also work from the iPhone Camera app or
// a tapped link, and a simulator can be driven with `xcrun simctl openurl <udid> <url>`:
//   youreon://room/<CODE>          the room QR (API-CONTRACT §2.3 qr_payload) -> join the room
//   youreon://<word>/<yo_dc_...>   the demo-claim QR (§2.17)            -> the Demo account screen
// A demo claim replaces this phone's wallet with the demo account's, so a link never claims by
// itself: it only opens the Demo account screen with the code ready for an explicit tap.
// Pure TS: tested in node.
import {
  DemoClaimToken,
  ROOM_QR_PREFIX,
  demoClaimTokenFromQr,
  parseRoomCode,
} from '@youre-on/shared/api';

import type { Route } from './machine';

export type DeepLink = { kind: 'room'; code: string } | { kind: 'demoClaim'; token: string };

export function parseDeepLink(url: string | null | undefined): DeepLink | null {
  const s = url?.trim() ?? '';
  if (!/^youreon:\/\//i.test(s)) return null;
  if (s.toLowerCase().startsWith(ROOM_QR_PREFIX)) {
    const code = parseRoomCode(ROOM_QR_PREFIX + s.slice(ROOM_QR_PREFIX.length).toUpperCase());
    return code ? { kind: 'room', code } : null;
  }
  const token = demoClaimTokenFromQr(s);
  return token !== s && DemoClaimToken.safeParse(token).success
    ? { kind: 'demoClaim', token }
    : null;
}

/**
 * Whether a demo-claim token from a link is still wanted on this route. It lives only while the
 * Demo account screen is up: a claim closes that screen through the session listener (signed_in
 * sets the overlay to 'none'), so neither its Back nor its Done runs, and the next "Demo account"
 * from Profile used to open in link mode with the spent single-use token (no scanner, and "Use
 * this account" failed). 'boot' keeps it: a cold-start link arrives while the session restores.
 */
export const demoLinkLives = (route: Route): boolean => route === 'demoClaim' || route === 'boot';
