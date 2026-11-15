import 'dart:async';
import 'dart:io';

import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';

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
      _rolling = _rolling.catchError((Object _) {}).then((_) => _roll(isFinal: false));
    });
  }

  /// The camera was lost (released by the OS, disposed): no more segments.
  void _fail(Object e) {
    debugPrint('camera witness: $e');
    _running = false;
    _timer?.cancel();
  }

  /// Closes the current segment and (unless final) starts the next one.
  ///
  /// If the controller fails, the chain ends cleanly: the segment that
  /// could be cut becomes the `final` chunk, or an empty `final` chunk
  /// marks the end, so the backend records a gap instead of waiting for a
  /// final that never comes.
  Future<void> _roll({required bool isFinal}) async {
    if (!_running) return;
    if (!isFinal && _stopping) return;
    final stopAt = _clock.elapsedMilliseconds;
    final start = _segStart;
    final XFile file;
    try {
      file = await controller.stopVideoRecording();
    } catch (e) {
      _fail(e);
      await _submit(Uint8List(0), start, stopAt, isFinal: true);
      return;
    }
    var last = isFinal;
    if (!isFinal) {
      try {
        await controller.startVideoRecording();
        _segStart = _clock.elapsedMilliseconds;
        _arm();
      } catch (e) {
        _fail(e);
        last = true;
      }
    } else {
      _running = false;
    }
    Uint8List bytes;
    try {
      bytes = await file.readAsBytes();
    } catch (_) {
      bytes = Uint8List(0);
    }
    unawaited(_deleteQuietly(file.path));
    await _submit(bytes, start, stopAt, isFinal: last);
  }

  Future<void> _submit(Uint8List bytes, int start, int stopAt, {required bool isFinal}) async {
    final duration = stopAt - start;
    try {
      await uploader.submit(bytes, startMs: start, durationMs: duration > 0 ? duration : 1, isFinal: isFinal);
    } on StateError {
      // A final chunk was already submitted.
    }
  }

  Future<void> _deleteQuietly(String path) async {
    try {
      await File(path).delete();
    } catch (_) {}
  }

  /// Ends recording: the open segment becomes the `final` chunk. Always
  /// drains the uploader, even when the camera failed.
  Future<void> stop() async {
    if (_stopping) return;
    _stopping = true;
    _timer?.cancel();
    try {
      await _rolling.catchError((Object _) {});
      await _roll(isFinal: true);
    } finally {
      _clock.stop();
      await uploader.drain();
    }
  }
}
