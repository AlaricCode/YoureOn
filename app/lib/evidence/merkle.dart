import 'dart:typed_data';

import '../core/bytes.dart';
import '../crypto/messages.dart';

/// Merkle tree of CONTRACTS.md §7.3. Leaves are already hashes.
Uint8List merkleRoot(List<Uint8List> leaves) {
  if (leaves.isEmpty) return Uint8List(32);
  var level = List<Uint8List>.of(leaves);
  while (level.length > 1) {
    final next = <Uint8List>[];
    for (var i = 0; i + 1 < level.length; i += 2) {
      next.add(sha256Bytes(concatBytes([
        [0x01],
        level[i],
        level[i + 1],
      ])));
    }
    if (level.length.isOdd) next.add(level.last); // carried up unchanged
    level = next;
  }
  return level.single;
}

/// One sibling of an inclusion proof; `side` is where the sibling sits.
class MerkleSibling {
  const MerkleSibling(this.hash, this.left);
  final Uint8List hash;
  final bool left;

  factory MerkleSibling.fromJson(Map<String, dynamic> j) =>
      MerkleSibling(fromHex(j['hash'] as String), j['side'] == 'L');
}

/// Checks `{leaf, index, siblings}` against [root] (§7.3).
bool verifyMerkleProof({
  required Uint8List leaf,
  required List<MerkleSibling> siblings,
  required Uint8List root,
}) {
  var h = leaf;
  for (final s in siblings) {
    h = s.left
        ? sha256Bytes(concatBytes([
            [0x01],
            s.hash,
            h,
          ]))
        : sha256Bytes(concatBytes([
            [0x01],
            h,
            s.hash,
          ]));
  }
  return bytesEqual(h, root);
}

/// Index value for a witness head with no chunks (§7.4).
const int kEmptyHeadIndex = 0xFFFFFFFF;

/// `leaf_w = sha256(0x00 ‖ witness_key[32] ‖ u32 index_w ‖ hash_w[32])`.
Uint8List evidenceLeaf({
  required List<int> witnessKey,
  required int index,
  required List<int> hash,
}) {
  final w = ByteWriter()
    ..u8(0)
    ..fixed(witnessKey, 32)
    ..u32(index)
    ..fixed(hash, 32);
  return sha256Bytes(w.toBytes());
}
