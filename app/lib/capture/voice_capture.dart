import 'dart:async';
import 'dart:typed_data';

import 'package:record/record.dart';

import '../evidence/wav.dart';

/// Microphone clips as 16 kHz mono PCM16 WAV (enroll phrases, dictation,
/// "I accept", pay voice fallback).
abstract class VoiceCapture {
  bool get recording;
  Future<bool> hasPermission();
  Future<void> start();

  /// Stops and returns the WAV bytes of the clip.
  Future<Uint8List> stop();
  Future<void> dispose();
}

class MicVoiceCapture implements VoiceCapture {
  MicVoiceCapture([AudioRecorder? recorder]) : _rec = recorder ?? AudioRecorder();

  final AudioRecorder _rec;
  final BytesBuilder _buf = BytesBuilder(copy: true);
  StreamSubscription<Uint8List>? _sub;
  bool _recording = false;

  static const int sampleRate = 16000;

  @override
  bool get recording => _recording;

  @override
  Future<bool> hasPermission() => _rec.hasPermission();

  @override
  Future<void> start() async {
    if (_recording) return;
    _buf.clear();
    final stream = await _rec.startStream(const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: sampleRate,
      numChannels: 1,
    ));
    _recording = true;
    _sub = stream.listen(_buf.add);
  }

  @override
  Future<Uint8List> stop() async {
    if (!_recording) return wrapPcm16Bytes(const [], sampleRate: sampleRate);
    await _rec.stop();
    await Future<void>.delayed(const Duration(milliseconds: 50));
    await _sub?.cancel();
    _sub = null;
    _recording = false;
    var pcm = _buf.takeBytes();
    if (pcm.length.isOdd) pcm = Uint8List.sublistView(pcm, 0, pcm.length - 1);
    return wrapPcm16Bytes(pcm, sampleRate: sampleRate);
  }

  @override
  Future<void> dispose() => _rec.dispose();
}
