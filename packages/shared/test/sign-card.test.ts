import { describe, expect, it } from 'vitest';

import { renderSignCard } from '../src/sign-card';
import { card, createWorld } from './device-policy.fixtures';

describe('renderSignCard (the G2 card both server and phone render)', () => {
  it('matches the device-policy fixture card for B conceding an A_WINS ruling', async () => {
    const W = await createWorld();
    const appeal_deadline = Math.floor(Date.parse(card(W).countdown_ends_at) / 1000);
    const r = renderSignCard({
      kind: 'concede',
      terms: W.skill.terms,
      terms_hash: W.skill.terms_hash,
      me: 'B',
      appeal_deadline,
    });
    expect(r).toEqual(card(W));
  });

  it('appeal card and market odds', async () => {
    const W = await createWorld();
    const r = renderSignCard({
      kind: 'appeal',
      terms: W.skill.terms,
      terms_hash: W.skill.terms_hash,
      me: 'B',
      appeal_deadline: 1_800_000_000,
    });
    expect(r.title).toBe('Appeal');
    expect(r.odds_display).toBeNull();
    expect(r.countdown_ends_at).toBe(new Date(1_800_000_000_000).toISOString());
  });
});
