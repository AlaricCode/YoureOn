import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/api_client.dart';
import 'package:verdict/api/api_error.dart';
import 'package:verdict/api/models/sign.dart';
import 'package:verdict/api/transport.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/crypto/ed25519.dart';
import 'package:verdict/crypto/messages.dart';
import 'package:verdict/evidence/hash_chain.dart';
import 'package:verdict/wallet/key_store.dart';
import 'package:verdict/wallet/tx_signer.dart';
import 'package:verdict/wallet/wallet.dart';
import 'package:verdict/wallet/witness_keys.dart';

import '../support/fake_server.dart';
import '../support/golden.dart';

void main() {
  group('Wallet', () {
    test('creates once, persists the seed, reloads the same key', () async {
      final store = MemoryKeyStore();
      final a = Wallet(store: store, authenticator: AllowAuthenticator());
      final addr = await a.address();
      expect(store.data[Wallet.seedKey], isNotNull);
      final b = Wallet(store: store, authenticator: AllowAuthenticator());
      expect(await b.address(), addr);
    });

    test('golden seed gives the golden address and login signature', () async {
      final store = MemoryKeyStore()..data[Wallet.seedKey] = toHex(kSeed);
      final w = Wallet(store: store, authenticator: AllowAuthenticator());
      expect(await w.address(), kPub58);
      expect(toHex(await w.signLogin(kLoginNonce)), kLoginSigHex);
    });

    test('address needs no prompt; signing prompts once per window', () async {
      var now = DateTime(2026);
      final auth = AllowAuthenticator();
      final w = Wallet(store: MemoryKeyStore(), authenticator: auth, clock: () => now);
      await w.address();
      expect(auth.prompts, 0);
      await w.sign([1]);
      await w.sign([2]);
      expect(auth.prompts, 1);
      now = now.add(const Duration(seconds: 61));
      await w.sign([3]);
      expect(auth.prompts, 2);
      // Acceptance always prompts.
      await w.signAcceptance(programHashHex: 'ab' * 32, wav: utf8.encode('x'));
      expect(auth.prompts, 3);
    });

    test('dismissed prompt throws WalletLockedException', () async {
      final auth = AllowAuthenticator()..answer = false;
      final w = Wallet(store: MemoryKeyStore(), authenticator: auth);
      await expectLater(w.sign([1]), throwsA(isA<WalletLockedException>()));
      expect(w.unlocked, isFalse);
    });

    test('accept_sig verifies over the §4.2 message', () async {
      final w = Wallet(store: MemoryKeyStore(), authenticator: AllowAuthenticator());
      final wav = utf8.encode('wav-bytes');
      final sig = await w.signAcceptance(programHashHex: 'ab' * 32, wav: wav);
      final msg = acceptSigMessage(programHash: fromHex('ab' * 32), wavBytes: wav);
      expect(await ed25519Verify(message: msg, signature: sig, publicKey: await w.publicKey()), isTrue);
    });
  });

  group('WitnessKeys', () {
    test('one key per bet and kind, persisted, forgettable', () async {
      final store = MemoryKeyStore();
      final k = WitnessKeys(store);
      final cam = await k.forBet('bet1', WitnessKind.camera);
      final mic = await k.forBet('bet1', WitnessKind.audio);
      final other = await k.forBet('bet2', WitnessKind.camera);
      expect(cam.address == mic.address, isFalse);
      expect(cam.address == other.address, isFalse);
      expect((await WitnessKeys(store).forBet('bet1', WitnessKind.camera)).address, cam.address);
      await k.forget('bet1');
      expect(store.data.keys.where((s) => s.contains('bet1')), isEmpty);
    });
  });

  group('TxSigner (§12.1)', () {
    late FakeServer server;
    late ApiClient api;
    late Wallet wallet;

    setUp(() async {
      server = FakeServer();
      api = ApiClient(ApiTransport(baseUrl: 'http://api.test', client: server.client));
      wallet = Wallet(store: MemoryKeyStore()..data[Wallet.seedKey] = toHex(kSeed), authenticator: AllowAuthenticator());
    });

    SignRequest req(String id, {int expires = 0}) =>
        SignRequest(txId: id, messageB64: base64.encode([1, 2, 3]), expiresAtMs: expires, summary: r'Stake $5.00');

    test('signs message bytes and submits', () async {
      server.on('POST /tx/t1/submit', (r) {
        final sig = base64.decode(FakeServer.body(r)['signature_b64'] as String);
        expect(sig.length, 64);
        return {'status': 'confirmed', 'signature': 'solsig', 'error': null};
      });
      final res = await TxSigner(api: api, wallet: wallet).run(() async => req('t1'));
      expect(res.signature, 'solsig');
      final k = await Ed25519Key.fromSeed(kSeed);
      final sig = base64.decode(FakeServer.body(server.called('POST /tx/t1/submit').single)['signature_b64'] as String);
      expect(await ed25519Verify(message: [1, 2, 3], signature: sig, publicKey: k.publicKey), isTrue);
    });

    test('TX_EXPIRED re-requests once, automatically', () async {
      var requests = 0;
      server.on('POST /tx/t1/submit', (_) => FakeServer.error('TX_EXPIRED', 409));
      server.on('POST /tx/t2/submit', (_) => {'status': 'confirmed', 'signature': 's2', 'error': null});
      final res = await TxSigner(api: api, wallet: wallet).run(() async {
        requests++;
        return req('t2');
      }, first: req('t1'));
      expect(res.signature, 's2');
      expect(requests, 1);
    });

    test('locally expired payload is re-requested without submitting', () async {
      server.on('POST /tx/t2/submit', (_) => {'status': 'confirmed', 'signature': 's2', 'error': null});
      final signer = TxSigner(api: api, wallet: wallet, nowMs: () => 100);
      final res = await signer.run(() async => req('t2', expires: 200), first: req('t1', expires: 50));
      expect(res.signature, 's2');
      expect(server.called('POST /tx/t1/submit'), isEmpty);
    });

    test('only one retry; failures surface their code', () async {
      server.on('POST /tx/t1/submit', (_) => FakeServer.error('TX_EXPIRED', 409));
      await expectLater(
        TxSigner(api: api, wallet: wallet).run(() async => req('t1')),
        throwsA(isA<ApiException>().having((e) => e.code, 'code', 'TX_EXPIRED')),
      );
      expect(server.called('POST /tx/t1/submit').length, 2);

      server.on('POST /tx/t3/submit', (_) => {
            'status': 'failed',
            'signature': null,
            'error': {'code': 'INSUFFICIENT_FUNDS', 'message': 'x'},
          });
      await expectLater(
        TxSigner(api: api, wallet: wallet).run(() async => req('t3')),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', 'Insufficient balance')),
      );
    });
  });
}
