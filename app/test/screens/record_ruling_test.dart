import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/bet.dart';
import 'package:verdict/nav/routes.dart';
import 'package:verdict/screens/record/record_screen.dart';
import 'package:verdict/screens/ruling/ruling_screen.dart';
import 'package:verdict/ui/widgets/controls.dart';
import 'package:verdict/ws/ws_messages.dart';

import '../support/copy_rule.dart';
import '../support/fake_server.dart';
import '../support/fixtures.dart';
import '../support/screen_harness.dart';
import '../support/test_app.dart';

WsMessage _start(String betId, String playOn) => WsMessage.fromJson({
      'type': 'start',
      'bet_id': betId,
      'beacon': {'slot': 123456, 'hash_hex': 'ab' * 32},
      'wav_url': null,
      'sfx_url': null,
      'play_on_user_id': playOn,
      'play_delay_ms': 1500,
    });

void main() {
  testWidgets('Record: register, start, start signal, end → Ruling', (tester) async {
    final devices = Devices();
    var state = 'funded';
    final s = baseServer()
      ..on('GET /bets/b1', (_) => {
            ...creatorBetJson(state: state, funded: true),
            'updated_at_ms': state == 'perceiving' ? 1700000000200 : 1700000000000,
          })
      ..on('POST /bets/b1/start', (_) => {'ok': true})
      ..on('POST /bets/b1/end', (_) {
        state = 'perceiving';
        return {'ok': true};
      });
    final c = await openScreen(tester, s, Routes.record, const BetArgs('b1'), devices: devices);
    expect(find.byType(RecordScreen), findsOneWidget);
    final runner = devices.runners['b1']!;
    expect(runner.registered, [true]);
    expect(devices.scene.isOpen, isTrue);
    expect(find.text('0:00'), findsOneWidget);
    expect(find.text('/ 2:00'), findsOneWidget);
    expect(find.text('Witnesses'), findsOneWidget);
    expectCopyRule(tester, screen: 'Record');

    await tester.tap(find.text('Start'));
    await settle(tester);
    expect(s.called('POST /bets/b1/start'), hasLength(1));

    c.injectWs(_start('b1', 'u1'));
    await settle(tester);
    expect(runner.started, isNotNull);
    expect(runner.started!.beacon.slot, BigInt.from(123456));
    expect(devices.signal.runs, ['u1']);

    c.injectWs(WsBet(BetView.fromJson({...creatorBetJson(state: 'live', funded: true), 'updated_at_ms': 1700000000100})));
    await settle(tester);
    expect(find.byWidgetPredicate((w) => w is StatusDot && w.live), findsOneWidget);

    await tester.tap(find.text('End'));
    await settle(tester);
    expect(s.called('POST /bets/b1/end'), hasLength(1));
    expect(runner.ended, isTrue);
    await settle(tester);
    expect(find.byType(RulingScreen), findsOneWidget);
    expect(find.text('Reviewing'), findsOneWidget);
    c.dispose();
  });

  testWidgets('Record: an audio-only phone waits, then records on start', (tester) async {
    final devices = Devices();
    final s = baseServer(asBen: true)..on('GET /bets/b1', (_) => {...betJson(id: 'b1', state: 'funded'), 'preruling': null});
    final c = await openScreen(tester, s, Routes.record, const BetArgs('b1'), devices: devices);
    expect(devices.runners['b1']!.registered, [false]);
    expect(devices.scene.isOpen, isFalse);
    expect(find.text('Start'), findsNothing);
    expect(find.text('Waiting'), findsOneWidget);
    c.injectWs(_start('b1', 'u1'));
    await settle(tester);
    expect(devices.runners['b1']!.started, isNotNull);
    expect(devices.signal.runs, ['u2']);
    c.dispose();
  });

  testWidgets('Ruling: outcome, amount, Agree', (tester) async {
    final s = baseServer(asBen: true)
      ..on('GET /bets/b3', (_) => betJson(id: 'b3'))
      ..on('GET /bets/b3/ruling', (_) => rulingJson())
      ..on('POST /bets/b3/consent', (_) => {'sign': signJson('tx-consent')})
      ..on('POST /tx/tx-consent/submit', (_) => confirmedJson());
    final c = await openScreen(tester, s, Routes.ruling, const BetArgs('b3'));
    expect(find.text('You lose'), findsOneWidget);
    expect(find.text('−\$5.00'), findsOneWidget);
    expect(find.text('Agree'), findsOneWidget);
    expect(find.text('Dispute'), findsOneWidget);
    expectCopyRule(tester, screen: 'Ruling');
    await tapAsync(tester, find.text('Agree'));
    expect(s.called('POST /bets/b3/consent'), hasLength(1));
    expect(s.called('POST /tx/tx-consent/submit'), hasLength(1));
    c.dispose();
  });

  testWidgets('Ruling: Dispute with a reason chip and the bond', (tester) async {
    final s = baseServer(asBen: true)
      ..on('GET /bets/b3', (_) => betJson(id: 'b3'))
      ..on('GET /bets/b3/ruling', (_) => rulingJson())
      ..on('POST /bets/b3/dispute', (_) => {'sign': signJson('tx-dispute'), 'bond_units': 1000000})
      ..on('POST /tx/tx-dispute/submit', (_) => confirmedJson());
    final c = await openScreen(tester, s, Routes.ruling, const BetArgs('b3'));
    await tester.tap(find.text('Dispute'));
    await tester.pumpAndSettle();
    for (final r in ['Wrong outcome', 'Wrong person', 'Bad tracking', 'Other']) {
      expect(find.text(r), findsOneWidget);
    }
    expect(find.text('Bond'), findsOneWidget);
    expect(find.text(r'$1.00'), findsOneWidget);
    expectCopyRule(tester, screen: 'Dispute sheet');
    expect(tester.widget<PrimaryButton>(find.widgetWithText(PrimaryButton, 'Dispute')).onPressed, isNull);
    await tester.tap(find.text('Bad tracking'));
    await tester.pumpAndSettle();
    await tapAsync(tester, find.widgetWithText(PrimaryButton, 'Dispute'));
    expect(FakeServer.body(s.called('POST /bets/b3/dispute').first), {'reason': 3});
    expect(s.called('POST /tx/tx-dispute/submit'), hasLength(1));
    c.dispose();
  });

  testWidgets('Ruling: replay booth while disputed', (tester) async {
    final s = baseServer(asBen: true)
      ..on('GET /bets/b3', (_) => {
            ...betJson(id: 'b3', state: 'disputed'),
            'booth_status': 'judging',
            'dispute': {'by_user_id': 'u2', 'reason': 1, 'bond_units': 1000000},
          })
      ..on('GET /bets/b3/ruling', (_) => {...rulingJson(canRespond: false, amount: null), 'outcome_text': 'Replay booth'});
    final c = await openScreen(tester, s, Routes.ruling, const BetArgs('b3'));
    expect(find.text('Replay booth'), findsOneWidget);
    expect(find.text('Trusted'), findsOneWidget);
    expect(find.text('Judging'), findsOneWidget);
    expect(find.text('Agree'), findsNothing);
    expect(find.text('Receipt'), findsOneWidget);
    expectCopyRule(tester, screen: 'Ruling (booth)');
    c.dispose();
  });

  testWidgets('Ruling: only the camera phone announces on PreRuled', (tester) async {
    final devices = Devices();
    final s = baseServer()
      ..on('GET /bets/b1', (_) => creatorBetJson(state: 'perceiving', funded: true))
      ..on('GET /bets/b1/ruling', (_) => {...rulingJson(), 'outcome_text': 'You win', 'amount_units': 5000000});
    final c = await openScreen(tester, s, Routes.ruling, const BetArgs('b1'), devices: devices);
    expect(find.text('Reviewing'), findsOneWidget);
    expect(devices.audio.played, isEmpty);
    c.injectWs(WsBet(BetView.fromJson({...creatorBetJson(state: 'preruled', funded: true), 'updated_at_ms': 1700000000999})));
    await settle(tester);
    expect(devices.audio.played, ['/bets/b1/announce.mp3']);
    expect(find.text('You win'), findsOneWidget);
    expect(find.text(r'+$5.00'), findsOneWidget);
    c.dispose();
  });
}
