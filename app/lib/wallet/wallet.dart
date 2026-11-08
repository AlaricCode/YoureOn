import 'dart:typed_data';

import '../core/bytes.dart';
import '../crypto/ed25519.dart';
import '../crypto/messages.dart';
import 'key_store.dart';

/// Thrown when the user dismisses or fails the passkey prompt.
class WalletLockedException implements Exception {
  const WalletLockedException();
  @override
  String toString() => 'WalletLockedException';
}

/// The embedded wallet (CONTRACTS.md §12.1, [D-10]): one device-generated
/// ed25519 key in secure storage, unlocked by the passkey/biometric prompt.
/// The public key is readable without a prompt; every signature needs an
/// unlock within [unlockWindow] (acceptance always needs a fresh one).
class Wallet {
  Wallet({
    required this.store,
    required this.authenticator,
    this.unlockWindow = const Duration(seconds: 60),
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  static const String seedKey = 'verdict.wallet.seed.v1';

  final KeyStore store;
  final Authenticator authenticator;
  final Duration unlockWindow;
  final DateTime Function() _clock;

  Ed25519Key? _key;
  DateTime? _unlockedAt;

  /// Loads the key, creating it on first use. No prompt.
  Future<Ed25519Key> _load() async {
    final k = _key;
    if (k != null) return k;
    final hex = await store.read(seedKey);
    final key = hex == null ? await Ed25519Key.generate() : await Ed25519Key.fromSeed(fromHex(hex));
    if (hex == null) await store.write(seedKey, toHex(key.seed));
    return _key = key;
  }

  /// Base58 address (`wallet` in API bodies). Never displayed.
  Future<String> address() async => (await _load()).address;

  Future<Uint8List> publicKey() async => (await _load()).publicKey;

  bool get unlocked {
    final at = _unlockedAt;
    return at != null && _clock().difference(at) < unlockWindow;
  }

  void lock() => _unlockedAt = null;

  /// Shows the device prompt unless still inside the unlock window.
  Future<void> unlock({bool fresh = false}) async {
    if (!fresh && unlocked) return;
    final ok = await authenticator.unlock();
    if (!ok) {
      _unlockedAt = null;
      throw const WalletLockedException();
    }
    _unlockedAt = _clock();
  }

  /// Signs raw bytes behind the prompt.
  Future<Uint8List> sign(List<int> message, {bool fresh = false}) async {
    final key = await _load();
    await unlock(fresh: fresh);
    return key.sign(message);
  }

  /// `wallet_sig` for `POST /auth/session`.
  Future<Uint8List> signLogin(String nonce) => sign(loginMessage(nonce));

  /// `accept_sig` (§4.2); always a fresh prompt.
  Future<Uint8List> signAcceptance({required String programHashHex, required Uint8List wav}) =>
      sign(acceptSigMessage(programHash: fromHex(programHashHex), wavBytes: wav), fresh: true);

  /// Signs a serialized Solana message (`message_b64`).
  Future<Uint8List> signTxMessage(String messageB64) => sign(fromB64(messageB64));
}
