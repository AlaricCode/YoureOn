import { demoClaimQr, roomQrPayload } from '@youre-on/shared/api';
import { describe, expect, it } from 'vitest';

import { parseDeepLink } from '../deepLink';

const TOKEN = `yo_dc_${'A'.repeat(43)}`;

describe('parseDeepLink', () => {
  it('the room QR joins its room', () => {
    expect(parseDeepLink(roomQrPayload('UBC26X'))).toEqual({ kind: 'room', code: 'UBC26X' });
    expect(parseDeepLink('youreon://room/ubc26x')).toEqual({ kind: 'room', code: 'UBC26X' });
    expect(parseDeepLink(' youreon://room/CX8TWJ \n')).toEqual({ kind: 'room', code: 'CX8TWJ' });
  });

  it('a room link with a code that cannot exist is ignored', () => {
    expect(parseDeepLink('youreon://room/UBC0IX')).toBeNull(); // 0 and I are not in the alphabet
    expect(parseDeepLink('youreon://room/')).toBeNull();
    expect(parseDeepLink('youreon://room/TOOLONG7')).toBeNull();
  });

  it('the demo-claim QR opens the Demo account screen with its token', () => {
    expect(parseDeepLink(demoClaimQr('claim', TOKEN))).toEqual({ kind: 'demoClaim', token: TOKEN });
    expect(parseDeepLink(demoClaimQr('blue-fox', TOKEN))).toEqual({
      kind: 'demoClaim',
      token: TOKEN,
    });
  });

  it('anything else is ignored', () => {
    for (const url of [
      null,
      undefined,
      '',
      TOKEN, // a bare token is not a link
      'https://youre-on.fly.dev/room/UBC26X',
      'youreon://claim/not-a-token',
      `youreon://claim/${TOKEN}x`,
      'youreon://',
      'dev.youreon.app://room/UBC26X',
    ])
      expect(parseDeepLink(url), String(url)).toBeNull();
  });
});
