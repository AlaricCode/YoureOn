import 'dart:typed_data';

import '../contracts/constants.dart';
import 'wav.dart';

/// A finished audio chunk body ready to seal.
class PcmChunk {
  const PcmChunk({required this.wav, required this.startMs, required this.durationMs, required this.isFinal});
  final Uint8List wav;
  final int startMs;
  final int durationMs;
  final bool isFinal;
}

/// Splits a 16 kHz mono PCM16 byte stream into `CHUNK_MS` WAV chunks
/// (CONTRACTS.md §7.1, §7.2).
///
/// Device-local time is the sample clock: chunk i starts at
/// `samples_before_i · 1000 / rate` ms, so chunks are contiguous (no gaps)
/// and chunk 0 starts at 0. A full chunk is only emitted once at least one
/// more byte has arrived, so the last chunk emitted by [finish] is never
/// empty and is the one flagged `final`.
class PcmChunker {
  PcmChunker({this.sampleRate = 16000, this.chunkMs = CHUNK_MS})
      : _chunkBytes = sampleRate * chunkMs ~/ 1000 * 2;

  final int sampleRate;
  final int chunkMs;
  final int _chunkBytes;

  final BytesBuilder _buf = BytesBuilder(copy: true);
  int _samplesEmitted = 0;
  int _pendingOdd = -1; // carries a split PCM16 byte across stream events
  bool _finished = false;

  int get chunkBytes => _chunkBytes;

  int _msAt(int samples) => samples * 1000 ~/ sampleRate;

  /// Feeds raw little-endian PCM16; returns any chunks completed by it.
  List<PcmChunk> add(List<int> data) {
    if (_finished) throw StateError('chunker finished');
    var bytes = data;
    if (_pendingOdd >= 0 && bytes.isNotEmpty) {
      bytes = [_pendingOdd, ...bytes];
      _pendingOdd = -1;
    }
    if (bytes.length.isOdd) {
      _pendingOdd = bytes.last;
      bytes = bytes.sublist(0, bytes.length - 1);
    }
    _buf.add(bytes);
    final out = <PcmChunk>[];
    while (_buf.length > _chunkBytes) {
      final all = _buf.takeBytes();
      out.add(_emit(Uint8List.sublistView(all, 0, _chunkBytes), false));
      _buf.add(Uint8List.sublistView(all, _chunkBytes));
    }
    return out;
  }

  /// Flushes the remainder as the final chunk (null if nothing was recorded).
  PcmChunk? finish() {
    if (_finished) return null;
    _finished = true;
    final rest = _buf.takeBytes();
    if (rest.isEmpty) return null;
    return _emit(rest, true);
  }

  PcmChunk _emit(Uint8List pcm, bool isFinal) {
    final samples = pcm.length ~/ 2;
    final start = _msAt(_samplesEmitted);
    _samplesEmitted += samples;
    final end = _msAt(_samplesEmitted);
    return PcmChunk(
      wav: wrapPcm16Bytes(pcm, sampleRate: sampleRate),
      startMs: start,
      // A sub-millisecond final remainder still reports 1 ms (duration > 0).
      durationMs: end - start > 0 ? end - start : 1,
      isFinal: isFinal,
    );
  }
}
