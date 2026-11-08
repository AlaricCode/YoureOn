import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:path_provider/path_provider.dart';

import '../api/transport.dart';
import '../evidence/wav.dart';
import '../ws/ws_messages.dart';
import 'beacon.dart';

/// Local schedule of the start signal (CONTRACTS.md §7.5 step 5, [D-8]):
/// the start sound plays `play_delay_ms` after the WS `start` message, the
/// beacon tones follow immediately, and t0 is the end of the tones.
class BeaconSchedule {
  const BeaconSchedule({required this.receivedAt, required this.playDelayMs, required this.sfxMs});

  final DateTime receivedAt;
  final int playDelayMs;
  final int sfxMs;

  DateTime get sfxAt => receivedAt.add(Duration(milliseconds: playDelayMs));
  DateTime get tonesAt => sfxAt.add(Duration(milliseconds: sfxMs));
  DateTime get t0 => tonesAt.add(const Duration(milliseconds: kBeaconDurationMs));
}

/// Upper bound of the start sound when its length can't be read.
const int kMaxSfxMs = 1500;

/// The start signal as seen by the Record screen: plays (camera phone) or
/// waits for (other phones) the start sound and tones; completes with the
/// local t0 estimate.
abstract class StartSignal {
  Future<DateTime> run(WsStart start, {required String myUserId, DateTime? receivedAt});
  Future<void> dispose();
}

/// Plays the start sound and the beacon tones on the camera phone, and
/// estimates t0 on every phone.
class BeaconPlayer implements StartSignal {
  BeaconPlayer({required this.transport, AudioPlayer? player}) : _player = player ?? AudioPlayer();

  final ApiTransport transport;
  final AudioPlayer _player;

  /// Fetches the start sound (if any) and returns it with its duration.
  Future<(Uint8List?, int)> _sfx(String? url) async {
    if (url == null) return (null, 0);
    try {
      final bytes = await transport.getBytes(url);
      final info = parseWav(bytes);
      final ms = info?.durationMs ?? kMaxSfxMs;
      return (bytes, ms > kMaxSfxMs ? kMaxSfxMs : ms);
    } catch (_) {
      return (null, 0);
    }
  }

  /// Handles WS `start`. Plays only when [myUserId] is `play_on_user_id`.
  /// Completes with the local t0 estimate once the tones have finished (or
  /// would have finished, on phones that don't play).
  @override
  Future<DateTime> run(WsStart start, {required String myUserId, DateTime? receivedAt}) async {
    final received = receivedAt ?? DateTime.now();
    final (sfx, sfxMs) = await _sfx(start.sfxUrl);
    final schedule = BeaconSchedule(receivedAt: received, playDelayMs: start.playDelayMs, sfxMs: sfxMs);
    if (start.playOnUserId != myUserId) {
      await _until(schedule.t0);
      return schedule.t0;
    }

    // Tones are synthesized locally from slot + hash ([D-8]); the server's
    // symbols are used only if they agree.
    final symbols = start.beacon.consistent
        ? start.beacon.symbols
        : beaconSymbols(slot: start.beacon.slot, hash: start.beacon.hash);
    final dir = await getTemporaryDirectory();
    final tonesFile = File('${dir.path}/beacon_${start.betId.hashCode}.wav');
    await tonesFile.writeAsBytes(beaconWav(symbols), flush: true);
    File? sfxFile;
    if (sfx != null) {
      sfxFile = File('${dir.path}/start_${start.betId.hashCode}.${parseWav(sfx) != null ? 'wav' : 'mp3'}');
      await sfxFile.writeAsBytes(sfx, flush: true);
    }

    await _player.setReleaseMode(ReleaseMode.stop);
    await _until(schedule.sfxAt);
    if (sfxFile != null) {
      await _playToEnd(sfxFile.path);
    }
    final tonesStart = DateTime.now();
    await _playToEnd(tonesFile.path);
    return tonesStart.add(const Duration(milliseconds: kBeaconDurationMs));
  }

  Future<void> _playToEnd(String path) async {
    final done = _player.onPlayerComplete.first;
    await _player.play(DeviceFileSource(path));
    await done.timeout(const Duration(seconds: 5), onTimeout: () {});
  }

  Future<void> _until(DateTime at) async {
    final d = at.difference(DateTime.now());
    if (d > Duration.zero) await Future<void>.delayed(d);
  }

  @override
  Future<void> dispose() => _player.dispose();
}
