import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/evidence/mjpeg.dart';
import 'package:verdict/evidence/pcm_chunker.dart';
import 'package:verdict/evidence/wav.dart';

void main() {
  group('PcmChunker', () {
    test('5 s WAV chunks at 16 kHz, contiguous, last one final', () {
      final c = PcmChunker();
      expect(c.chunkBytes, 160000);
      final out = <PcmChunk>[];
      // 12.5 s of audio in uneven, odd-sized pieces.
      final total = 16000 * 2 * 12 + 16000; // bytes
      var sent = 0;
      var step = 3331;
      while (sent < total) {
        final n = (total - sent) < step ? total - sent : step;
        out.addAll(c.add(Uint8List(n)..fillRange(0, n, sent & 0xff)));
        sent += n;
        step = step == 3331 ? 7 : 3331;
      }
      final last = c.finish();
      expect(last, isNotNull);
      out.add(last!);

      expect(out.length, 3);
      expect(out.map((e) => e.startMs).toList(), [0, 5000, 10000]);
      expect(out.map((e) => e.durationMs).toList(), [5000, 5000, 2500]);
      expect(out.map((e) => e.isFinal).toList(), [false, false, true]);
      for (final ch in out) {
        final info = parseWav(ch.wav)!;
        expect(info.sampleRate, 16000);
        expect(info.channels, 1);
        expect(info.bitsPerSample, 16);
        expect(info.durationMs, ch.durationMs);
      }
    });

    test('exact multiple: full chunk is held back until more data or finish', () {
      final c = PcmChunker();
      expect(c.add(Uint8List(160000)), isEmpty);
      final last = c.finish()!;
      expect(last.isFinal, isTrue);
      expect(last.durationMs, 5000);
      expect(c.finish(), isNull);
      expect(() => c.add([1, 2]), throwsStateError);
    });

    test('nothing recorded', () {
      expect(PcmChunker().finish(), isNull);
    });
  });

  group('WAV', () {
    test('encode/parse', () {
      final wav = encodeWavPcm16(Int16List.fromList([0, 1, -1, 32767, -32768]), sampleRate: 16000);
      expect(wav.length, 44 + 10);
      final info = parseWav(wav)!;
      expect(info.dataOffset, 44);
      expect(info.dataLength, 10);
      final bd = ByteData.sublistView(wav);
      expect(bd.getInt16(44 + 6, Endian.little), 32767);
      expect(bd.getInt16(44 + 8, Endian.little), -32768);
      expect(wrapPcm16Bytes(wav.sublist(44), sampleRate: 16000), wav);
      expect(parseWav(Uint8List.fromList([1, 2, 3])), isNull);
    });
  });

  group('MJPEG', () {
    test('u32 len ‖ u32 t_ms ‖ jpeg, little-endian', () {
      final w = MjpegWriter()
        ..add([0xff, 0xd8, 0xff, 0xd9], 0)
        ..add([1, 2, 3], 100);
      final b = w.toBytes();
      expect(b.sublist(0, 8), [4, 0, 0, 0, 0, 0, 0, 0]);
      expect(b.sublist(12, 20), [3, 0, 0, 0, 100, 0, 0, 0]);
      final frames = parseMjpeg(b);
      expect(frames.length, 2);
      expect(frames[1].tMs, 100);
      expect(frames[1].jpeg, [1, 2, 3]);
      expect(w.frames, 2);
      expect(() => w.add([1], 50), throwsArgumentError);
      expect(() => parseMjpeg(Uint8List.fromList([1, 0, 0])), throwsFormatException);
    });
  });
}
