import 'dart:typed_data';

import '../core/bytes.dart';

/// Mono PCM16 WAV (RIFF) encoding. Audio witness chunks and dictation clips
/// are 16 kHz mono PCM16 (CONTRACTS.md §7.1, §12.3); beacon tones are 48 kHz.
Uint8List encodeWavPcm16(Int16List samples, {required int sampleRate}) {
  final dataBytes = samples.length * 2;
  final w = ByteWriter()
    ..ascii('RIFF')
    ..u32(36 + dataBytes)
    ..ascii('WAVE')
    ..ascii('fmt ')
    ..u32(16) // PCM fmt chunk size
    ..u16(1) // PCM
    ..u16(1) // mono
    ..u32(sampleRate)
    ..u32(sampleRate * 2) // byte rate
    ..u16(2) // block align
    ..u16(16) // bits per sample
    ..ascii('data')
    ..u32(dataBytes);
  final out = Uint8List(w.length + dataBytes)..setAll(0, w.toBytes());
  final bd = ByteData.sublistView(out);
  var o = w.length;
  for (final s in samples) {
    bd.setInt16(o, s, Endian.little);
    o += 2;
  }
  return out;
}

/// Wraps raw little-endian PCM16 bytes (as streamed by the recorder) in a WAV
/// header without copying sample-by-sample.
Uint8List wrapPcm16Bytes(List<int> pcmLe, {required int sampleRate}) {
  if (pcmLe.length.isOdd) throw ArgumentError('PCM16 data must be even-length');
  final w = ByteWriter()
    ..ascii('RIFF')
    ..u32(36 + pcmLe.length)
    ..ascii('WAVE')
    ..ascii('fmt ')
    ..u32(16)
    ..u16(1)
    ..u16(1)
    ..u32(sampleRate)
    ..u32(sampleRate * 2)
    ..u16(2)
    ..u16(16)
    ..ascii('data')
    ..u32(pcmLe.length)
    ..bytes(pcmLe);
  return w.toBytes();
}

/// Parsed header of a PCM WAV file.
class WavInfo {
  const WavInfo({
    required this.sampleRate,
    required this.channels,
    required this.bitsPerSample,
    required this.dataOffset,
    required this.dataLength,
  });

  final int sampleRate;
  final int channels;
  final int bitsPerSample;
  final int dataOffset;
  final int dataLength;

  int get durationMs {
    final frameBytes = channels * bitsPerSample ~/ 8;
    if (frameBytes == 0 || sampleRate == 0) return 0;
    return (dataLength ~/ frameBytes) * 1000 ~/ sampleRate;
  }
}

/// Reads the `fmt ` and `data` chunks of a RIFF/WAVE file. Returns null if
/// the bytes are not a PCM WAV.
WavInfo? parseWav(Uint8List bytes) {
  if (bytes.length < 12) return null;
  String tag(int o) => String.fromCharCodes(bytes.sublist(o, o + 4));
  if (tag(0) != 'RIFF' || tag(8) != 'WAVE') return null;
  final bd = ByteData.sublistView(bytes);
  var o = 12;
  int? rate, ch, bits;
  while (o + 8 <= bytes.length) {
    final id = tag(o);
    final size = bd.getUint32(o + 4, Endian.little);
    final body = o + 8;
    if (id == 'fmt ' && body + 16 <= bytes.length) {
      ch = bd.getUint16(body + 2, Endian.little);
      rate = bd.getUint32(body + 4, Endian.little);
      bits = bd.getUint16(body + 14, Endian.little);
    } else if (id == 'data') {
      if (rate == null || ch == null || bits == null) return null;
      final len = body + size > bytes.length ? bytes.length - body : size;
      return WavInfo(
        sampleRate: rate,
        channels: ch,
        bitsPerSample: bits,
        dataOffset: body,
        dataLength: len,
      );
    }
    o = body + size + (size.isOdd ? 1 : 0);
  }
  return null;
}
