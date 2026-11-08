import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/beacon/beacon.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/evidence/wav.dart';

import '../support/golden.dart';

void main() {
  test('CRC-16/CCITT-FALSE check value', () {
    expect(crc16CcittFalse(ascii.encode('123456789')), 0x29B1);
    expect(crc16CcittFalse(const []), 0xFFFF);
  });

  test('payload: u64 slot LE ‖ hash[0..8] ‖ crc16 BE (§7.5)', () {
    final p = beaconPayload(slot: kBeaconSlot, hash: fromHex(kBeaconHashHex));
    expect(p.length, 18);
    expect(toHex(p), kBeaconPayloadHex);
  });

  test('42 symbols: preamble then nibbles high-first', () {
    final s = beaconSymbols(slot: kBeaconSlot, hash: fromHex(kBeaconHashHex));
    expect(s.length, kBeaconSymbolCount);
    expect(s, kBeaconSymbols);
    expect(s.sublist(0, 6), kBeaconPreamble);
  });

  test('tone frequencies', () {
    expect(beaconToneHz(0), 2000);
    expect(beaconToneHz(15), 5750);
    expect(() => beaconToneHz(16), throwsRangeError);
  });

  test('envelope ramps and is mirror-symmetric', () {
    expect(beaconEnvelope(0), 0);
    expect(beaconEnvelope(120), 0.5);
    expect(beaconEnvelope(240), 1);
    expect(beaconEnvelope(1200), 1);
    expect(beaconEnvelope(2399), 0);
    for (var n = 0; n < 2400; n++) {
      expect(beaconEnvelope(n), beaconEnvelope(2399 - n));
    }
  });

  test('synthesis: 2.1 s at 48 kHz, amplitude ≤ 0.25, phase resets', () {
    final pcm = synthesizeBeacon(kBeaconSymbols);
    expect(pcm.length, 42 * 2400);
    expect(pcm.length * 1000 ~/ kBeaconSampleRate, kBeaconDurationMs);
    final peak = pcm.fold<int>(0, (m, v) => math.max(m, v.abs()));
    expect(peak, lessThanOrEqualTo((32767 * 0.25).round()));
    expect(peak, greaterThan(8000));
    // Every symbol starts at phase 0 with env 0.
    for (var j = 0; j < 42; j++) {
      expect(pcm[j * 2400], 0);
    }
    // Spot-check one sample against the formula.
    const n = 1000;
    final f = beaconToneHz(kBeaconSymbols[1]);
    final expected = (32767 * 0.25 * math.sin(2 * math.pi * f * n / 48000)).round();
    expect(pcm[2400 + n], expected);
  });

  test('Goertzel picks the transmitted tone in each symbol', () {
    final pcm = synthesizeBeacon(kBeaconSymbols);
    double power(int start, int f) {
      // Middle 40 ms of the symbol.
      final s0 = start + 240;
      const len = 1920;
      final k = 2 * math.cos(2 * math.pi * f / kBeaconSampleRate);
      var q1 = 0.0, q2 = 0.0;
      for (var i = 0; i < len; i++) {
        final q0 = k * q1 - q2 + pcm[s0 + i];
        q2 = q1;
        q1 = q0;
      }
      return q1 * q1 + q2 * q2 - k * q1 * q2;
    }

    for (var j = 0; j < 42; j++) {
      var best = 0;
      var bestP = -1.0;
      for (var t = 0; t < 16; t++) {
        final p = power(j * 2400, beaconToneHz(t));
        if (p > bestP) {
          bestP = p;
          best = t;
        }
      }
      expect(best, kBeaconSymbols[j], reason: 'symbol $j');
    }
  });

  test('beacon WAV header', () {
    final wav = beaconWav(kBeaconSymbols);
    final info = parseWav(wav)!;
    expect(info.sampleRate, 48000);
    expect(info.channels, 1);
    expect(info.bitsPerSample, 16);
    expect(info.durationMs, 2100);
  });

  test('Beacon.fromJson: numeric or string slot, symbol consistency', () {
    final a = Beacon.fromJson({'slot': 12345678901, 'hash_hex': kBeaconHashHex, 'symbols': kBeaconSymbols});
    expect(a.consistent, isTrue);
    final b = Beacon.fromJson({'slot': '12345678901', 'hash_hex': kBeaconHashHex});
    expect(b.symbols, kBeaconSymbols);
    final bad = Beacon.fromJson({
      'slot': 12345678901,
      'hash_hex': kBeaconHashHex,
      'symbols': [...kBeaconSymbols]..[10] = 0,
    });
    expect(bad.consistent, isFalse);
  });
}
