import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:verdict/state/app_controller.dart';

import 'fake_server.dart';
import 'fixtures.dart';
import 'test_app.dart';

/// Signed-in backend: Ana (u1) by default, or Ben (u2).
FakeServer baseServer({bool asBen = false}) => FakeServer()
  ..on('GET /me', (_) => asBen
      ? userJson(id: 'u2', name: 'Ben', wallet: 'jX5drmcKNVNaeBTsLD4TZC183vsMpJqdALAz8a1BQG9')
      : userJson())
  ..on('GET /balance', (_) => {'usdc_units': 50000000})
  ..on('GET /bets', (_) => {'bets': []});

/// Signs in, pushes [route] and lets the first loads finish.
Future<AppController> openScreen(
  WidgetTester tester,
  FakeServer server,
  String route,
  Object? args, {
  Devices? devices,
  FakeFaceCapture? face,
}) async {
  final c = testController(server, token: 't', devices: devices, face: face);
  await pumpApp(tester, c);
  tester.state<NavigatorState>(find.byType(Navigator).first).pushNamed(route, arguments: args);
  await settle(tester);
  return c;
}

/// Pumps a few frames (for screens with running timers, where
/// pumpAndSettle would never settle).
Future<void> settle(WidgetTester tester, {int frames = 6}) async {
  for (var i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Taps inside runAsync so real-async work (ed25519 signing) completes.
Future<void> tapAsync(WidgetTester tester, Finder f, {int waitMs = 300}) async {
  await tester.runAsync(() async {
    await tester.tap(f);
    await Future<void>.delayed(Duration(milliseconds: waitMs));
  });
  await settle(tester);
}
