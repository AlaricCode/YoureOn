// The app is universal: it runs natively on iPad (not as a scaled iPhone window). Three things
// in app.json make that true, and each has a way to go quietly wrong:
//   - ios.supportsTablet: the device family. false builds an iPhone-only binary.
//   - orientation "default": an iPad app that takes part in multitasking (Split View, Stage
//     Manager) must support all four orientations; "portrait" here would need
//     ios.requireFullScreen as well, and the judge cam on a tripod is used on its side anyway.
//   - no ios.requireFullScreen: nothing in the app needs the whole screen to itself, and the
//     layout holds its phone-width column in any window size (ui/column).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = (
  JSON.parse(readFileSync(resolve(APP_ROOT, 'app.json'), 'utf8')) as {
    expo: {
      orientation?: string;
      ios: { supportsTablet?: boolean; requireFullScreen?: boolean };
    };
  }
).expo;

describe('app.json: a universal (iPhone + iPad) app', () => {
  it('builds for iPad as well as iPhone', () => {
    expect(app.ios.supportsTablet).toBe(true);
  });

  it('supports every orientation and does not demand the full screen', () => {
    expect(app.orientation).toBe('default');
    expect(app.ios.requireFullScreen ?? false).toBe(false);
  });
});
