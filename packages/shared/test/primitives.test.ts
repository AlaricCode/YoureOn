import { describe, expect, it } from 'vitest';
import {
  BetId,
  betIdToBytes,
  bytesToBetId,
  DisplayName,
  formatUsd,
  fromMicro,
  Hex32,
  IsoUtc,
  IsoUtcWholeSecond,
  isWellFormedUtf16,
  MicroUsdc,
  normText,
  normTextDeep,
  NText,
  otherParty,
  parseUsd,
  Pubkey,
  Signature,
  sha256Hex,
  toMicro,
  U64_MAX,
  UserRef,
} from '../src';

describe('money (§1.1)', () => {
  it('MicroUsdc accepts base-10 u64 strings only', () => {
    for (const ok of ['0', '6200000', U64_MAX.toString()])
      expect(MicroUsdc.safeParse(ok).success).toBe(true);
    for (const bad of ['', '01', '-1', '1.5', ' 1', (U64_MAX + 1n).toString(), '1e6'])
      expect(MicroUsdc.safeParse(bad).success).toBe(false);
    expect(MicroUsdc.safeParse(5_000_000).success).toBe(false);
  });
  it('parseUsd: whole cents only', () => {
    expect(parseUsd('$5')).toBe('5000000');
    expect(parseUsd('5')).toBe('5000000');
    expect(parseUsd('5.2')).toBe('5200000');
    expect(parseUsd('6.20')).toBe('6200000');
    expect(parseUsd(' $0.10 ')).toBe('100000');
    for (const bad of ['5.123', '$', 'five', '05', '-5', '1234567'])
      expect(() => parseUsd(bad)).toThrow();
  });
  it('formatUsd', () => {
    expect(formatUsd('5000000')).toBe('$5');
    expect(formatUsd('6200000')).toBe('$6.20');
    expect(formatUsd('3800000')).toBe('$3.80');
    expect(formatUsd('1234567')).toBe('$1.234567');
    expect(formatUsd('1230000')).toBe('$1.23');
    expect(formatUsd('0')).toBe('$0');
  });
  it('toMicro / fromMicro round-trip and range', () => {
    expect(toMicro('6200000')).toBe(6_200_000n);
    expect(fromMicro(U64_MAX)).toBe(U64_MAX.toString());
    expect(() => fromMicro(-1n)).toThrow(RangeError);
    expect(() => fromMicro(U64_MAX + 1n)).toThrow(RangeError);
  });
});

describe('ids and bytes (§1.2)', () => {
  const id = '7f3c2a9e-4b1d-4e8a-9c2f-1a2b3c4d5e6f';
  it('BetId: lowercase UUIDv4', () => {
    expect(BetId.safeParse(id).success).toBe(true);
    expect(BetId.safeParse(id.toUpperCase()).success).toBe(false);
    expect(BetId.safeParse('7f3c2a9e-4b1d-1e8a-9c2f-1a2b3c4d5e6f').success).toBe(false); // v1
    expect(BetId.safeParse('7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f').success).toBe(false);
  });
  it('betIdToBytes is RFC 4122 textual order and round-trips', () => {
    const b = betIdToBytes(id);
    expect(b.length).toBe(16);
    expect(Array.from(b.slice(0, 4))).toEqual([0x7f, 0x3c, 0x2a, 0x9e]);
    expect(b[15]).toBe(0x6f);
    expect(bytesToBetId(b)).toBe(id);
    expect(() => bytesToBetId(new Uint8Array(15))).toThrow();
  });
  it('Hex32, Pubkey, Signature', () => {
    expect(Hex32.safeParse('ab'.repeat(32)).success).toBe(true);
    expect(Hex32.safeParse('AB'.repeat(32)).success).toBe(false);
    expect(Pubkey.safeParse('CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr').success).toBe(true);
    expect(Pubkey.safeParse('E97T44N6hdDS7S8r6vDYGrFPzNb9uKJsg5Eecya3AR4').success).toBe(true);
    expect(Pubkey.safeParse('11111111111111111111111111111111').success).toBe(true);
    expect(Pubkey.safeParse('0'.repeat(44)).success).toBe(false);
    expect(Pubkey.safeParse('z'.repeat(44)).success).toBe(false); // base58 chars but decodes to 33 bytes
    expect(
      Signature.safeParse(
        '52i3cfdiJhBc6Wko6rxC2MUJBK2SoB7JBt6wLy8UEYUwyLPzxMvLr8PTvx1PjQJsCMjW3gCDWNaiymADMGhazeUk',
      ).success,
    ).toBe(true);
  });
  it('otherParty', () => {
    expect(otherParty('A')).toBe('B');
    expect(otherParty('B')).toBe('A');
  });
});

