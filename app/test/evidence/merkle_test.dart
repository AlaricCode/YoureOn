import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/crypto/messages.dart';
import 'package:verdict/evidence/merkle.dart';

import '../support/golden.dart';

void main() {
  final leaves = [for (var i = 0; i < 5; i++) sha256Bytes([i])];

  test('empty and single', () {
    expect(merkleRoot(const []), Uint8List(32));
    expect(merkleRoot([leaves[0]]), leaves[0]);
  });

  test('odd node is carried up (§7.3)', () {
    expect(toHex(merkleRoot(leaves)), kMerkle5Hex);
    expect(toHex(merkleRoot(leaves.sublist(0, 3))), kMerkle3Hex);
  });

  test('inclusion proof with a carried level', () {
    // 5 leaves, index 4: level0 carried (no sibling), level1 carried, level2
    // sibling = root of first four, on the left.
    final l01 = sha256Bytes(concatBytes([[1], leaves[0], leaves[1]]));
    final l23 = sha256Bytes(concatBytes([[1], leaves[2], leaves[3]]));
    final l0123 = sha256Bytes(concatBytes([[1], l01, l23]));
    final ok = verifyMerkleProof(
      leaf: leaves[4],
      siblings: [MerkleSibling(l0123, true)],
      root: fromHex(kMerkle5Hex),
    );
    expect(ok, isTrue);
    final proofJson = {
      'hash': toHex(leaves[1]),
      'side': 'R',
    };
    final s = MerkleSibling.fromJson(proofJson);
    expect(s.left, isFalse);
    expect(verifyMerkleProof(leaf: leaves[0], siblings: [s], root: l01), isTrue);
  });

  test('empty witness head leaf (§7.4)', () {
    final leaf = evidenceLeaf(witnessKey: fromHex(kPubHex), index: kEmptyHeadIndex, hash: fromHex(kGenesisHex));
    expect(toHex(leaf), kEmptyLeafHex);
  });
}
