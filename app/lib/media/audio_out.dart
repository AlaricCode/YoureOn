import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:path_provider/path_provider.dart';

import '../api/transport.dart';

/// Spoken output: question audio (`audio_url`), the read-back
/// (`readback.mp3`) and the verdict announcer (`announce.mp3`). Never
/// decorative sounds (spec §6.4).
abstract class AudioOut {
  /// Fetches an API path or server URL (with auth) and plays it.
  Future<void> play(String pathOrUrl);

  /// Plays raw WAV/MP3 bytes.
  Future<void> playBytes(Uint8List bytes);

  Future<void> stop();
  Future<void> dispose();
}

/// `RIFF` → wav, anything else is treated as mp3.
String audioExtension(List<int> bytes) =>
    bytes.length >= 4 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 ? 'wav' : 'mp3';

class PlayerAudioOut implements AudioOut {
  PlayerAudioOut(this.transport, [AudioPlayer? player]) : _player = player ?? AudioPlayer();

  final ApiTransport transport;
  final AudioPlayer _player;
  int _seq = 0;

  @override
  Future<void> play(String pathOrUrl) async {
    final bytes = await transport.getBytes(pathOrUrl);
    await playBytes(bytes);
  }

  @override
  Future<void> playBytes(Uint8List bytes) async {
    final dir = await getTemporaryDirectory();
    final f = File('${dir.path}/speech_${_seq++ % 4}.${audioExtension(bytes)}');
    await f.writeAsBytes(bytes, flush: true);
    await _player.stop();
    await _player.play(DeviceFileSource(f.path));
  }

  @override
  Future<void> stop() => _player.stop();

  @override
  Future<void> dispose() => _player.dispose();
}

/// Records what would have been played (tests, headless runs).
class SilentAudioOut implements AudioOut {
  final List<String> played = [];
  int bytesPlayed = 0;

  @override
  Future<void> play(String pathOrUrl) async => played.add(pathOrUrl);

  @override
  Future<void> playBytes(Uint8List bytes) async => bytesPlayed++;

  @override
  Future<void> stop() async {}

  @override
  Future<void> dispose() async {}
}
