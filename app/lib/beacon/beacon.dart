import 'dart:math' as math;
import 'dart:typed_data';

import '../core/bytes.dart';
import '../evidence/wav.dart';

/// Freshness beacon modulation (CONTRACTS.md §7.5).
const int kBeaconSampleRate = 48000;
const int kBeaconSymbolSamples = 2400; // 50 ms
const int kBeaconRampSamples = 240;
const int kBeaconSymbolMs = 50;
const List<int> kBeaconPreamble = [0, 15, 0, 15, 0, 15];
const int kBeaconSymbolCount = 42;
const int kBeaconDurationMs = kBeaconSymbolCount * kBeaconSymbolMs; // 2100

/// Tone frequency for symbol k: 2000 + 250·k Hz.
int beaconToneHz(int k) {
  if (k < 0 || k > 15) throw RangeError.range(k, 0, 15, 'symbol');
  return 2000 + 250 * k;
}

/// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
int crc16CcittFalse(List<int> data) {
  var crc = 0xFFFF;
  for (final b in data) {
    crc ^= (b & 0xff) << 8;
    for (var i = 0; i < 8; i++) {
      crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

/// 18-byte payload: `u64 slot (LE) ‖ beacon_hash[0..8] ‖ crc16 (BE)`.
Uint8List beaconPayload({required BigInt slot, required List<int> hash}) {
  if (hash.length < 8) throw ArgumentError('beacon hash needs >= 8 bytes');
  final w = ByteWriter()
    ..u64Big(slot)
    ..bytes(hash.sublist(0, 8));
  final first16 = w.toBytes();
  final crc = crc16CcittFalse(first16);
  return concatBytes([
    first16,
    [(crc >> 8) & 0xff, crc & 0xff],
  ]);
}

/// Preamble, then high nibble / low nibble of each payload byte: 42 symbols.
List<int> beaconSymbols({required BigInt slot, required List<int> hash}) {
  final p = beaconPayload(slot: slot, hash: hash);
  return [
    ...kBeaconPreamble,
    for (final b in p) ...[(b >> 4) & 0xf, b & 0xf],
  ];
}

/// Envelope: linear 0→1 over the first 240 samples, 1→0 over the last 240.
/// The falling ramp mirrors the rising one: env(n) = env(2399 − n)
/// (see docs/CONTRACTS-ERRATA.md, "App: beacon envelope").
double beaconEnvelope(int n) {
  if (n < kBeaconRampSamples) return n / kBeaconRampSamples;
  final fromEnd = kBeaconSymbolSamples - 1 - n;
  if (fromEnd < kBeaconRampSamples) return fromEnd / kBeaconRampSamples;
  return 1.0;
}

/// 48 kHz PCM16 samples of the tone sequence (phase resets each symbol).
Int16List synthesizeBeacon(List<int> symbols) {
  final out = Int16List(symbols.length * kBeaconSymbolSamples);
  var o = 0;
  for (final k in symbols) {
    final f = beaconToneHz(k);
    for (var n = 0; n < kBeaconSymbolSamples; n++) {
      final s = 0.25 *
          beaconEnvelope(n) *
          math.sin(2 * math.pi * f * n / kBeaconSampleRate);
      out[o++] = (32767 * s).round();
    }
  }
  return out;
}

/// WAV bytes of the beacon tones, ready for playback.
Uint8List beaconWav(List<int> symbols) =>
    encodeWavPcm16(synthesizeBeacon(symbols), sampleRate: kBeaconSampleRate);

/// The `beacon` object of WS `start` (§12.4): `{slot, hash_hex, symbols}`.
class Beacon {
  Beacon({required this.slot, required this.hash, required this.symbols});

  final BigInt slot;
  final Uint8List hash; // 32-byte SlotHashes bank hash
  final List<int> symbols;

  factory Beacon.fromJson(Map<String, dynamic> j) {
    final rawSlot = j['slot'];
    final slot = rawSlot is int
        ? BigInt.from(rawSlot)
        : BigInt.parse(rawSlot.toString());
    final hash = fromHex(j['hash_hex'] as String);
    final symbols = (j['symbols'] as List?)?.cast<num>().map((e) => e.toInt()).toList();
    return Beacon(
      slot: slot,
      hash: hash,
      symbols: symbols ?? beaconSymbols(slot: slot, hash: hash),
    );
  }

  /// True when the server's symbols match the ones derived from slot + hash.
  bool get consistent {
    final expect = beaconSymbols(slot: slot, hash: hash);
    if (expect.length != symbols.length) return false;
    for (var i = 0; i < expect.length; i++) {
      if (expect[i] != symbols[i]) return false;
    }
    return true;
  }
}
