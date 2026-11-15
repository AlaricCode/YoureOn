import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/core/base58.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/crypto/ed25519.dart';
import 'package:verdict/crypto/messages.dart';
import 'package:verdict/evidence/hash_chain.dart';

import '../support/golden.dart';

void main() {
  final beacon = BeaconRef(slot: kBeaconSlot, hash: fromHex(kBeaconHashHex));

  test('bet fixture is sha256("bet")', () {
    expect(toHex(pubkeyBytes(kBet58)), sha256Hex(utf8.encode('bet')));
  });

  test('genesis G_w (§7.2)', () {
    final g = chainGenesis(
      bet: pubkeyBytes(kBet58),
      witnessKey: fromHex(kPubHex),
      kind: WitnessKind.audio,
      beacon: beacon,
    );
    expect(toHex(g), kGenesisHex);
  });

  test('chunk hashes c_0..c_2 (§7.2)', () {
    var prev = fromHex(kGenesisHex);
    for (var i = 0; i < 3; i++) {
      final c = chunkHash(
        prev: prev,
        index: i,
        kind: WitnessKind.audio,
        startMs: kChunkStarts[i],
        durationMs: kChunkDurations[i],
        bodySha256: sha256Bytes(utf8.encode('chunk-$i')),
      );
      expect(toHex(c), kChunkHex[i], reason: 'chunk $i');
      prev = c;
    }
  });

  test('ChunkChain seals, links and signs exactly like the contract', () async {
    final key = await Ed25519Key.fromSeed(kSeed);
    final chain = ChunkChain(betAddress: kBet58, witnessKey: key, kind: WitnessKind.audio, beacon: beacon);
    expect(toHex(chain.genesis), kGenesisHex);
    expect(chain.nextIndex, 0);

    final sealed = <SealedChunk>[];
    for (var i = 0; i < 3; i++) {
      sealed.add(await chain.seal(
        body: utf8.encode('chunk-$i'),
        startMs: kChunkStarts[i],
        durationMs: kChunkDurations[i],
      ));
    }
    expect(sealed.map((c) => toHex(c.chunkHash)).toList(), kChunkHex);
    expect(toHex(sealed[0].prevHash), kGenesisHex);
    expect(toHex(sealed[1].prevHash), kChunkHex[0]);
    expect(toHex(sealed[0].signature), kSig0Hex);
    expect(toHex(chain.head), kChunkHex[2]);
    expect(chain.nextIndex, 3);
    expect(verifyChainLinks(chain.genesis, sealed), isTrue);

    for (final c in sealed) {
      expect(
        await ed25519Verify(message: chunkSigMessage(c.chunkHash), signature: c.signature, publicKey: key.publicKey),
        isTrue,
      );
    }
  });

  test('concurrent seals still form one chain', () async {
    final key = await Ed25519Key.fromSeed(kSeed);
    final chain = ChunkChain(betAddress: kBet58, witnessKey: key, kind: WitnessKind.audio, beacon: beacon);
    final futures = [
      for (var i = 0; i < 3; i++)
        chain.seal(body: utf8.encode('chunk-$i'), startMs: kChunkStarts[i], durationMs: kChunkDurations[i]),
    ];
    final sealed = await Future.wait(futures);
    expect(sealed.map((c) => toHex(c.chunkHash)).toList(), kChunkHex);
  });

  test('chain rules: chunk 0 at 0 ms, no overlap, positive duration', () async {
    final key = await Ed25519Key.fromSeed(kSeed);
    ChunkChain mk() => ChunkChain(betAddress: kBet58, witnessKey: key, kind: WitnessKind.camera, beacon: beacon);

    expect(() => mk().seal(body: [1], startMs: 10, durationMs: 5000), throwsStateError);

    final c = mk();
    await c.seal(body: [1], startMs: 0, durationMs: 5000);
    expect(() => c.seal(body: [2], startMs: 4999, durationMs: 5000), throwsStateError);
    // A tolerated gap is fine.
    final s = await c.seal(body: [2], startMs: 5300, durationMs: 4700);
    expect(s.index, 1);
    expect(() => c.seal(body: [3], startMs: 10000, durationMs: 0), throwsArgumentError);
  });

  test('tampering breaks verification', () async {
    final key = await Ed25519Key.fromSeed(kSeed);
    final chain = ChunkChain(betAddress: kBet58, witnessKey: key, kind: WitnessKind.audio, beacon: beacon);
    final a = await chain.seal(body: [1], startMs: 0, durationMs: 5000);
    final b = await chain.seal(body: [2], startMs: 5000, durationMs: 5000);
    final forged = SealedChunk(
      index: b.index,
      kind: b.kind,
      startMs: b.startMs + 1,
      durationMs: b.durationMs,
      bodySha256: b.bodySha256,
      prevHash: b.prevHash,
      chunkHash: b.chunkHash,
      signature: b.signature,
    );
    expect(verifyChainLinks(chain.genesis, [a, forged]), isFalse);
    expect(verifyChainLinks(chain.genesis, [b]), isFalse);
  });

  test('kind codes', () {
    expect(WitnessKind.camera.code, 0);
    expect(WitnessKind.audio.code, 1);
    expect(WitnessKind.detections.code, 2);
    expect(WitnessKind.fromWire('audio'), WitnessKind.audio);
    expect(() => WitnessKind.fromWire('x'), throwsFormatException);
  });

  test('genesis differs by kind and by beacon', () {
    final base = chainGenesis(bet: pubkeyBytes(kBet58), witnessKey: fromHex(kPubHex), kind: WitnessKind.audio, beacon: beacon);
    final cam = chainGenesis(bet: pubkeyBytes(kBet58), witnessKey: fromHex(kPubHex), kind: WitnessKind.camera, beacon: beacon);
    final other = chainGenesis(
      bet: pubkeyBytes(kBet58),
      witnessKey: fromHex(kPubHex),
      kind: WitnessKind.audio,
      beacon: BeaconRef(slot: kBeaconSlot + BigInt.one, hash: fromHex(kBeaconHashHex)),
    );
    expect(toHex(base) == toHex(cam), isFalse);
    expect(toHex(base) == toHex(other), isFalse);
    expect(() => BeaconRef(slot: BigInt.one, hash: Uint8List(8)), throwsArgumentError);
  });
}
