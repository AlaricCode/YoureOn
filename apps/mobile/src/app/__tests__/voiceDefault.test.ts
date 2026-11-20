// The live voice judge is off unless a build asks for it (DemoApp VOICE_ENABLED), and "Jarvis"
// works without it: what is said becomes the bet's terms. Source audit: DemoApp only runs on a
// device.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TYPED_STAKES_USD } from '../typedTerms';
import { saidStakeUsd } from '../wakeDance';

const MOBILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const app = readFileSync(resolve(MOBILE, 'src/app/DemoApp.tsx'), 'utf8');

describe('the voice judge', () => {
  it('is opt-in: only EXPO_PUBLIC_VOICE=on turns it on', () => {
    expect(app).toContain("const VOICE_ENABLED = process.env.EXPO_PUBLIC_VOICE === 'on';");
    expect(app).not.toContain("process.env.EXPO_PUBLIC_VOICE !== 'off'");
  });

  it('is said outright by every EAS profile that sets it, never left to the default', () => {
    const eas = JSON.parse(readFileSync(resolve(MOBILE, 'eas.json'), 'utf8')) as {
      build: Record<string, { env?: Record<string, string> }>;
    };
    for (const [name, profile] of Object.entries(eas.build)) {
      const voice = profile.env?.EXPO_PUBLIC_VOICE;
      if (voice !== undefined) expect(['on', 'off'], name).toContain(voice);
    }
  });
});

describe('"Jarvis" without the voice judge', () => {
  it('does not depend on the voice judge being on', () => {
    expect(app).toContain("const WAKE_ENABLED = process.env.EXPO_PUBLIC_WAKE !== 'off';");
    expect(app).not.toContain('const WAKE_ENABLED = VOICE_ENABLED &&');
  });

  it('sends what was said as the terms, from Home and from the form, and arms no judge', () => {
    // from Home: held for the challenge it started
    expect(app).toContain('if (VOICE_ENABLED) armJudge(r.bet.bet_id, held);');
    expect(app).toContain("else if (held.trim() !== '') saidBet.current = {");
    expect(app).toContain('void sayBet(bet.bet_id, said.text);');
    // on A's form
    expect(app).toContain('else void sayBet(sayPending, text);');
    expect(app).toContain('judgePending: judgePendingBet !== null || sayPendingBet !== null,');
  });

  it("uses the stake that was said, else the form's own", () => {
    expect(app).toContain(
      'saidStakeUsd(text, TYPED_STAKES_USD) ?? typedStakeFor(rematchStake) ?? DEFAULT_STAKE_USD',
    );
  });
});

describe('saidStakeUsd', () => {
  const stake = (text: string) => saidStakeUsd(text, TYPED_STAKES_USD);

  it('reads the stake however it was said', () => {
    expect(stake("I bet Eva can't make this shot for five bucks")).toBe(5);
    expect(stake('ten dollars says I land it')).toBe(10);
    expect(stake('bet you $20 you miss')).toBe(20);
    expect(stake('for a buck, bottle flip')).toBe(1);
  });

  it('is null when no stake was said, or not one the form offers', () => {
    expect(stake("I bet Eva can't do ten push ups")).toBeNull();
    expect(stake('best of 5')).toBeNull();
    expect(stake('for seven dollars')).toBeNull();
    expect(stake('for $500')).toBeNull();
    expect(stake('')).toBeNull();
  });
});
