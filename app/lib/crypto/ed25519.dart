import 'dart:math';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import '../core/base58.dart';

/// An ed25519 keypair held in memory (wallet key or per-bet witness key).
///
/// The 32-byte seed is the only secret; it is what the key store persists.
class Ed25519Key {
  Ed25519Key._(this._seed, this.publicKey, this._pair);

  final Uint8List _seed;
  final SimpleKeyPair _pair;

  /// Raw 32-byte public key.
  final Uint8List publicKey;

  static final Ed25519 _algo = Ed25519();

  /// Base58 public key (Solana `Pubkey` JSON form).
  String get address => base58Encode(publicKey);

  /// Secret seed bytes. Only the key store may read this.
  Uint8List get seed => Uint8List.fromList(_seed);

  static Future<Ed25519Key> fromSeed(List<int> seed) async {
    if (seed.length != 32) {
      throw ArgumentError('ed25519 seed must be 32 bytes');
    }
    final s = Uint8List.fromList(seed);
    final pair = await _algo.newKeyPairFromSeed(s);
    final pub = await pair.extractPublicKey();
    return Ed25519Key._(s, Uint8List.fromList(pub.bytes), pair);
  }

  /// Fresh key from the platform CSPRNG.
  static Future<Ed25519Key> generate([Random? rng]) {
    final r = rng ?? Random.secure();
    return fromSeed(List<int>.generate(32, (_) => r.nextInt(256)));
  }

  /// Detached 64-byte signature over [message].
  Future<Uint8List> sign(List<int> message) async {
    final sig = await _algo.sign(message, keyPair: _pair);
    return Uint8List.fromList(sig.bytes);
  }
}

/// Verifies a detached ed25519 signature.
Future<bool> ed25519Verify({
  required List<int> message,
  required List<int> signature,
  required List<int> publicKey,
}) async {
  if (signature.length != 64 || publicKey.length != 32) return false;
  return Ed25519().verify(
    message,
    signature: Signature(
      signature,
      publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519),
    ),
  );
}
