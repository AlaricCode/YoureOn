import 'dart:typed_data';

import 'package:camera/camera.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/api_client.dart';
import 'package:verdict/api/models/chunk.dart';
import 'package:verdict/api/transport.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/crypto/ed25519.dart';
import 'package:verdict/evidence/camera_witness.dart';
import 'package:verdict/evidence/chunk_uploader.dart';
import 'package:verdict/evidence/hash_chain.dart';

import '../support/fake_server.dart';
import '../support/golden.dart';

/// A controller whose recording calls are scripted (no platform channel).
class _FakeController extends CameraController {
  _FakeController()
      : super(
          const CameraDescription(name: 'back', lensDirection: CameraLensDirection.back, sensorOrientation: 90),
          ResolutionPreset.low,
        );

  bool disposedController = false;
  bool failStart = false;
  int segments = 0;

  @override
  Future<void> prepareForVideoRecording() async {}

  @override
  Future<void> startVideoRecording({onLatestImageAvailable? onAvailable, bool enablePersistentRecording = true}) async {
    if (disposedController || failStart) throw CameraException('Disposed', 'camera released');
  }

  @override
  Future<XFile> stopVideoRecording() async {
    if (disposedController) throw CameraException('Disposed', 'camera released');
    segments++;
    return XFile.fromData(Uint8List.fromList([0, 0, 0, segments]));
  }
}

void main() {
  late FakeServer server;
  late ChunkUploader uploader;
  late List<Map<String, dynamic>> records;

  setUp(() async {
    server = FakeServer();
    records = [];
    server.on('POST /bets/$kBet58/chunks', (r) {
      final b = FakeServer.body(r);
      records.add(b);
      return {'accepted': true, 'upload_url': '/v1/bets/$kBet58/chunks/$kPub58/${b['index']}'};
    });
    for (var i = 0; i < 8; i++) {
      server.on('PUT /bets/$kBet58/chunks/$kPub58/$i', (_) => {'stored': true});
    }
    final api = ApiClient(ApiTransport(baseUrl: 'http://api.test', client: server.client));
    final key = await Ed25519Key.fromSeed(kSeed);
    final chain = ChunkChain(
      betAddress: kBet58,
      witnessKey: key,
      kind: WitnessKind.camera,
      beacon: BeaconRef(slot: kBeaconSlot, hash: fromHex(kBeaconHashHex)),
    );
    uploader = ChunkUploader(api: api, betId: kBet58, chain: chain, format: BodyFormat.mp4);
  });

  test('stop seals the open segment as the final chunk', () async {
    final c = _FakeController();
    final w = CameraWitnessRecorder(controller: c, uploader: uploader, chunkMs: 60000);
    await w.start();
    await w.stop();
    expect(records.map((r) => r['final']), [true]);
    expect(uploader.uploaded, 1);
  });

  test('a camera lost before the final roll still ends the chain with a final chunk and drains', () async {
    final c = _FakeController();
    final w = CameraWitnessRecorder(controller: c, uploader: uploader, chunkMs: 60000);
    await w.start();
    c.disposedController = true; // e.g. the OS released the camera
    await w.stop(); // must not throw
    expect(records, hasLength(1));
    expect(records.single['final'], true);
    expect(uploader.uploaded, 1);
    expect(w.running, isFalse);
  });

  test('a failed segment restart makes the cut segment final; stop does not hang', () async {
    final c = _FakeController();
    final w = CameraWitnessRecorder(controller: c, uploader: uploader, chunkMs: 20);
    await w.start();
    c.failStart = true;
    await Future<void>.delayed(const Duration(milliseconds: 80));
    await w.stop().timeout(const Duration(seconds: 2));
    expect(records.map((r) => r['final']), [true]);
    expect(w.running, isFalse);
  });
}
