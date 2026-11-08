import 'dart:async';

import 'package:camera/camera.dart';
import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../api/models/chunk.dart';
import '../contracts/constants.dart';
import '../wallet/witness_keys.dart';
import '../ws/ws_client.dart';
import '../ws/ws_messages.dart';
import 'audio_witness.dart';
import 'camera_witness.dart';
import 'chunk_uploader.dart';
import 'hash_chain.dart';
import 'witness_runner.dart';

/// This phone's witnesses for one bet (CONTRACTS.md §7.1, §7.5 start
/// sequence).
///
/// 1. [register] before Start: an `audio` witness always, plus a `camera`
///    witness on the phone that opens the viewfinder.
/// 2. [begin] when WS `start` arrives: build each chain from the beacon,
///    start recording, reply `{"type":"recording"}`.
/// 3. [end]: keep recording `TAIL_MS`, then seal the final chunks and drain
///    the uploads.
class WitnessSession implements WitnessRunner {
  WitnessSession({required this.api, required this.ws, required this.keys, required this.betId, this.tail = const Duration(milliseconds: TAIL_MS)});

  final ApiClient api;
  final WsClient? ws;
  final Duration tail;
  final WitnessKeys keys;
  final String betId; // Bet PDA, base58

  final Map<WitnessKind, ChunkUploader> _uploaders = {};
  AudioWitnessRecorder? _audio;
  CameraWitnessRecorder? _camera;
  bool _registeredCamera = false;
  bool _began = false;
  bool _ended = false;

  @override
  bool get recording => _began;

  @override
  int get sealedChunks => _uploaders.values.fold(0, (n, u) => n + u.sealed);

  @override
  String? get uploadError {
    for (final u in _uploaders.values) {
      if (u.fatalError != null) return u.fatalError;
    }
    return null;
  }
  Iterable<ChunkUploader> get uploaders => _uploaders.values;

  /// Registers this phone's witness keys. Returns the witness labels.
  @override
  Future<List<String>> register({required bool camera}) async {
    final labels = <String>[];
    final kinds = [if (camera) WitnessKind.camera, WitnessKind.audio];
    for (final k in kinds) {
      final key = await keys.forBet(betId, k);
      final r = await api.registerWitness(betId, witnessKey: key.address, kind: k.wire);
      labels.add(r.label);
    }
    _registeredCamera = camera;
    return labels;
  }

  /// Starts every registered witness on WS `start`.
  @override
  Future<void> begin(WsStart start, {CameraController? controller, CameraMeta? cameraMeta}) async {
    if (_began || start.betId != betId) return;
    _began = true;
    final beacon = BeaconRef(slot: start.beacon.slot, hash: start.beacon.hash);

    Future<ChunkUploader> uploaderFor(WitnessKind kind, BodyFormat format, {CameraMeta? meta}) async {
      final key = await keys.forBet(betId, kind);
      final chain = ChunkChain(betAddress: betId, witnessKey: key, kind: kind, beacon: beacon);
      return _uploaders[kind] = ChunkUploader(api: api, betId: betId, chain: chain, format: format, camera: meta);
    }

    final audioUp = await uploaderFor(WitnessKind.audio, BodyFormat.wav);
    final audio = _audio = AudioWitnessRecorder(uploader: audioUp);

    CameraWitnessRecorder? cam;
    if (_registeredCamera && controller != null) {
      final camUp = await uploaderFor(WitnessKind.camera, BodyFormat.mp4, meta: cameraMeta);
      cam = _camera = CameraWitnessRecorder(controller: controller, uploader: camUp);
    }

    // Start both as close together as possible: a camera witness without
    // its own audio track borrows this device's audio beacon offset.
    await Future.wait([audio.start(), if (cam != null) cam.start()]);
    for (final up in _uploaders.values) {
      ws?.sendRecording(betId, up.witnessKey);
    }
  }

  /// End: recording continues `TAIL_MS`, then all witnesses finalize.
  @override
  Future<void> end() async {
    if (!_began || _ended) return;
    _ended = true;
    await Future<void>.delayed(tail);
    // One witness failing must not hide the other's final chunk, and the
    // microphone is always released.
    Future<void> quietly(Future<void> Function() f, String what) async {
      try {
        await f();
      } catch (e) {
        debugPrint('witness $what stop: $e');
      }
    }

    try {
      await Future.wait([
        if (_camera != null) quietly(_camera!.stop, 'camera'),
        if (_audio != null) quietly(_audio!.stop, 'audio'),
      ]);
    } finally {
      await _audio?.dispose();
    }
  }
}
