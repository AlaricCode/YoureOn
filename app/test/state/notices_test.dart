import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/api/models/bet.dart';
import 'package:verdict/ws/ws_messages.dart';

import '../support/fixtures.dart';
import '../support/screen_harness.dart';
import '../support/test_app.dart';

void _background(WidgetTester t) {
  t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  t.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
}

void _foreground(WidgetTester t) {
  t.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
  t.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
  t.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
}

void main() {
  testWidgets('notify: banner in the foreground, local notification in the background', (tester) async {
    final devices = Devices();
    final s = baseServer()..on('GET /bets/b7', (_) => betJson(id: 'b7', state: 'proposed', myIndex: 0));
    final c = testController(s, token: 't', devices: devices);
    await pumpApp(tester, c);

    expect(c.foreground, isTrue);
    c.injectWs(const WsNotify('Bet offered', null));
    await tester.pump();
    await tester.pump();
    expect(find.text('Bet offered'), findsOneWidget);
    expect(devices.notices.shown, isEmpty);
    await tester.pump(const Duration(seconds: 4));

    _background(tester);
    c.injectWs(const WsNotify('Ready', 'b7'));
    await tester.pump();
    expect(devices.notices.shown, ['Ready']);
    expect(find.text('Ready'), findsNothing);
    // The named bet is fetched and listed without a pull-to-refresh.
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    expect(c.bets.map((b) => b.id), contains('b7'));
    _foreground(tester);
    await tester.pump(const Duration(seconds: 4));
    c.dispose();
  });

  testWidgets('a pending consent schedules a local reminder before the deadline; consenting cancels it',
      (tester) async {
    final devices = Devices();
    final c = testController(baseServer(), token: 't', devices: devices);
    await pumpApp(tester, c);
    final deadline = DateTime.now().add(const Duration(minutes: 30));
    final bet = {
      ...betJson(id: 'b8', myIndex: 0),
      'preruling': {...(betJson()['preruling'] as Map), 'consent_deadline_ms': deadline.millisecondsSinceEpoch},
    };
    c.upsertBet(BetView.fromJson(bet));
    expect(devices.notices.scheduled.values.map((e) => e.$1), ['Consent due']);
    final at = devices.notices.scheduled.values.single.$2;
    expect(at.isBefore(deadline), isTrue);
    expect(deadline.difference(at).inSeconds, 120);

    // Same bet again: not rescheduled. Ana agrees: cancelled.
    c.upsertBet(BetView.fromJson({...bet, 'updated_at_ms': 1700000000001}));
    expect(devices.notices.scheduled, hasLength(1));
    final parts = [for (final p in bet['participants'] as List) Map<String, dynamic>.from(p as Map)];
    parts[0]['consent'] = 'agree';
    c.upsertBet(BetView.fromJson({...bet, 'participants': parts, 'updated_at_ms': 1700000000002}));
    expect(devices.notices.scheduled, isEmpty);
    expect(devices.notices.cancelled, hasLength(1));
    c.dispose();
  });

  testWidgets('on resume, bets are re-fetched and missed changes are shown', (tester) async {
    final devices = Devices();
    var bets = <Map<String, dynamic>>[];
    final s = baseServer()..on('GET /bets', (_) => {'bets': bets});
    final c = testController(s, token: 't', devices: devices);
    await pumpApp(tester, c);
    await tester.runAsync(c.refreshHome);
    _background(tester);
    // The socket was suspended: Ben offered a bet meanwhile.
    bets = [betJson(id: 'b9', state: 'proposed', myIndex: 1)];
    _foreground(tester);
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(c.bets.map((b) => b.id), ['b9']);
    expect(find.text('Bet offered'), findsOneWidget);
    await tester.pump(const Duration(seconds: 4));
    c.dispose();
  });
}