describe('time (§0, §1.2)', () => {
  it('IsoUtc = exact Date#toISOString form and a real instant', () => {
    expect(IsoUtc.safeParse('2026-11-21T18:05:12.345Z').success).toBe(true);
    expect(IsoUtc.safeParse(new Date(0).toISOString()).success).toBe(true);
    for (const bad of [
      '2026-11-21T18:05:12Z',
      '2026-11-21T18:05:12.345+00:00',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '9999-99-99T99:99:99.999Z',
    ])
      expect(IsoUtc.safeParse(bad).success).toBe(false);
  });
  it('IsoUtcWholeSecond', () => {
    expect(IsoUtcWholeSecond.safeParse('2026-11-21T18:15:00.000Z').success).toBe(true);
    expect(IsoUtcWholeSecond.safeParse('2026-11-21T18:15:00.001Z').success).toBe(false);
  });
});

describe('normalized text (§0 free text)', () => {
  it('normText: NFC, collapse whitespace, trim', () => {
    expect(normText('  Zoë\t\n  wins  ')).toBe('Zoë wins');
  });
  it('NText rejects, never fixes', () => {
    const T = NText(20);
    expect(T.parse('Jake flips it.')).toBe('Jake flips it.');
    for (const bad of [
      ' lead',
      'trail ',
      'double  space',
      'tab\there',
      'Zoë',
      'nul\u0000',
      'c1\u0085x',
      '\ud800x',
      '',
    ])
      expect(T.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(T.safeParse('x'.repeat(21)).success).toBe(false);
    expect(NText(10, 0).safeParse('').success).toBe(true);
  });
  it('DisplayName max 32', () => {
    expect(DisplayName.safeParse('x'.repeat(32)).success).toBe(true);
    expect(DisplayName.safeParse('x'.repeat(33)).success).toBe(false);
  });
  it('isWellFormedUtf16 agrees with native String#isWellFormed', () => {
    const native = (s: string): boolean =>
      (s as unknown as { isWellFormed(): boolean }).isWellFormed();
    for (const s of ['', 'abc', '😀', '\ud83d', '\ude00', 'a\ud83db', '\ude00\ud83d', '😀\ud83d'])
      expect(isWellFormedUtf16(s), JSON.stringify(s)).toBe(native(s));
  });
  it('normTextDeep normalizes every string and keeps structure', () => {
    expect(normTextDeep({ a: ' x  y ', b: [' z ', 1, null, { c: 'Zoë' }], d: true })).toEqual({
      a: 'x y',
      b: ['z', 1, null, { c: 'Zoë' }],
      d: true,
    });
  });
});

describe('sha256Hex and UserRef', () => {
  it('sha256Hex over strings and bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new Uint8Array())).toBe(sha256Hex(''));
  });
  it('UserRef §1.3 example parses', () => {
    expect(
      UserRef.parse({
        user_id: '5b1f0c3e-8d2a-4c6b-9e7f-0a1b2c3d4e5f',
        pubkey: 'CnsajwK7djGNjGnXhGk7ZtzMqn58zBs4CTbhXrCaDsQr',
        display_name: 'Jake',
        avatar_url: null,
      }).display_name,
    ).toBe('Jake');
  });
});
