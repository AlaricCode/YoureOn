// Copy rule (CONTRACTS.md §12.12): walks every screen and fails on any
// label longer than 3 words or any smaller text below a label. Screens
// added later register a case in `cases` below.

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/contracts/error_codes.dart';
import 'package:verdict/nav/routes.dart';
import 'package:verdict/nav/screen_table.dart';
import 'package:verdict/ui/widgets/text.dart';

import 'support/copy_rule.dart';
import 'support/fake_server.dart';
import 'support/fixtures.dart';
import 'support/test_app.dart';

FakeServer _server({bool enrolled = true}) => FakeServer()
  ..on('GET /me', (_) => userJson(face: enrolled, voice: enrolled))
  ..on('GET /balance', (_) => {'usdc_units': 12345670000})
  ..on('GET /bets', (_) => {
        'bets': [
          betJson(title: 'Paper ball shot into the bin'),
          betJson(id: 'b2', state: 'settled', settlement: {
            'path': 'consent',
            'winner_mask': 2,
            'payouts': [],
            'tx_signature': 's',
          }),
          betJson(id: 'b3', state: 'disputed'),
        ],
      })
  ..on('POST /huddles', (_) => {'huddle_id': 'h1', 'code': '482913'})
  ..on('GET /huddles/h1', (_) => huddleJson())
  ..on('GET /drafts/d1', (_) => draftJson())
  ..on('GET /bets/scene', (_) => creatorBetJson(id: 'scene'))
  ..on('GET /bets/record', (_) => creatorBetJson(id: 'record', state: 'funded', funded: true))
  ..on('GET /bets/ruling', (_) => betJson(id: 'ruling'))
  ..on('GET /bets/ruling/ruling', (_) => rulingJson())
  ..on('GET /bets/receipt', (_) => betJson(id: 'receipt', state: 'settled'))
  ..on('GET /bets/receipt/receipt', (_) => {'rows': receiptRowsJson()})
  ..on('GET /pay/challenge', (_) => {'challenge_id': 'pc1', 'face_prompt': 'left'})
  ..on('GET /world/events', (_) => {
        'events': [worldEventJson()],
      });

Object? _argsFor(String route) => switch (route) {
      Routes.huddle => const HuddleArgs(),
      Routes.terms => const TermsArgs(huddleId: 'h1', draftId: 'd1'),
      Routes.world => const WorldArgs(),
      Routes.pay => null,
      Routes.scene => const BetArgs('scene'),
      Routes.record => const BetArgs('record'),
      Routes.ruling => const BetArgs('ruling'),
      Routes.receipt => const BetArgs('receipt'),
      _ => null,
    };

void main() {
  testWidgets('Sign in', (tester) async {
    final c = testController(_server());
    await pumpApp(tester, c);
    expectCopyRule(tester, screen: 'Sign in');
    await tester.tap(find.text('Continue with Google'));
    await tester.pumpAndSettle();
    expectCopyRule(tester, screen: 'Google sheet');
    c.dispose();
  });

  testWidgets('Enroll (not enrolled)', (tester) async {
    final c = testController(_server(enrolled: false), token: 't');
    await pumpApp(tester, c);
    expect(find.text('I consent'), findsOneWidget);
    expectCopyRule(tester, screen: 'Enroll');
    c.dispose();
  });

  testWidgets('Home and Enroll (enrolled)', (tester) async {
    final c = testController(_server(), token: 't');
    await pumpApp(tester, c);
    expect(find.text(r'$12,345.67'), findsOneWidget);
    expectCopyRule(tester, screen: 'Home');
    await tester.tap(find.byKey(const ValueKey('profile')));
    await tester.pumpAndSettle();
    expectCopyRule(tester, screen: 'Enroll (enrolled)');
    c.dispose();
  });

  testWidgets('every registered route renders within the copy rule', (tester) async {
    final c = testController(_server(), token: 't');
    await pumpApp(tester, c);
    final nav = tester.state<NavigatorState>(find.byType(Navigator).first);
    for (final name in screenTable.keys) {
      if (name == Routes.signIn || name == Routes.enroll || name == Routes.home) continue;
      nav.pushNamed(name, arguments: _argsFor(name));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 200));
      expect(find.text('Not found'), findsNothing, reason: name);
      expect(find.text('Server error'), findsNothing, reason: name);
      expectCopyRule(tester, screen: name);
      nav.pop();
      await tester.pumpAndSettle();
    }
    c.dispose();
  });

  testWidgets('the checker itself catches subtitles and long labels', (tester) async {
    Future<bool> violates(Widget w) async {
      await tester.pumpWidget(Directionality(textDirection: TextDirection.ltr, child: Center(child: w)));
      try {
        expectCopyRule(tester);
        return false;
      } on TestFailure {
        return true;
      }
    }

    expect(await violates(const Text('Way too many words here')), isTrue);
    expect(await violates(const DataText('A long bet title from data')), isFalse);
    expect(
      await violates(const Column(mainAxisSize: MainAxisSize.min, children: [
        Text('Face', style: TextStyle(fontSize: 17)),
        Text('Scan', style: TextStyle(fontSize: 13)),
      ])),
      isTrue,
    );
    expect(
      await violates(const Column(mainAxisSize: MainAxisSize.min, children: [
        Text('Balance', style: TextStyle(fontSize: 15)),
        DataText(r'$5.00', style: TextStyle(fontSize: 28)),
      ])),
      isFalse,
    );
    expect(await violates(const Text('Nice \u{1F389}')), isTrue);
  });

  test('error messages are short noun phrases', () {
    for (final m in kErrorMessages.values) {
      expect(m.split(' ').length, inInclusiveRange(1, 3));
      expect(m.endsWith('.'), isFalse);
    }
  });
}
