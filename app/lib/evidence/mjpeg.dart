import 'dart:typed_data';

import '../core/bytes.dart';

/// MJPEG camera chunk body (CONTRACTS.md §7.1): repeated
/// `u32 len ‖ u32 t_ms_local ‖ jpeg[len]` (little-endian), 10 fps.
class MjpegWriter {
  final ByteWriter _w = ByteWriter();
  int _frames = 0;
  int? _firstMs;
  int? _lastMs;

  int get frames => _frames;
  int get length => _w.length;
  int? get firstMs => _firstMs;
  int? get lastMs => _lastMs;

  /// [tMsLocal] is device-local ms since the witness started recording.
  void add(List<int> jpeg, int tMsLocal) {
    if (_lastMs != null && tMsLocal < _lastMs!) {
      throw ArgumentError('frame timestamps must be non-decreasing');
    }
    _w
      ..u32(jpeg.length)
      ..u32(tMsLocal)
      ..bytes(jpeg);
    _frames++;
    _firstMs ??= tMsLocal;
    _lastMs = tMsLocal;
  }

  Uint8List toBytes() => _w.toBytes();
}

class MjpegFrame {
  const MjpegFrame(this.tMs, this.jpeg);
  final int tMs;
  final Uint8List jpeg;
}

/// Parses an MJPEG chunk body; throws [FormatException] if truncated.
List<MjpegFrame> parseMjpeg(Uint8List body) {
  final r = ByteReader(body);
  final out = <MjpegFrame>[];
  while (r.remaining > 0) {
    if (r.remaining < 8) throw const FormatException('truncated mjpeg header');
    final len = r.u32();
    final t = r.u32();
    out.add(MjpegFrame(t, Uint8List.fromList(r.take(len))));
  }
  return out;
}
