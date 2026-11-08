import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/api_client.dart';
import 'package:verdict/api/models/chunk.dart';
import 'package:verdict/api/transport.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/crypto/ed25519.dart';
import 'package:verdict/crypto/messages.dart';
import 'package:verdict/evidence/chunk_uploader.dart';
import 'package:verdict/evidence/hash_chain.dart';

import '../support/fake_server.dart';
import '../support/golden.dart';

void main() {
  late FakeServer server;
  late ApiClient api;
  late ChunkChain chain;

  setUp(() async {
    server = FakeServer();
    api = ApiClient(ApiTransport(baseUrl: 'http://api.test', client: server.client));
    final key = await Ed25519Key.fromSeed(kSeed);
    chain = ChunkChain(
      betAddress: kBet58,
      witnessKey: key,
      kind: WitnessKind.audio,
      beacon: BeaconRef(slot: kBeaconSlot, hash: fromHex(kBeaconHashHex)),
    );
  });

  test('hash record first, then body; records match §12.3 and the golden chain', () async {
    final order = <String>[];
    server.on('POST /bets/$kBet58/chunks', (r) {
      final b = FakeServer.body(r);
      order.add('record ${b['index']}');
      return {'accepted': true, 'upload_url': '/v1/bets/$kBet58/chunks/$kPub58/${b['index']}'};
    });
    for (var i = 0; i < 3; i++) {
      server.on('PUT /bets/$kBet58/chunks/$kPub58/$i', (r) {
        order.add('body $i');
        expect(r.bodyBytes, utf8.encode('chunk-$i'));
        return {'stored': true};
      });
    }
    final up = ChunkUploader(api: api, betId: kBet58, chain: chain, format: BodyFormat.wav);
    for (var i = 0; i < 3; i++) {
      await up.submit(Uint8List.fromList(utf8.encode('chunk-$i')),
          startMs: kChunkStarts[i], durationMs: kChunkDurations[i], isFinal: i == 2);
    }
    await up.drain();
    expect(order, ['record 0', 'body 0', 'record 1', 'body 1', 'record 2', 'body 2']);
    expect(up.uploaded, 3);

    final recs = server.called('POST /bets/$kBet58/chunks').map(FakeServer.body).toList();
    expect(recs[0], {
      'witness_key': kPub58,
      'index': 0,
      'kind': 'audio',
      'body_format': 'wav',
      'start_ms': 0,
      'duration_ms': 5000,
      'body_sha256': sha256Hex(utf8.encode('chunk-0')),
      'chunk_hash': kChunkHex[0],
      'prev_hash': kGenesisHex,
      'sig_b64': base64.encode(fromHex(kSig0Hex)),
      'final': false,
    });
    expect(recs[2]['prev_hash'], kChunkHex[1]);
    expect(recs[2]['chunk_hash'], kChunkHex[2]);
    expect(recs[2]['final'], isTrue);
    expect(() => up.submit(Uint8List(1), startMs: 20000, durationMs: 1, isFinal: false), throwsStateError);
  });

  test('camera metadata is sent; transport errors retry; semantic errors stop', () async {
    var attempts = 0;
    server.on('POST /bets/$kBet58/chunks', (r) {
      attempts++;
      if (attempts == 1) return FakeServer.error('INTERNAL', 500);
      final b = FakeServer.body(r);
      expect(b['width_px'], 1920);
      expect(b['orientation'], 'landscape');
      if (b['index'] == 1) return FakeServer.error('CAMERA_MISMATCH', 409);
      return {'accepted': true, 'upload_url': '/v1/bets/$kBet58/chunks/$kPub58/${b['index']}'};
    });
    server.on('PUT /bets/$kBet58/chunks/$kPub58/0', (_) => {'stored': true});
    final up = ChunkUploader(
      api: api,
      betId: kBet58,
      chain: ChunkChain(
        betAddress: kBet58,
        witnessKey: chain.witnessKey,
        kind: WitnessKind.camera,
        beacon: chain.beacon,
      ),
      format: BodyFormat.mp4,
      camera: const CameraMeta(widthPx: 1920, heightPx: 1080, orientation: 'landscape'),
      retryBase: const Duration(milliseconds: 1),
    );
    await up.submit(Uint8List(4), startMs: 0, durationMs: 5000, isFinal: false);
    await up.submit(Uint8List(4), startMs: 5100, durationMs: 4900, isFinal: false);
    await up.submit(Uint8List(4), startMs: 10050, durationMs: 4950, isFinal: true);
    await up.drain();
    expect(up.uploaded, 1);
    expect(up.fatalError, 'CAMERA_MISMATCH');
    // Chunk 2 was never posted once the pipeline stopped.
    expect(server.called('POST /bets/$kBet58/chunks').length, 3);
  });
}
