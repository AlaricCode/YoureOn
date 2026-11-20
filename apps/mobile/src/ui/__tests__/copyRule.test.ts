import { describe, expect, it } from 'vitest';

import {
  assertCopy,
  checkCopy,
  checkScreenCopy,
  CONTRACT_COPY,
  countWords,
  isContractCopy,
  isCopyOk,
  type ScreenText,
} from '../copyRule';

const rules = (text: string, role?: Parameters<typeof checkCopy>[1]) =>
  checkCopy(text, role).map((v) => v.rule);

describe('labels and errors (spec §6.3)', () => {
  it('accepts 1-3 word labels, including the spec labels', () => {
    for (const l of [
      'Decline',
      'View terms',
      'Hold to confirm',
      'I appeal!',
      'GG',
      'Run it back',
      'Locking…',
      'Face not matched',
      'Logan is in',
    ])
      expect(checkCopy(l), l).toEqual([]);
  });

  it('rejects labels over 3 words', () => {
    expect(rules('Hold here to confirm')).toContain('too_many_words');
    expect(rules('Tap below to lock in your bet', 'error')).toContain('too_many_words');
  });

  it('rejects a trailing period and sentence copy', () => {
    expect(rules('Done.')).toEqual(['trailing_period']);
    expect(rules('Locked. Good luck')).toContain('sentence');
    expect(rules('Face not matched.', 'error')).toContain('trailing_period');
  });

  it('rejects blank copy except for data', () => {
    expect(rules('  ')).toEqual(['empty']);
    expect(checkCopy('', 'data')).toEqual([]);
  });

  it('counts words on whitespace runs', () => {
    expect(countWords('  Hold   to\tconfirm ')).toBe(3);
    expect(countWords('')).toBe(0);
  });
});

describe('emoji (spec §6.4): banned for every role', () => {
  it.each(['Nice 🔥', 'Win 🏆', '✅ Done', '⭐', 'GG ❤️', '1️⃣'])('%s', (text) => {
    for (const role of ['label', 'error', 'data', 'contract'] as const)
      expect(rules(text, role)).toContain('emoji');
  });

  it('keeps ordinary punctuation: ellipsis, dollar, minus sign, apostrophes', () => {
    expect(checkCopy('Locking…')).toEqual([]);
    expect(checkCopy('$6.20 / $3.80', 'data')).toEqual([]);
    expect(checkCopy('You’re 4-7 against Jake (−$7.00)', 'contract')).toEqual([]);
  });
});

describe('crypto-copy audit (TASKS D5-M2)', () => {
  it.each([
    'Pay 0.01 SOL',
    'Gas fee',
    'Seed phrase',
    'Wallet address',
    'Transaction sent',
    'USDC balance',
    'On Solana',
    'Lamports',
  ])('%s', (text) => {
    expect(rules(text)).toContain('crypto_jargon');
  });

  it('bans base58 addresses for every role, data included', () => {
    const addr = 'E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4';
    expect(rules(addr, 'data')).toContain('address');
    expect(rules(`Pay ${addr}`)).toContain('address');
  });

  it('allows the 8-hex terms code and user claims that mention jargon words as data', () => {
    expect(checkCopy('05860f0a', 'data')).toEqual([]);
    expect(checkCopy('Jake fills the gas tank in 5 minutes', 'data')).toEqual([]);
    expect(checkCopy('Solo')).toEqual([]);
  });
});

describe('contract copy (our specs win over the word limit)', () => {
  it('accepts every mandated string, filled in', () => {
    for (const text of [
      "Something's off. Not signing.",
      "You're in. Waiting for Jake…",
      'Nothing moves until you both lock in',
      'Your $5 is held until Jake locks in',
      'Your $6.20 is held until Zoë locks in',
      "You're 4-7 against Jake",
      "You're 4-7 against Jake (−$7.00)",
    ]) {
      expect(isContractCopy(text), text).toBe(true);
      expect(checkCopy(text, 'contract'), text).toEqual([]);
    }
    expect(CONTRACT_COPY.length).toBeGreaterThanOrEqual(6);
  });

  it('the same strings fail as plain labels, and invented sentences fail as contract copy', () => {
    expect(isCopyOk("Something's off. Not signing.")).toBe(false);
    expect(rules('Tap and hold to lock in your stake', 'contract')).toEqual(['not_contract_copy']);
    expect(rules("Something's off. Signing anyway.", 'contract')).toEqual(['not_contract_copy']);
  });

  it('jargon still applies to contract copy templates', () => {
    expect(isContractCopy('Your $5 is held until Jake locks in')).toBe(true);
    expect(rules('Your $5 is held until SOL locks in', 'contract')).toContain('crypto_jargon');
  });
});

describe('assertCopy', () => {
  it('throws with each violation', () => {
    expect(() => assertCopy('Tap here to see more 🔥.')).toThrow(
      /emoji.*too_many_words.*trailing_period/,
    );
    expect(() => assertCopy('Lock in')).not.toThrow();
  });
});

describe('checkScreenCopy (rule 2: nothing smaller directly below a label)', () => {
  const label = (text: string, y: number, fontSize = 15): ScreenText => ({
    text,
    role: 'label',
    fontSize,
    rect: { x: 24, y, width: 200, height: 24 },
  });

  it('flags a caption under a label', () => {
    const v = checkScreenCopy([
      label('Balance', 100),
      {
        text: 'Updated 2m ago',
        role: 'data',
        fontSize: 13,
        rect: { x: 24, y: 128, width: 120, height: 16 },
      },
    ]);
    expect(v).toEqual([
      expect.objectContaining({ rule: 'helper_below_label', text: 'Updated 2m ago' }),
    ]);
  });

  it('allows same-size rows, text far below, side-by-side values, and data above data', () => {
    expect(
      checkScreenCopy([
        label('Balance', 100),
        label('New bet', 128),
        {
          text: '$12.40',
          role: 'data',
          fontSize: 15,
          rect: { x: 240, y: 100, width: 80, height: 24 },
        },
        {
          text: 'Jake',
          role: 'data',
          fontSize: 17,
          rect: { x: 24, y: 300, width: 100, height: 24 },
        },
        {
          text: '$5 each',
          role: 'data',
          fontSize: 13,
          rect: { x: 24, y: 326, width: 100, height: 16 },
        },
        {
          text: 'Footer',
          role: 'label',
          fontSize: 13,
          rect: { x: 24, y: 200, width: 100, height: 16 },
        },
      ]),
    ).toEqual([]);
  });

  it('also reports per-string violations', () => {
    expect(checkScreenCopy([label('Tap to see your bets', 0)]).map((v) => v.rule)).toEqual([
      'too_many_words',
    ]);
  });
});

describe('body copy (a step explanation, enroll redesign)', () => {
  it('may be a sentence', () => {
    expect(
      checkCopy(
        'Follow the prompts on the camera. Use good light and keep your face centered.',
        'body',
      ),
    ).toEqual([]);
  });

  it('still gets the emoji and jargon checks', () => {
    expect(rules('Your face never goes on Solana.', 'body')).toContain('crypto_jargon');
    expect(rules('Smile \u{1F600}', 'body')).toContain('emoji');
  });

  it('may sit directly under a label', () => {
    const items: ScreenText[] = [
      {
        text: 'Register face',
        role: 'label',
        fontSize: 22,
        rect: { x: 24, y: 80, width: 200, height: 32 },
      },
      {
        text: 'Follow the prompts on the camera.',
        role: 'body',
        fontSize: 15,
        rect: { x: 24, y: 116, width: 320, height: 22 },
      },
    ];
    expect(checkScreenCopy(items)).toEqual([]);
  });
});
