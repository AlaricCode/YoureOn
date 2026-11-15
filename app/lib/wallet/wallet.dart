import 'dart:typed_data';

import '../api/api_error.dart';
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
/// unlock within [unlockWindow] (acceptance and money-moving transactions
/// always need a fresh one; signing in doesn't open the window).
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
  Future<void> unlock({bool fresh = false, String? reason}) async {
    if (!fresh && unlocked) return;
    final ok = await authenticator.unlock(reason: reason);
    if (!ok) {
      _unlockedAt = null;
      throw const WalletLockedException();
    }
    _unlockedAt = _clock();
  }

  /// Signs raw bytes behind the prompt.
  Future<Uint8List> sign(List<int> message, {bool fresh = false, String? reason}) async {
    final key = await _load();
    await unlock(fresh: fresh, reason: reason);
    return key.sign(message);
  }

  /// `wallet_sig` for `POST /auth/session`. Signing in does not open the
  /// unlock window for later transactions.
  Future<Uint8List> signLogin(String nonce) async {
    try {
      return await sign(loginMessage(nonce));
    } finally {
      lock();
    }
  }

  /// `accept_sig` (§4.2); always a fresh prompt.
  Future<Uint8List> signAcceptance({required String programHashHex, required Uint8List wav}) =>
      sign(acceptSigMessage(programHash: fromHex(programHashHex), wavBytes: wav), fresh: true);

  /// Signs a serialized Solana message (`message_b64`) after checking its
  /// shape, so server-supplied bytes can't be a login or acceptance message
  /// (or any non-transaction) signed with the same key. [summary] is the
  /// prompt reason; [fresh] forces a prompt (money-moving transactions).
  Future<Uint8List> signTxMessage(String messageB64, {String? summary, bool fresh = false}) async {
    final Uint8List bytes;
    try {
      bytes = fromB64(messageB64);
    } on FormatException {
      throw ApiException('TX_FAILED');
    }
    checkTxMessage(bytes, await publicKey());
    return sign(bytes, fresh: fresh, reason: summary);
  }

  /// Throws `TX_FAILED` unless [m] looks like a legacy or v0 Solana message
  /// that [signer] must sign: header, compact-u16 key count ≥ required
  /// signatures, room for the keys and blockhash, [signer] among the
  /// signing keys, and no `VERDICT/` domain tag.
  static void checkTxMessage(Uint8List m, Uint8List signer) {
    Never bad() => throw ApiException('TX_FAILED');
    if (m.isEmpty) bad();
    const tag = 'VERDICT/';
    if (m.length >= tag.length && String.fromCharCodes(m.sublist(0, tag.length)) == tag) bad();
    var i = 0;
    if (m[0] & 0x80 != 0) {
      if (m[0] != 0x80) bad(); // only v0
      i = 1;
    }
    if (m.length < i + 4) bad();
    final nSig = m[i];
    final nRoSigned = m[i + 1];
    final nRoUnsigned = m[i + 2];
    if (nSig < 1 || nSig > 16 || nRoSigned >= nSig) bad();
    i += 3;
    var count = 0;
    var shift = 0;
    for (var k = 0;; k++) {
      if (k >= 3 || i >= m.length) bad();
      final b = m[i++];
      count |= (b & 0x7f) << shift;
      shift += 7;
      if (b & 0x80 == 0) break;
    }
    if (count < nSig || count > 256 || nRoUnsigned > count - nSig) bad();
    if (m.length < i + 32 * count + 32) bad();
    for (var k = 0; k < nSig; k++) {
      final off = i + 32 * k;
      var same = true;
      for (var j = 0; j < 32; j++) {
        if (m[off + j] != signer[j]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    bad();
  }
}
