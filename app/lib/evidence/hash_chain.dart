import 'dart:typed_data';

import '../core/base58.dart';
import '../core/bytes.dart';
import '../crypto/ed25519.dart';
import '../crypto/messages.dart';

/// Witness kinds and their u8 codes (CONTRACTS.md §7.1).
enum WitnessKind {
  camera(0, 'camera'),
  audio(1, 'audio'),
  detections(2, 'detections');

  const WitnessKind(this.code, this.wire);
  final int code;
  final String wire;

  static WitnessKind fromWire(String s) => WitnessKind.values.firstWhere(
        (k) => k.wire == s,
        orElse: () => throw FormatException('unknown witness kind', s),
      );
}

/// Freshness beacon identity used in the chain genesis (§7.5).
class BeaconRef {
  BeaconRef({required this.slot, required this.hash}) {
    if (hash.length != 32) throw ArgumentError('beacon hash must be 32 bytes');
    if (slot.isNegative || slot.bitLength > 64) {
      throw ArgumentError('beacon slot must be u64');
    }
  }

  final BigInt slot;
  final Uint8List hash;
}

/// `G_w = sha256("VERDICT/CHAIN/v1" ‖ bet[32] ‖ witness_key[32] ‖ u8 kind ‖
/// u64 beacon_slot ‖ beacon_hash[32])` (§7.2).
Uint8List chainGenesis({
  required List<int> bet,
  required List<int> witnessKey,
  required WitnessKind kind,
  required BeaconRef beacon,
}) {
  final w = ByteWriter()
    ..ascii(kTagChain)
    ..fixed(bet, 32)
    ..fixed(witnessKey, 32)
    ..u8(kind.code)
    ..u64Big(beacon.slot)
    ..fixed(beacon.hash, 32);
  return sha256Bytes(w.toBytes());
}

/// `c_i = sha256("VERDICT/CHUNK/v1" ‖ prev[32] ‖ u32 i ‖ u8 kind ‖
/// i64 start_ms ‖ u32 duration_ms ‖ sha256(body)[32])` (§7.2).
Uint8List chunkHash({
  required List<int> prev,
  required int index,
  required WitnessKind kind,
  required int startMs,
  required int durationMs,
  required List<int> bodySha256,
}) {
  final w = ByteWriter()
    ..ascii(kTagChunk)
    ..fixed(prev, 32)
    ..u32(index)
    ..u8(kind.code)
    ..i64(startMs)
    ..u32(durationMs)
    ..fixed(bodySha256, 32);
  return sha256Bytes(w.toBytes());
}

/// One sealed chunk: everything the `POST /bets/:id/chunks` hash record needs.
class SealedChunk {
  SealedChunk({
    required this.index,
    required this.kind,
    required this.startMs,
    required this.durationMs,
    required this.bodySha256,
    required this.prevHash,
    required this.chunkHash,
    required this.signature,
  });

  final int index;
  final WitnessKind kind;
  final int startMs;
  final int durationMs;
  final Uint8List bodySha256;
  final Uint8List prevHash;
  final Uint8List chunkHash;
  final Uint8List signature;

  int get endMs => startMs + durationMs;
}

/// Stateful per-witness hash chain. Seals chunk bodies in order, gap-free
/// indices from 0, chunk 0 at device-local `start_ms = 0` (§7.2, [D-20]).
class ChunkChain {
  ChunkChain({
    required this.betAddress,
    required this.witnessKey,
    required this.kind,
    required this.beacon,
  }) : genesis = chainGenesis(
          bet: pubkeyBytes(betAddress),
          witnessKey: witnessKey.publicKey,
          kind: kind,
          beacon: beacon,
        ) {
    _head = genesis;
  }

  final String betAddress;
  final Ed25519Key witnessKey;
  final WitnessKind kind;
  final BeaconRef beacon;
  final Uint8List genesis;

  late Uint8List _head;
  int _next = 0;
  int _lastEnd = 0;

  /// Next chunk index.
  int get nextIndex => _next;

  /// Hash of the last sealed chunk, or `G_w` when empty.
  Uint8List get head => _head;

  /// Seals [body]. Sealing is synchronous with respect to chain state: the
  /// index and prev hash are claimed before the (async) signature is made, so
  /// concurrent calls still produce a consistent chain.
  Future<SealedChunk> seal({
    required List<int> body,
    required int startMs,
    required int durationMs,
  }) {
    final index = _next;
    if (index == 0 && startMs != 0) {
      throw StateError('chunk 0 must start at device-local 0 ms');
    }
    if (index > 0 && startMs < _lastEnd) {
      throw StateError('chunk $index overlaps the previous chunk');
    }
    if (durationMs <= 0) throw ArgumentError('duration must be positive');
    final prev = _head;
    final bodySha = sha256Bytes(body);
    final c = chunkHash(
      prev: prev,
      index: index,
      kind: kind,
      startMs: startMs,
      durationMs: durationMs,
      bodySha256: bodySha,
    );
    _head = c;
    _next = index + 1;
    _lastEnd = startMs + durationMs;
    return witnessKey.sign(chunkSigMessage(c)).then(
          (sig) => SealedChunk(
            index: index,
            kind: kind,
            startMs: startMs,
            durationMs: durationMs,
            bodySha256: bodySha,
            prevHash: prev,
            chunkHash: c,
            signature: sig,
          ),
        );
  }
}

/// Verifies a sequence of sealed chunks against a genesis (used in tests and
/// for local self-checks before upload).
bool verifyChainLinks(Uint8List genesis, List<SealedChunk> chunks) {
  var prev = genesis;
  for (var i = 0; i < chunks.length; i++) {
    final ch = chunks[i];
    if (ch.index != i || !bytesEqual(ch.prevHash, prev)) return false;
    final c = chunkHash(
      prev: prev,
      index: ch.index,
      kind: ch.kind,
      startMs: ch.startMs,
      durationMs: ch.durationMs,
      bodySha256: ch.bodySha256,
    );
    if (!bytesEqual(c, ch.chunkHash)) return false;
    prev = c;
  }
  return true;
}
