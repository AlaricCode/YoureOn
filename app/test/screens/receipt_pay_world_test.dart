import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:verdict/nav/routes.dart';
import 'package:verdict/screens/huddle/huddle_screen.dart';
import 'package:verdict/screens/ruling/ruling_screen.dart';
import 'package:verdict/ui/widgets/controls.dart';

import '../support/copy_rule.dart';
import '../support/fake_server.dart';
import '../support/fixtures.dart';
import '../support/screen_harness.dart';
import '../support/test_app.dart';

Map<String, dynamic> _ben() => userJson(id: 'u2', name: 'Ben', wallet: 'jX5drmcKNVNaeBTsLD4TZC183vsMpJqdALAz8a1BQG9');

void main() {
  testWidgets('Receipt: six link rows, detail sheets, external links', (tester) async {
    final devices = Devices();
    final s = baseServer()
      ..on('GET /bets/b1/receipt', (_) => {'rows': receiptRowsJson()})
      ..on('GET /bets/b1/terms.yaml', (_) => http.Response('version: 2\nkind: rules\n', 200));
    final c = await openScreen(tester, s, Routes.receipt, const BetArgs('b1'), devices: devices);
    for (final l in ['Verified', 'Terms', 'Evidence', 'Compute', 'Proof', 'Settlement']) {
      expect(find.text(l), findsOneWidget);
    }
    expect(find.text('Pending'), findsOneWidget);
    expectCopyRule(tester, screen: 'Receipt');

    await tester.tap(find.text('Verified'));
    await tester.pumpAndSettle();
    expect(find.text('Accepted · 81%'), findsOneWidget);
    expect(find.text('Cross-check'), findsOneWidget);
    expect(find.text('Passed'), findsOneWidget);
    expect(find.text('Face · 4.2s'), findsOneWidget);
    expectCopyRule(tester, screen: 'Verified sheet');
    await tester.tapAt(const Offset(195, 40));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Settlement'));
    await tester.pumpAndSettle();
    expect(find.text('Consent'), findsOneWidget);
    await tester.tap(find.text('Explorer'));
    await tester.pumpAndSettle();
    expect(devices.links.single.toString(), 'https://explorer.solana.com/tx/settle');
    await tester.tapAt(const Offset(195, 40));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Terms'));
    await tester.pumpAndSettle();
    // The rules file needs the session: fetched in-app (API origin, bearer
    // token), never handed to the external browser.
    final linksBefore = devices.links.length;
    await tester.runAsync(() async {
      await tester.tap(find.text('Rules file'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pumpAndSettle();
    expect(devices.links.length, linksBefore);
    final get = s.called('GET /bets/b1/terms.yaml').single;
    expect(get.url.origin, 'http://api.test');
    expect(get.headers['authorization'], 'Bearer t');
    expect(find.byKey(const ValueKey('rules-file')), findsOneWidget);
    expect(find.textContaining('kind: rules'), findsOneWidget);
    expectCopyRule(tester, screen: 'Rules file');
    c.dispose();
  });

  testWidgets('Pay: face scan with a liveness prompt, amount, send', (tester) async {
    var challenges = 0;
    final s = baseServer()
      ..on('GET /pay/challenge', (_) => {'challenge_id': 'pc${++challenges}', 'face_prompt': 'left'})
      ..on('POST /pay/scan', (_) => {
            'matches': [
              {'user': _ben(), 'cos_bps': 8000, 'matched': true},
            ],
            'liveness': true,
          })
      ..on('POST /pay', (_) => {'sign': signJson('tx-pay', summary: r'Pay $2.50')})
      ..on('POST /tx/tx-pay/submit', (_) => confirmedJson());
    final c = await openScreen(tester, s, Routes.pay, null);
    expect(find.text('Look ahead'), findsOneWidget);
    expectCopyRule(tester, screen: 'Pay');
    await tester.tap(find.byType(ShutterButton));
    await tester.pumpAndSettle();
    expect(find.text('Turn left'), findsOneWidget);
    await tester.tap(find.byType(ShutterButton));
    await tester.pumpAndSettle();
    final scan = FakeServer.body(s.called('POST /pay/scan').single);
    expect(scan['challenge_id'], 'pc1');
    expect((scan['faces_b64'] as List).length, 2);
    expect(find.byKey(const ValueKey('pay-name')), findsOneWidget);
    expect(find.text('Ben'), findsOneWidget);
    expectCopyRule(tester, screen: 'Pay (matched)');

    await tester.enterText(find.byKey(const ValueKey('pay-amount')), '2.50');
    await tester.pump();
    await tapAsync(tester, find.text('Send'));
    expect(FakeServer.body(s.called('POST /pay').single), {'to_user_id': 'u2', 'amount_units': 2500000});
    expect(s.called('POST /tx/tx-pay/submit'), hasLength(1));
    expect(find.text('Sent'), findsOneWidget);
    c.dispose();
  });

  testWidgets('Pay: voice fallback when the face is not matched', (tester) async {
    final s = baseServer()
      ..on('GET /pay/challenge', (_) => {'challenge_id': 'pc', 'face_prompt': 'up'})
      ..on('POST /pay/scan', (_) => {'matches': [], 'liveness': true})
      ..on('POST /pay/voice', (_) => {
            'matches': [
              {'user': _ben(), 'cos_bps': 7000, 'matched': true},
            ],
          });
    final c = await openScreen(tester, s, Routes.pay, null);
    expect(find.text('Voice'), findsNothing);
    await tester.tap(find.byType(ShutterButton));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(ShutterButton));
    await tester.pumpAndSettle();
    expect(find.text('Face not matched'), findsOneWidget);
    await tester.tap(find.text('Voice'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Stop'));
    await tester.pumpAndSettle();
    expect(s.called('POST /pay/voice'), hasLength(1));
    expect(find.text('Ben'), findsOneWidget);
    c.dispose();
  });

  testWidgets('World: search, event, odds, stake split, propose', (tester) async {
    final s = baseServer()
      ..on('GET /world/events', (_) => {
            'events': [worldEventJson()],
          })
      ..on('GET /world/events/e1', (_) => worldEventJson())
      ..on('GET /huddles/h1', (_) => huddleJson())
      ..on('POST /world/quote', (_) => quoteJson())
      ..on('POST /world/bets', (_) => {
            'bet': {...betJson(id: 'wb1', state: 'proposed', myIndex: 0), 'kind': 'market', 'preruling': null},
            'sign': signJson('tx-world'),
          })
      ..on('POST /tx/tx-world/submit', (_) => confirmedJson())
      ..on('GET /bets/wb1', (_) => {...betJson(id: 'wb1', state: 'proposed', myIndex: 0), 'kind': 'market', 'preruling': null});
    final c = await openScreen(tester, s, Routes.world, const WorldArgs(huddleId: 'h1'));
    expect(find.text('Fed cuts rates in December'), findsOneWidget);
    expectCopyRule(tester, screen: 'World');

    await tester.tap(find.text('Fed cuts rates in December'));
    await tester.pumpAndSettle();
    expect(find.text('70%'), findsOneWidget);
    expect(find.text('30%'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('pick-c1-yes')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('world-total')), '10');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    final q = FakeServer.body(s.called('POST /world/quote').last);
    expect(q, {
      'legs': [
        {'event_id': 'e1', 'contract_id': 'c1', 'side': 'yes'},
      ],
      'total_units': 10000000,
    });
    await tester.scrollUntilVisible(find.byKey(const ValueKey('stake-split')), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text(r'$7.00 / $3.00'), findsOneWidget);
    expectCopyRule(tester, screen: 'World (quote)');

    // Ben is the only confirmed member besides me: preselected.
    await tapAsync(tester, find.text('Propose'));
    expect(FakeServer.body(s.called('POST /world/bets').first), {'quote_id': 'q1', 'counterparty_user_id': 'u2'});
    expect(s.called('POST /tx/tx-world/submit'), hasLength(1));
    expect(find.byType(RulingScreen), findsOneWidget);
    c.dispose();
  });

  Future<FakeServer> worldTo(WidgetTester tester, FakeServer s) async {
    await tester.tap(find.text('Fed cuts rates in December'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('pick-c1-yes')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('world-total')), '10');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    return s;
  }

  FakeServer worldServer({required Map<String, dynamic> Function(int n) quote}) {
    var quotes = 0;
    var bets = 0;
    return baseServer()
      ..on('GET /world/events', (_) => {
            'events': [worldEventJson()],
          })
      ..on('GET /world/events/e1', (_) => worldEventJson())
      ..on('GET /huddles/h1', (_) => huddleJson())
      ..on('POST /world/quote', (_) => quote(++quotes))
      ..on('POST /world/bets', (_) {
        bets++;
        final id = 'wb$bets';
        return {
          'bet': {...betJson(id: id, state: 'proposed', myIndex: 0), 'kind': 'market', 'preruling': null},
          'sign': signJson('tx-world$bets'),
        };
      })
      ..on('POST /tx/tx-world1/submit', (_) => FakeServer.error('TX_EXPIRED', 409))
      ..on('POST /tx/tx-world2/submit', (_) => confirmedJson())
      ..on('GET /bets/wb2', (_) => {...betJson(id: 'wb2', state: 'proposed', myIndex: 0), 'kind': 'market', 'preruling': null});
  }

  testWidgets('World: a TX_EXPIRED retry re-quotes (quotes are single-use) and opens the new bet', (tester) async {
    final s = worldServer(quote: (n) => {...quoteJson(), 'quote_id': 'q$n'});
    final c = await openScreen(tester, s, Routes.world, const WorldArgs(huddleId: 'h1'));
    await worldTo(tester, s);
    final quotesBefore = s.called('POST /world/quote').length;
    await tapAsync(tester, find.text('Propose'));
    final bets = s.called('POST /world/bets').map(FakeServer.body).toList();
    expect(bets.map((b) => b['quote_id']), ['q$quotesBefore', 'q${quotesBefore + 1}']);
    expect(bets.map((b) => b['counterparty_user_id']), ['u2', 'u2']);
    expect(s.called('POST /tx/tx-world2/submit'), hasLength(1));
    expect(find.byType(RulingScreen), findsOneWidget);
    expect(c.bets.map((b) => b.id), contains('wb2'));
    c.dispose();
  });

  testWidgets('World: a retry at a different price stops with "Price changed"', (tester) async {
    final s = worldServer(quote: (n) => n <= 1 ? {...quoteJson(), 'quote_id': 'q$n'} : {...quoteJson(), 'quote_id': 'q$n', 'p_bps': 6000, 'proposer_units': 6000000, 'counterparty_units': 4000000});
    final c = await openScreen(tester, s, Routes.world, const WorldArgs(huddleId: 'h1'));
    await worldTo(tester, s);
    await tapAsync(tester, find.text('Propose'));
    expect(s.called('POST /world/bets'), hasLength(1), reason: 'never signs an unseen price');
    expect(s.called('POST /tx/tx-world2/submit'), isEmpty);
    expect(find.text('Price changed'), findsOneWidget);
    c.dispose();
  });

  testWidgets('World: no counterparty → a Huddle way forward', (tester) async {
    final s = baseServer()
      ..on('GET /world/events', (_) => {
            'events': [worldEventJson()],
          })
      ..on('GET /world/events/e1', (_) => worldEventJson())
      ..on('POST /world/quote', (_) => quoteJson())
      ..on('POST /huddles', (_) => {'huddle_id': 'h1', 'code': '482913'})
      ..on('GET /huddles/h1', (_) => huddleJson());
    final c = await openScreen(tester, s, Routes.world, const WorldArgs());
    await worldTo(tester, s);
    await tester.scrollUntilVisible(find.byKey(const ValueKey('no-counterparty')), 200, scrollable: find.byType(Scrollable).first);
    expect(find.text('No counterparty'), findsOneWidget);
    expect(tester.widget<PrimaryButton>(find.widgetWithText(PrimaryButton, 'Propose')).onPressed, isNull);
    expectCopyRule(tester, screen: 'World (no counterparty)');
    await tester.tap(find.text('Huddle'));
    await tester.pumpAndSettle();
    expect(find.byType(HuddleScreen), findsOneWidget);
    c.dispose();
  });
}
