import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/bet.dart';
import 'package:verdict/api/models/draft.dart';
import 'package:verdict/core/bytes.dart';
import 'package:verdict/crypto/ed25519.dart';
import 'package:verdict/crypto/messages.dart';
import 'package:verdict/nav/routes.dart';
import 'package:verdict/screens/scene/scene_check_screen.dart';
import 'package:verdict/screens/terms/terms_screen.dart';
import 'package:verdict/ui/widgets/controls.dart';
import 'package:verdict/ws/ws_messages.dart';

import '../support/copy_rule.dart';
import '../support/fake_server.dart';
import '../support/fixtures.dart';
import '../support/golden.dart';
import '../support/screen_harness.dart';
import '../support/test_app.dart';

Finder _shutter() => find.byType(ShutterButton);

void main() {
  testWidgets('creator: dictate, answer, edit stake, continue once accepted', (tester) async {
    final devices = Devices();
    final s = baseServer()
      ..on('GET /huddles/h1', (_) => huddleJson())
      ..on('POST /agent/session', (_) => {'mode': 'mock', 'signed_url': null})
      ..on('POST /bets/compile', (req) {
        final b = FakeServer.body(req);
        return b.containsKey('answers') ? readyDraftJson(updatedAt: 3) : draftJson();
      })
      ..on('PATCH /drafts/d1', (_) => readyDraftJson(updatedAt: 4))
      ..on('POST /bets', (_) => {'bet': creatorBetJson(), 'sign': signJson('tx-create')})
      ..on('POST /tx/tx-create/submit', (_) => confirmedJson())
      ..on('GET /bets/b1', (_) => creatorBetJson());
    final c = await openScreen(tester, s, Routes.terms, const TermsArgs(huddleId: 'h1'), devices: devices);
    expect(find.byType(TermsScreen), findsOneWidget);

    // Dictate: start, stop → compile with the WAV.
    await tester.tap(_shutter());
    await tester.pumpAndSettle();
    await tester.tap(_shutter());
    await tester.pumpAndSettle();
    expect(s.called('POST /agent/session'), hasLength(1));
    final compile = FakeServer.body(s.called('POST /bets/compile').single);
    expect(compile['huddle_id'], 'h1');
    expect(base64.decode(compile['audio_b64'] as String).sublist(0, 4), ascii.encode('RIFF'));
    expect(find.text('Paper ball shot'), findsWidgets);
    // The clarifying question is spoken, and only its chips are shown.
    expect(devices.audio.played, ['/v1/drafts/d1/q/stake.mp3']);
    expect(find.text('Stake each?'), findsNothing);
    expectCopyRule(tester, screen: 'Terms (questions)');

    await tester.tap(find.byKey(const ValueKey(r'q-stake-$5')));
    await tester.pumpAndSettle();
    final answer = FakeServer.body(s.called('POST /bets/compile').last);
    expect(answer['draft_id'], 'd1');
    expect(answer['answers'], [
      {'question_id': 'stake', 'answer': r'$5'},
    ]);
    expect(find.text('Creator'), findsOneWidget);
    expect(find.text('Waiting'), findsOneWidget);

    // Continue needs every counterparty's acceptance.
    expect(tester.widget<PrimaryButton>(find.widgetWithText(PrimaryButton, 'Continue')).onPressed, isNull);

    // Stake → $10.00 → PATCH.
    await tester.tap(find.text('Stake'));
    await tester.pumpAndSettle();
    expectCopyRule(tester, screen: 'Stake sheet');
    await tester.tap(find.text(r'$10.00'));
    await tester.pumpAndSettle();
    expect(FakeServer.body(s.called('PATCH /drafts/d1').single), {'stake_each_units': 10000000});

    // Ben accepts on his phone: the draft snapshot arrives on huddle:h1.
    c.injectWs(WsDraft('h1', DraftView.fromJson(readyDraftJson(benAccepted: true, updatedAt: 9))));
    await tester.pumpAndSettle();
    expect(find.text('Accepted'), findsOneWidget);
    await tapAsync(tester, find.text('Continue'));
    await tester.pumpAndSettle();
    expect(FakeServer.body(s.called('POST /bets').single), {'draft_id': 'd1'});
    expect(s.called('POST /tx/tx-create/submit'), hasLength(1));
    expect(find.byType(SceneCheckScreen), findsOneWidget);
    c.dispose();
  });

  testWidgets('counterparty: "I accept" with voice and a device signature', (tester) async {
    var accepted = false;
    final s = baseServer(asBen: true)
      ..on('GET /huddles/h1', (_) => huddleJson())
      ..on('GET /drafts/d1', (_) => readyDraftJson(benAccepted: accepted, updatedAt: accepted ? 5 : 2))
      ..on('GET /drafts/d1/accept/challenge', (_) => {'challenge_id': 'ac1', 'phrase': 'I accept red river'})
      ..on('POST /drafts/d1/accept', (_) {
        accepted = true;
        return {'accepted': true, 'cos_bps': 8100, 'participant_index': 1};
      })
      ..on('GET /bets/b1', (_) => creatorBetJson());
    final c = await openScreen(tester, s, Routes.terms, const TermsArgs(huddleId: 'h1', draftId: 'd1'));
    expect(find.byType(ShutterButton), findsNothing, reason: 'only the creator dictates');
    expectCopyRule(tester, screen: 'Terms (counterparty)');

    await tester.tap(find.text('Accept'));
    await tester.pumpAndSettle();
    expect(find.text('I accept red river'), findsOneWidget);
    expectCopyRule(tester, screen: 'Accept sheet');
    await tester.tap(_shutter());
    await tester.pumpAndSettle();
    await tapAsync(tester, _shutter());
    await tester.pumpAndSettle();

    final body = FakeServer.body(s.called('POST /drafts/d1/accept').single);
    expect(body['challenge_id'], 'ac1');
    final wav = base64.decode(body['audio_b64'] as String);
    final key = await Ed25519Key.fromSeed(kSeed);
    final ok = await tester.runAsync(() => ed25519Verify(
          message: acceptSigMessage(programHash: fromHex('ab' * 32), wavBytes: wav),
          signature: base64.decode(body['accept_sig_b64'] as String),
          publicKey: key.publicKey,
        ));
    expect(ok, isTrue);
    expect(find.widgetWithText(QuietButton, 'Accepted'), findsOneWidget);

    // The creator creates the bet: Ben follows to Scene check.
    c.injectWs(WsBet(BetView.fromJson(creatorBetJson())));
    await tester.pumpAndSettle();
    expect(find.byType(SceneCheckScreen), findsOneWidget);
    c.dispose();
  });

  testWidgets('a rejected voice shows the fixed message and a new phrase', (tester) async {
    var n = 0;
    final s = baseServer(asBen: true)
      ..on('GET /huddles/h1', (_) => huddleJson())
      ..on('GET /drafts/d1', (_) => readyDraftJson())
      ..on('GET /drafts/d1/accept/challenge', (_) => {'challenge_id': 'ac${++n}', 'phrase': 'I accept word$n'})
      ..on('POST /drafts/d1/accept', (_) => FakeServer.error('VOICE_NOT_MATCHED'));
    final c = await openScreen(tester, s, Routes.terms, const TermsArgs(huddleId: 'h1', draftId: 'd1'));
    await tester.tap(find.text('Accept'));
    await tester.pumpAndSettle();
    await tester.tap(_shutter());
    await tester.pumpAndSettle();
    await tapAsync(tester, _shutter());
    await tester.pumpAndSettle();
    expect(find.text('Voice not matched'), findsOneWidget);
    expect(find.text('I accept word2'), findsOneWidget);
    c.dispose();
  });
}
