import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/crypto/ed25519.dart';
import 'package:verdict/crypto/messages.dart';
import 'package:verdict/screens/enroll_screen.dart';
import 'package:verdict/screens/home_screen.dart';
import 'package:verdict/screens/sign_in_screen.dart';

import '../support/copy_rule.dart';
import '../support/fake_server.dart';
import '../support/fixtures.dart';
import '../support/golden.dart';
import '../support/test_app.dart';

void main() {
  late FakeServer server;
  var enrolled = false;

  setUp(() {
    enrolled = false;
    server = FakeServer()
      ..on('GET /auth/nonce', (_) => {'nonce': 'n-1'})
      ..on('POST /auth/email/start', (_) => {'sent': true})
      ..on('POST /auth/session', (_) => {'token': 'tok', 'user': userJson(face: false, voice: false)})
      ..on('GET /me', (_) => userJson(face: enrolled, voice: enrolled))
      ..on('GET /enroll/challenge', (_) => {
            'challenge_id': 'c1',
            'face_prompts': ['left', 'up'],
            'voice_phrases': ['red apple seven', 'blue river nine', 'green stone four'],
          })
      ..on('POST /enroll/face', (_) => {'ok': true, 'liveness': true})
      ..on('POST /enroll/voice', (_) => {'ok': true})
      ..on('POST /enroll/complete', (_) => {
            'face_commit': '01' * 32,
            'voice_commit': '02' * 32,
            'sign': {'tx_id': 'tx1', 'message_b64': base64.encode([7, 7, 7]), 'expires_at_ms': 0, 'summary': 'Profile'},
          })
      ..on('POST /tx/tx1/submit', (_) {
        enrolled = true;
        return {'status': 'confirmed', 'signature': 'sig', 'error': null};
      })
      ..on('DELETE /enroll', (_) => {
            'deleted': true,
            'sign': {'tx_id': 'tx2', 'message_b64': base64.encode([8]), 'expires_at_ms': 0, 'summary': 'Delete'},
          })
      ..on('POST /tx/tx2/submit', (_) {
        enrolled = false;
        return {'status': 'confirmed', 'signature': 'sig2', 'error': null};
      })
      ..on('GET /balance', (_) => {'usdc_units': 50000000})
      ..on('GET /bets', (_) => {
            'bets': [
              betJson(),
              betJson(id: 'b2', state: 'live', title: 'Push-ups', updatedAt: 1700000000001),
            ],
          });
  });

  testWidgets('sign in with email → enroll → home', (tester) async {
    final face = FakeFaceCapture();
    final c = testController(server, face: face);
    await pumpApp(tester, c);
    expect(find.byType(SignInScreen), findsOneWidget);
    expectCopyRule(tester, screen: 'Sign in');

    await tester.tap(find.text('Continue with email'));
    await tester.pumpAndSettle();
    expectCopyRule(tester, screen: 'Email sheet');
    await tester.enterText(find.byKey(const ValueKey('email')), 'Ana@Example.com');
    await tester.pump();
    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();
    expect(FakeServer.body(server.called('POST /auth/email/start').single), {'email': 'ana@example.com'});

    await tester.enterText(find.byKey(const ValueKey('code')), '000000');
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(find.text('Continue'));
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pumpAndSettle();

    // Session request carries a valid wallet signature over the login message.
    final s = FakeServer.body(server.called('POST /auth/session').single);
    expect(s['provider'], 'email');
    expect(s['credential'], 'ana@example.com');
    expect(s['email_code'], '000000');
    expect(s['wallet'], kPub58);
    final key = await Ed25519Key.fromSeed(kSeed);
    expect(
      await ed25519Verify(
        message: loginMessage('n-1'),
        signature: base64.decode(s['wallet_sig_b64'] as String),
        publicKey: key.publicKey,
      ),
      isTrue,
    );

    // Not enrolled → Enroll.
    expect(find.byType(EnrollScreen), findsOneWidget);
    expectCopyRule(tester, screen: 'Enroll');

    // Face: neutral + two prompts.
    await tester.tap(find.text('Face'));
    await tester.pumpAndSettle();
    expect(find.text('Look ahead'), findsOneWidget);
    expectCopyRule(tester, screen: 'Enroll face');
    await tester.tap(find.bySemanticsLabel('Capture'));
    await tester.pumpAndSettle();
    expect(find.text('Turn left'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Capture'));
    await tester.pumpAndSettle();
    expect(find.text('Look up'), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Capture'));
    await tester.pumpAndSettle();
    final faceBody = FakeServer.body(server.called('POST /enroll/face').single);
    expect(faceBody['challenge_id'], 'c1');
    expect((faceBody['frames_b64'] as List).length, 3);

    // Voice: three phrases.
    await tester.tap(find.text('Voice'));
    await tester.pumpAndSettle();
    expect(find.text('red apple seven'), findsOneWidget);
    expectCopyRule(tester, screen: 'Enroll voice');
    for (var i = 0; i < 3; i++) {
      await tester.tap(find.bySemanticsLabel('Record'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Record'));
      await tester.pumpAndSettle();
    }
    final voiceBody = FakeServer.body(server.called('POST /enroll/voice').single);
    expect((voiceBody['clips_b64'] as List).length, 3);

    // Done requires consent.
    expect(server.called('POST /enroll/complete'), isEmpty);
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(server.called('POST /enroll/complete'), isEmpty);
    await tester.tap(find.byKey(const ValueKey('consent')));
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      await tester.tap(find.text('Done'));
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pumpAndSettle();
    expect(FakeServer.body(server.called('POST /enroll/complete').single), {'consent': true, 'display_name': 'Ana'});
    expect(server.called('POST /tx/tx1/submit').length, 1);

    // Enrolled → Home.
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(find.text(r'$50.00'), findsOneWidget);
    expect(find.text('Paper ball shot'), findsOneWidget);
    expect(find.text('Ruled'), findsOneWidget);
    expect(find.text('Live'), findsOneWidget);
    expect(find.text(r'$5.00'), findsNWidgets(2));
    expectCopyRule(tester, screen: 'Home');

    c.dispose();
  });

  testWidgets('wrong face pose shows a fixed error; enrolled mode deletes', (tester) async {
    enrolled = true;
    final face = FakeFaceCapture();
    final c = testController(server, token: 'tok', face: face);
    await pumpApp(tester, c);
    expect(find.byType(HomeScreen), findsOneWidget);

    // Profile row → Enroll in enrolled mode.
    await tester.tap(find.byKey(const ValueKey('profile')));
    await tester.pumpAndSettle();
    expect(find.text('Delete biometrics'), findsOneWidget);
    expectCopyRule(tester, screen: 'Enroll (enrolled)');
    await tester.runAsync(() async {
      await tester.tap(find.text('Delete biometrics'));
      await Future<void>.delayed(const Duration(milliseconds: 200));
    });
    await tester.pumpAndSettle();
    expect(server.called('DELETE /enroll').length, 1);
    expect(server.called('POST /tx/tx2/submit').length, 1);
    expect(find.text('Delete biometrics'), findsNothing);
    expect(find.text('I consent'), findsOneWidget);

    // A frame without a turned head fails the prompt with a §12.8 message.
    face.faces = const [];
    await tester.tap(find.text('Face'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Capture'));
    await tester.pumpAndSettle();
    expect(find.text('Face not matched'), findsOneWidget);

    c.dispose();
  });

  testWidgets('UNAUTHORIZED returns to Sign in', (tester) async {
    server.on('GET /me', (_) => FakeServer.error('UNAUTHORIZED', 401));
    final c = testController(server, token: 'stale');
    await pumpApp(tester, c);
    expect(find.byType(SignInScreen), findsOneWidget);
    c.dispose();
  });
}
