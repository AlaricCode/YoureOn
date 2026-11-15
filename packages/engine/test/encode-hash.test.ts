import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  CanonicalJsonError,
  ZERO_HASH_HEX,
  acceptSigMessage,
  acceptanceAudioHash,
  acceptanceCreatorLeaf,
  acceptanceLeaf,
  bioHash,
  bytesToHex,
  canonicalJson,
  concatBytes,
  crc16CcittFalse,
  crc16CcittFalseBytes,
  encodeBioCheck,
  hexToBytes,
  jsonHash,
  marketHash,
  modelHash,
  pubkeyToBytes,
  sceneHash,
  sha256,
  sha256Hex,
  termsHash,
  toBytes32,
  utf8,
} from '../src/hash/index.js';
import { CREATOR, FRIEND, THIRD, paperBall, paperBallCalibration, pk } from './encode-fixtures.js';

describe('sha256', () => {
  it('matches FIPS 180-4 vectors', () => {
    expect(sha256Hex(utf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(bytesToHex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('crc16CcittFalse', () => {
  it('check value 0x29B1', () => {
    expect(crc16CcittFalse(utf8('123456789'))).toBe(0x29b1);
    expect([...crc16CcittFalseBytes(utf8('123456789'))]).toEqual([0x29, 0xb1]);
  });
  it('empty input = init 0xFFFF', () => {
    expect(crc16CcittFalse(new Uint8Array(0))).toBe(0xffff);
  });
  it('16-byte beacon prefix round-trips through big-endian bytes', () => {
    const p = new Uint8Array(16).map((_, i) => i * 17);
    const c = crc16CcittFalseBytes(p);
    expect((c[0]! << 8) | c[1]!).toBe(crc16CcittFalse(p));
  });
});

describe('canonicalJson (§4.1)', () => {
  it('sorts keys, no whitespace, arrays keep order', () => {
    expect(canonicalJson({ b: 1, a: [3, 'x', true, false], c: { z: 0, y: -5 } })).toBe(
      '{"a":[3,"x",true,false],"b":1,"c":{"y":-5,"z":0}}',
    );
  });
  it('sorts by UTF-16 code units, not code points', () => {
    // U+1F600 is D83D DE00 in UTF-16, which sorts before U+FFFF.
    expect(canonicalJson({ '￿': 1, '\u{1F600}': 2 })).toBe('{"\u{1F600}":2,"￿":1}');
    expect(canonicalJson({ aa: 1, a: 2, B: 3, _: 4 })).toBe('{"B":3,"_":4,"a":2,"aa":1}');
  });
  it('escapes exactly the required characters', () => {
    expect(canonicalJson('"\\\b\f\n\r\t/\u0001\u001f\u007f é')).toBe(
      '"\\"\\\\\\b\\f\\n\\r\\t/\\u0001\\u001f\u007f é"',
    );
  });
  it('NFC-normalizes strings and keys', () => {
    expect(canonicalJson('é')).toBe('"é"');
    expect(canonicalJson({ 'é': 1 })).toBe('{"é":1}');
  });
  it('rejects keys that collide after NFC', () => {
    expect(() => canonicalJson({ 'é': 1, 'é': 2 })).toThrow(CanonicalJsonError);
  });
  it('omits undefined members, forbids null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: null })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(null)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
  });
  it('numbers: safe integers only, -0 → 0', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(canonicalJson(-Number.MAX_SAFE_INTEGER)).toBe('-9007199254740991');
    expect(canonicalJson(1e3)).toBe('1000');
    for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53)]) {
      expect(() => canonicalJson(bad)).toThrow(CanonicalJsonError);
    }
  });
  it('rejects non-JSON values', () => {
    expect(() => canonicalJson(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Uint8Array(2))).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(() => 1)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson('\ud800')).toThrow(CanonicalJsonError);
    expect(() => canonicalJson('a\udc00b')).toThrow(CanonicalJsonError);
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow(CanonicalJsonError);
  });
  it('allows the same object twice (not a cycle)', () => {
    const o = { a: 1 };
    expect(canonicalJson([o, o])).toBe('[{"a":1},{"a":1}]');
  });
  it('keeps non-BMP characters literal', () => {
    expect(canonicalJson('\u{1F600}')).toBe('"\u{1F600}"');
  });
});

describe('§4.2 hashes', () => {
  it('jsonHash = sha256(canonicalJson(program))', () => {
    const p = paperBall();
    expect(jsonHash(p)).toBe(sha256Hex(utf8(canonicalJson(p))));
    // key order of the input object does not matter
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as typeof p;
    expect(jsonHash(reordered)).toBe(jsonHash(p));
  });
  it('sceneHash hashes only the scene', () => {
    const c = paperBallCalibration();
    expect(sceneHash(c)).toBe(sha256Hex(utf8(canonicalJson(c.scene))));
    const c2 = { ...c, regions: [] };
    expect(sceneHash(c2)).toBe(sceneHash(c));
  });
  it('marketHash = sha256("gemini:" + event + ":" + contract)', () => {
    expect(marketHash('EV1', 'C1')).toBe(sha256Hex(utf8('gemini:EV1:C1')));
    expect(marketHash('a:b', 'c')).toBe(sha256Hex(utf8('gemini:a:b:c')));
  });
  it('modelHash uses exactly the four preimage keys', () => {
    const spec = { image: 'img@sha256:1', weights_sha256: '11'.repeat(32), prompts: ['ball', 'can'], settings: { iou: 50 } };
    expect(modelHash(spec)).toBe(sha256Hex(utf8(canonicalJson(spec))));
    expect(modelHash({ ...spec, extra: 1 } as typeof spec)).toBe(modelHash(spec));
    expect(() => modelHash({ ...spec, settings: { thr: 0.5 } })).toThrow(CanonicalJsonError);
  });
  it('bioHash = sha256(u8 n ‖ 6-byte BioChecks)', () => {
    expect([...encodeBioCheck({ participant: 1, modality: 0, frame: 0x01020304 })]).toEqual([1, 0, 4, 3, 2, 1]);
    const bio = [
      { participant: 1, modality: 0 as const, frame: 41 },
      { participant: 0, modality: 1 as const, frame: 70000 },
    ];
    const pre = Uint8Array.of(2, 1, 0, 41, 0, 0, 0, 0, 1, 0x70, 0x11, 0x01, 0);
    expect(bioHash(bio)).toBe(sha256Hex(pre));
    expect(bioHash([])).toBe(sha256Hex(Uint8Array.of(0)));
    expect(() => bioHash([{ participant: 0, modality: 0, frame: -1 }])).toThrow(RangeError);
  });
  it('acceptSigMessage layout', () => {
    const ph = '22'.repeat(32);
    const wav = utf8('RIFF....');
    const m = acceptSigMessage(ph, wav);
    expect(m.length).toBe(21 + 32 + 32);
    expect(new TextDecoder().decode(m.slice(0, 21))).toBe('VERDICT/ACCEPT-SIG/v1');
    expect(bytesToHex(m.slice(21, 53))).toBe(ph);
    expect(bytesToHex(m.slice(53))).toBe(sha256Hex(wav));
    expect(acceptSigMessage(hexToBytes(ph), wav)).toEqual(m);
    expect(() => acceptSigMessage('22', wav)).toThrow(TypeError);
  });
  it('acceptanceAudioHash layout and leaves', () => {
    const wav0 = utf8('creator');
    const wav1 = utf8('friend');
    const sig = new Uint8Array(64).fill(7);
    const h0 = acceptanceCreatorLeaf(wav0);
    const h1 = acceptanceLeaf(wav1, sig);
    expect(h0).toEqual(sha256(wav0));
    expect(acceptanceCreatorLeaf(null)).toEqual(new Uint8Array(32));
    expect(h1).toEqual(sha256(concatBytes(sha256(wav1), sig)));
    const aah = acceptanceAudioHash([h0, h1]);
    expect(aah).toEqual(sha256(concatBytes(utf8('VERDICT/ACCEPT/v1'), Uint8Array.of(2), h0, h1)));
    expect(() => acceptanceAudioHash([h0])).toThrow(RangeError);
    expect(() => acceptanceLeaf(wav1, new Uint8Array(63))).toThrow(TypeError);
  });
  it('termsHash layout', () => {
    const aah = new Uint8Array(32).fill(9);
    const judges = [pk('j0'), pk('j1'), pk('j2')];
    const expected = sha256Hex(
      concatBytes(
        utf8('VERDICT/TERMS/v1'),
        bs58.decode(CREATOR),
        ...judges.map((j) => bs58.decode(j)),
        aah,
      ),
    );
    expect(termsHash(CREATOR, judges, aah)).toBe(expected);
    expect(termsHash(pubkeyToBytes(CREATOR), judges, bytesToHex(aah))).toBe(expected);
    expect(() => termsHash(CREATOR, [FRIEND, THIRD], aah)).toThrow(RangeError);
  });
  it('byte helpers', () => {
    expect(ZERO_HASH_HEX).toBe('0'.repeat(64));
    expect(() => hexToBytes('ABCD')).toThrow(TypeError);
    expect(() => hexToBytes('abc')).toThrow(TypeError);
    expect(() => toBytes32(new Uint8Array(31))).toThrow(TypeError);
    expect(() => pubkeyToBytes('1111')).toThrow(TypeError);
    expect(() => pubkeyToBytes('0OIl')).toThrow(TypeError);
  });
});
