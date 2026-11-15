import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/crypto/ed25519.dart';
import 'package:verdict/crypto/messages.dart';

import '../support/golden.dart';

void main() {
  test('public key from seed matches OpenSSL', () async {
    final k = await Ed25519Key.fromSeed(kSeed);
    expect(toHex(k.publicKey), kPubHex);
    expect(k.address, kPub58);
  });

  test('login signature (§12.3) matches OpenSSL', () async {
    final k = await Ed25519Key.fromSeed(kSeed);
    final msg = loginMessage(kLoginNonce);
    expect(utf8.decode(msg), 'VERDICT/LOGIN/v1nonce-123');
    final sig = await k.sign(msg);
    expect(toHex(sig), kLoginSigHex);
    expect(await ed25519Verify(message: msg, signature: sig, publicKey: k.publicKey), isTrue);
    final tampered = Uint8List.fromList(msg)..[0] ^= 1;
    expect(await ed25519Verify(message: tampered, signature: sig, publicKey: k.publicKey), isFalse);
  });

  test('accept_sig message layout (§4.2)', () {
    final programHash = sha256Bytes(utf8.encode('program'));
    final m = acceptSigMessage(programHash: programHash, wavBytes: utf8.encode('wav-bytes'));
    expect(m.length, 'VERDICT/ACCEPT-SIG/v1'.length + 64);
    expect(utf8.decode(m.sublist(0, 21)), 'VERDICT/ACCEPT-SIG/v1');
    expect(sha256Hex(m), kAcceptMsgShaHex);
    expect(() => acceptSigMessage(programHash: [1, 2], wavBytes: const []), throwsArgumentError);
  });

  test('chunk-sig message', () {
    final c = Uint8List(32);
    final m = chunkSigMessage(c);
    expect(utf8.decode(m.sublist(0, 20)), 'VERDICT/CHUNK-SIG/v1');
    expect(m.length, 52);
  });

  test('generated keys are distinct and 32 bytes', () async {
    final a = await Ed25519Key.generate();
    final b = await Ed25519Key.generate();
    expect(a.publicKey.length, 32);
    expect(a.seed.length, 32);
    expect(a.address == b.address, isFalse);
    expect(() => Ed25519Key.fromSeed([1, 2, 3]), throwsArgumentError);
  });
}
