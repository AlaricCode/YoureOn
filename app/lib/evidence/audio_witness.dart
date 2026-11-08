import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import 'chunk_uploader.dart';
import 'pcm_chunker.dart';

/// Audio witness (CONTRACTS.md §7.1 kind 1): 16 kHz mono PCM16 streamed
/// from the microphone, split into 5 s WAV chunks, sealed and uploaded.
class AudioWitnessRecorder {
  AudioWitnessRecorder({required this.uploader, AudioRecorder? recorder})
      : _rec = recorder ?? AudioRecorder();

  final ChunkUploader uploader;
  final AudioRecorder _rec;
  final PcmChunker _chunker = PcmChunker();

  StreamSubscription<Uint8List>? _sub;
  Completer<void>? _done;
  bool _started = false;

  static const RecordConfig config = RecordConfig(
    encoder: AudioEncoder.pcm16bits,
    sampleRate: 16000,
    numChannels: 1,
    autoGain: false,
    echoCancel: false,
    noiseSuppress: false,
  );

  Future<bool> hasPermission() => _rec.hasPermission();

  /// Starts recording; device-local time 0 is the first sample.
  Future<void> start() async {
    if (_started) throw StateError('already started');
    _started = true;
    final stream = await _rec.startStream(config);
    final done = _done = Completer<void>();
    _sub = stream.listen(
      (data) {
        for (final c in _chunker.add(data)) {
          _submit(c);
        }
      },
      onDone: () {
        if (!done.isCompleted) done.complete();
      },
      onError: (Object _) {
        if (!done.isCompleted) done.complete();
      },
    );
  }

  void _submit(PcmChunk c) {
    uploader.submit(c.wav, startMs: c.startMs, durationMs: c.durationMs, isFinal: c.isFinal);
  }

  /// Stops the microphone, seals the final chunk and waits for uploads.
  Future<void> stop() async {
    if (!_started) return;
    await _rec.stop();
    // The plugin closes the stream after stop; don't hang if it doesn't.
    await (_done?.future ?? Future<void>.value()).timeout(const Duration(seconds: 2), onTimeout: () {});
    await _sub?.cancel();
    final last = _chunker.finish();
    if (last != null) _submit(last);
    await uploader.drain();
  }

  Future<void> dispose() => _rec.dispose();
}
