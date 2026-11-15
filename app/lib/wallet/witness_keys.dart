import '../core/bytes.dart';
import '../crypto/ed25519.dart';
import '../evidence/hash_chain.dart';
import 'key_store.dart';

/// Per-bet witness keys (CONTRACTS.md §7.1): a fresh ed25519 key per bet and
/// witness kind, kept only on this device. Persisted so a restarted app can
/// keep extending its chain; not gated by the passkey prompt (chunks are
/// signed every few seconds while recording).
class WitnessKeys {
  WitnessKeys(this.store);
  final KeyStore store;

  final Map<String, Ed25519Key> _cache = {};

  static String _slot(String betId, WitnessKind kind) => 'verdict.witness.$betId.${kind.wire}';

  Future<Ed25519Key> forBet(String betId, WitnessKind kind) async {
    final slot = _slot(betId, kind);
    final cached = _cache[slot];
    if (cached != null) return cached;
    final hex = await store.read(slot);
    final key = hex == null ? await Ed25519Key.generate() : await Ed25519Key.fromSeed(fromHex(hex));
    if (hex == null) await store.write(slot, toHex(key.seed));
    return _cache[slot] = key;
  }

  /// Drops the keys of a finished bet.
  Future<void> forget(String betId) async {
    for (final k in WitnessKind.values) {
      final slot = _slot(betId, k);
      _cache.remove(slot);
      await store.delete(slot);
    }
  }
}
