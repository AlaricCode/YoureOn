import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:verdict/api/api_client.dart';
import 'package:verdict/api/api_error.dart';
import 'package:verdict/api/models/calibration.dart';
import 'package:verdict/api/transport.dart';
import 'package:verdict/contracts/error_codes.dart';

import '../support/fake_server.dart';
import '../support/fixtures.dart';

void main() {
  late FakeServer server;
  late ApiTransport t;
  late ApiClient api;

  setUp(() {
    server = FakeServer();
    t = ApiTransport(baseUrl: 'http://api.test', client: server.client);
    api = ApiClient(t);
  });

  test('paths are under /v1, bearer auth except /auth/*', () async {
    server.on('GET /auth/nonce', (_) => {'nonce': 'n1'});
    server.on('GET /me', (_) => userJson());
    t.token = 'tok';
    expect(await api.authNonce(), 'n1');
    await api.me();
    expect(server.called('GET /auth/nonce').single.headers.containsKey('authorization'), isFalse);
    expect(server.called('GET /me').single.headers['authorization'], 'Bearer tok');
  });

  test('session body (§12.3)', () async {
    server.on('POST /auth/session', (_) => {'token': 't', 'user': userJson()});
    final s = await api.createSession(
      provider: 'email',
      credential: 'a@b.co',
      emailCode: '000000',
      wallet: 'W',
      nonce: 'n',
      walletSig: Uint8List.fromList([1, 2, 3]),
    );
    expect(s.token, 't');
    final b = FakeServer.body(server.called('POST /auth/session').single);
    expect(b, {
      'provider': 'email',
      'credential': 'a@b.co',
      'email_code': '000000',
      'wallet': 'W',
      'nonce': 'n',
      'wallet_sig_b64': 'AQID',
    });
  });

  test('error envelope → fixed §12.8 message, not server text', () async {
    server.on('POST /huddles/join', (_) => FakeServer.error('CODE_INVALID'));
    try {
      await api.joinHuddle('000000');
      fail('expected error');
    } on ApiException catch (e) {
      expect(e.code, 'CODE_INVALID');
      expect(e.message, 'Code invalid');
      expect(e.serverMessage, 'server text');
      expect(e.status, 400);
    }
  });

  test('every §12.8 code has a message of at most 3 words', () {
    expect(kErrorMessages.length, 27);
    for (final m in kErrorMessages.values) {
      expect(m.split(' ').length, lessThanOrEqualTo(3), reason: m);
    }
    expect(errorMessage('SOMETHING_NEW'), 'Server error');
  });

  test('non-JSON errors map by status; bad JSON is INTERNAL', () async {
    server.on('GET /balance', (_) => http.Response('oops', 413));
    await expectLater(api.balance(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'CHUNK_TOO_LARGE')));
    server.on('GET /balance', (_) => http.Response('{not json', 200));
    await expectLater(api.balance(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'INTERNAL')));
    server.on('GET /balance', (_) => {'usdc_units': 'x1'});
    await expectLater(api.balance(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'INTERNAL')));
  });

  test('UNAUTHORIZED triggers the sign-out hook', () async {
    var hits = 0;
    t.onUnauthorized = () => hits++;
    server.on('GET /me', (_) => FakeServer.error('UNAUTHORIZED', 401));
    await expectLater(api.me(), throwsA(isA<ApiException>()));
    expect(hits, 1);
  });

  test('bets list with state filter and path encoding', () async {
    server.on('GET /bets', (_) => {
          'bets': [betJson()],
        });
    final bets = await api.bets();
    expect(bets.single.title, 'Paper ball shot');
    server.on('GET /bets/a%20b', (_) => betJson());
    await api.bet('a b');
    expect(server.requests.last.url.toString(), 'http://api.test/v1/bets/a%20b');
  });

  test('compile, patch, accept bodies', () async {
    server.on('POST /bets/compile', (_) => draftJson());
    server.on('PATCH /drafts/d1', (_) => draftJson());
    server.on('POST /drafts/d1/accept', (_) => {'accepted': true, 'cos_bps': 8200, 'participant_index': 1});
    await api.compile(huddleId: 'h1', transcript: 'paper ball', draftId: 'd1', answers: {'stake': r'$5'});
    expect(FakeServer.body(server.called('POST /bets/compile').single), {
      'huddle_id': 'h1',
      'transcript': 'paper ball',
      'draft_id': 'd1',
      'answers': [
        {'question_id': 'stake', 'answer': r'$5'},
      ],
    });
    await api.patchDraft('d1', stakeEachUnits: 5000000, sides: {'u2': 1});
    expect(FakeServer.body(server.called('PATCH /drafts/d1').single), {
      'stake_each_units': 5000000,
      'sides': {'u2': 1},
    });
    final r = await api.accept('d1', challengeId: 'c', audioWav: Uint8List(2), acceptSig: Uint8List(64));
    expect(r.participantIndex, 1);
    final b = FakeServer.body(server.called('POST /drafts/d1/accept').single);
    expect(base64.decode(b['accept_sig_b64'] as String).length, 64);
  });

  test('calibration PUT and raw chunk body upload', () async {
    server.on('PUT /bets/b/calibration', (req) => {'calibration': jsonDecode(req.body), 'calibration_hash': 'cd' * 32});
    server.on('PUT /bets/b/chunks/W/3', (req) {
      expect(req.headers['content-type'], 'application/octet-stream');
      expect(req.bodyBytes, [9, 9]);
      return {'stored': true};
    });
    final cal = Calibration.fromJson(betJson()['calibration']);
    final saved = await api.putCalibration('b', cal);
    expect(saved.calibrationHash, 'cd' * 32);
    await api.putChunkBody('b', 'W', 3, Uint8List.fromList([9, 9]));
    await api.putChunkBody('b', 'W', 3, Uint8List.fromList([9, 9]), uploadUrl: '/v1/bets/b/chunks/W/3');
    await api.putChunkBody('b', 'W', 3, Uint8List.fromList([9, 9]), uploadUrl: 'http://api.test/v1/bets/b/chunks/W/3');
    expect(server.called('PUT /bets/b/chunks/W/3').length, 3);
  });

  test('dispute validates reason and returns bond', () async {
    server.on('POST /bets/b/dispute', (_) => {
          'sign': {'tx_id': 't', 'message_b64': 'AA==', 'expires_at_ms': 0, 'summary': r'Bond $1.00'},
          'bond_units': 1000000,
        });
    final d = await api.dispute('b', 2);
    expect(d.bondUnits, 1000000);
    expect(() => api.dispute('b', 5), throwsArgumentError);
  });

  test('world events query', () async {
    server.on('GET /world/events', (_) => {'events': []});
    await api.worldEvents(q: 'fed', limit: 5);
    expect(server.requests.last.url.queryParameters, {'q': 'fed', 'limit': '5'});
  });
}
