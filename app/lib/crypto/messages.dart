import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as c;

import '../core/bytes.dart';

/// Domain tags (CONTRACTS.md §0.3: raw ASCII, no terminator, no length).
const String kTagLogin = 'VERDICT/LOGIN/v1';
const String kTagAcceptSig = 'VERDICT/ACCEPT-SIG/v1';
const String kTagChain = 'VERDICT/CHAIN/v1';
const String kTagChunk = 'VERDICT/CHUNK/v1';
const String kTagChunkSig = 'VERDICT/CHUNK-SIG/v1';

Uint8List sha256Bytes(List<int> data) =>
    Uint8List.fromList(c.sha256.convert(data).bytes);

String sha256Hex(List<int> data) => c.sha256.convert(data).toString();

/// `"VERDICT/LOGIN/v1" ‖ utf8(nonce)` — signed by the wallet for
/// `POST /auth/session` (§12.3).
Uint8List loginMessage(String nonce) {
  final w = ByteWriter()
    ..ascii(kTagLogin)
    ..bytes(utf8.encode(nonce));
  return w.toBytes();
}

/// `"VERDICT/ACCEPT-SIG/v1" ‖ program_hash[32] ‖ sha256(wav)[32]` (§4.2
/// `accept_sig`). [programHash] is the 32-byte digest (hex in JSON).
Uint8List acceptSigMessage({
  required List<int> programHash,
  required List<int> wavBytes,
}) {
  final w = ByteWriter()
    ..ascii(kTagAcceptSig)
    ..fixed(programHash, 32)
    ..fixed(sha256Bytes(wavBytes), 32);
  return w.toBytes();
}

/// `"VERDICT/CHUNK-SIG/v1" ‖ c_i` (§7.2).
Uint8List chunkSigMessage(List<int> chunkHash) {
  final w = ByteWriter()
    ..ascii(kTagChunkSig)
    ..fixed(chunkHash, 32);
  return w.toBytes();
}
