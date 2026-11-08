import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';

import '../contracts/constants.dart';
import 'chunk_uploader.dart';

/// Camera witness (CONTRACTS.md §7.1 kind 0, `body_format = "mp4"`): the
/// viewfinder's [CameraController] records consecutive MP4 segments of
/// `CHUNK_MS`; each segment file is one chunk.
///
/// Device-local time 0 is when the first segment started recording. Segment
/// restarts leave short gaps, reported by the backend as `gaps_ms`
/// (tolerated up to `CHUNK_GAP_MAX_MS`).
class CameraWitnessRecorder {
  CameraWitnessRecorder({required this.controller, required this.uploader, this.chunkMs = CHUNK_MS});

  final CameraController controller;
  final ChunkUploader uploader;
  final int chunkMs;

  final Stopwatch _clock = Stopwatch();
  Timer? _timer;
  int _segStart = 0;
  bool _running = false;
  bool _stopping = false;
  Future<void> _rolling = Future.value();

  bool get running => _running;

  /// Device-local ms since this witness started recording.
  int get elapsedMs => _clock.elapsedMilliseconds;

  Future<void> start() async {
    if (_running) throw StateError('already started');
    await controller.prepareForVideoRecording();
    await controller.startVideoRecording();
    _clock.start();
    _segStart = 0;
    _running = true;
    _arm();
  }

  void _arm() {
    _timer?.cancel();
    final due = _segStart + chunkMs - _clock.elapsedMilliseconds;
    _timer = Timer(Duration(milliseconds: due < 0 ? 0 : due), () {
      _rolling = _rolling.then((_) => _roll(isFinal: false));
    });
  }

  /// Closes the current segment and (unless final) starts the next one.
  Future<void> _roll({required bool isFinal}) async {
    if (!_running) return;
    if (!isFinal && _stopping) return;
    final stopAt = _clock.elapsedMilliseconds;
    final file = await controller.stopVideoRecording();
    final start = _segStart;
    if (!isFinal) {
      await controller.startVideoRecording();
      _segStart = _clock.elapsedMilliseconds;
      _arm();
    } else {
      _running = false;
    }
    final bytes = await file.readAsBytes();
    unawaited(_deleteQuietly(file.path));
    final duration = stopAt - start;
    await uploader.submit(bytes, startMs: start, durationMs: duration > 0 ? duration : 1, isFinal: isFinal);
  }

  Future<void> _deleteQuietly(String path) async {
    try {
      await File(path).delete();
    } catch (_) {}
  }

  /// Ends recording: the open segment becomes the `final` chunk.
  Future<void> stop() async {
    if (!_running || _stopping) return;
    _stopping = true;
    _timer?.cancel();
    await _rolling;
    await _roll(isFinal: true);
    _clock.stop();
    await uploader.drain();
  }
}
